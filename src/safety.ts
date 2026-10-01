import { describeTeamHazardUrgency } from "./tactics.ts";
import type { BattleSnapshot, Data, LegalAction, Pokemon } from "./types.ts";

const HAZARD_REMOVAL_MOVE_IDS = new Set([
  "courtchange",
  "defog",
  "mortalspin",
  "rapidspin",
  "tidyup",
]);

function currentHpPercent(data?: Data): number | null {
  const value = Number(data?.current_hp_percent);
  return Number.isFinite(value) ? value : null;
}

function maximumPercent(entry?: Data): number | null {
  const value = Number(entry?.estimated_damage_percent_range?.[1]);
  return Number.isFinite(value) ? value : null;
}

function minimumPercent(entry?: Data): number | null {
  const value = Number(entry?.estimated_damage_percent_range?.[0]);
  return Number.isFinite(value) ? value : null;
}

function actionCanGuaranteeKo(action: LegalAction, opponent?: Pokemon | null) {
  // Keep this in sync with Jev's KO annotations: the calculator does not
  // apply ability immunities, while the action matchup does.
  if (Number(action.description.type_effectiveness_multiplier) === 0) {
    return false;
  }
  const opponentHp = opponent?.condition?.split(" ")[0]?.split("/");
  const current = Number(opponentHp?.[0]);
  const maximum = Number(opponentHp?.[1]);
  const damage = action.description.baseline_damage;
  const minimumDamage = Number(damage?.estimated_damage_hp_range?.[0]);
  return Number.isFinite(current) && Number.isFinite(maximum) && maximum > 0 &&
    Number.isFinite(minimumDamage) && minimumDamage >= current;
}

function isGuaranteedRevealedKo(action: LegalAction) {
  const incoming = action.description.incoming_damage;
  const currentHp = currentHpPercent(incoming);
  if (currentHp === null) return false;
  return (incoming?.revealed_move_damage_estimates || []).some((entry) => {
    const minimum = minimumPercent(entry);
    return minimum !== null && minimum >= currentHp;
  });
}

function isGuaranteedRevealedPriorityKo(action: LegalAction) {
  const incoming = action.description.incoming_damage;
  const currentHp = currentHpPercent(incoming);
  if (currentHp === null) return false;
  const selectedPriority = Number(action.description.priority) || 0;
  return (incoming?.revealed_move_damage_estimates || []).some((entry) => {
    const minimum = minimumPercent(entry);
    const opponentPriority = Number(entry.priority) || 0;
    return opponentPriority > selectedPriority && minimum !== null &&
      minimum >= currentHp;
  });
}

function survivingSwitches(actions: LegalAction[]) {
  return actions.filter((action) => {
    if (action.kind !== "switch") return false;
    const incoming = action.description.incoming_damage;
    const currentHp = currentHpPercent(incoming);
    if (currentHp === null) return false;
    const entryLoss = Number(action.description.entry_hazard_hp_loss_percent) ||
      0;
    const hpAfterEntry = currentHp - entryLoss;
    if (hpAfterEntry <= 0) return false;
    return (incoming?.revealed_move_damage_estimates || []).every((entry) => {
      const maximum = maximumPercent(entry);
      return maximum === null || maximum < hpAfterEntry;
    });
  }).sort((left, right) => {
    const leftIncoming = left.description.incoming_damage;
    const rightIncoming = right.description.incoming_damage;
    const leftMaximum = Math.max(
      ...(leftIncoming?.revealed_move_damage_estimates || []).map(
        maximumPercent,
      ),
      0,
    );
    const rightMaximum = Math.max(
      ...(rightIncoming?.revealed_move_damage_estimates || []).map(
        maximumPercent,
      ),
      0,
    );
    const leftHazards = Number(left.description.entry_hazard_hp_loss_percent) ||
      0;
    const rightHazards =
      Number(right.description.entry_hazard_hp_loss_percent) || 0;
    return leftMaximum + leftHazards - rightMaximum - rightHazards;
  });
}

/**
 * Apply only clear tactical corrections after Jev has made its strategic
 * choice. The rules are intentionally narrow so ordinary predictions remain
 * under model control.
 */
export function chooseTacticalOverride(
  selected: LegalAction,
  actions: LegalAction[],
  battleState: BattleSnapshot,
  team: Pokemon[],
): { action: LegalAction; reason: Data } | null {
  const speed = selected.description.speed_comparison?.speed_order;
  const hasPriority = Number(selected.description.priority) > 0;
  if (
    selected.kind.startsWith("move") &&
    isGuaranteedRevealedPriorityKo(selected)
  ) {
    const replacement = survivingSwitches(actions)[0];
    if (replacement) {
      return {
        action: replacement,
        reason: {
          type: "revealed_priority_guaranteed_ko_escape",
          detail:
            "A revealed higher-priority move is guaranteed to KO before the selected move acts; switching preserves a surviving Pokémon.",
        },
      };
    }
  }
  if (
    selected.kind.startsWith("move") &&
    speed === "likely slower" &&
    !hasPriority &&
    // A non-priority move cannot use its KO before a faster opponent's
    // guaranteed KO; preserving the Pokémon is the only safe outcome.
    isGuaranteedRevealedKo(selected)
  ) {
    const replacement = survivingSwitches(actions)[0];
    if (replacement) {
      return {
        action: replacement,
        reason: {
          type: "revealed_guaranteed_ko_escape",
          detail:
            "A revealed move is guaranteed to KO before the selected move acts; switching preserves a surviving Pokémon.",
        },
      };
    }
  }

  const hazardUrgency = describeTeamHazardUrgency(team, battleState);
  const removal = actions.find((action) =>
    action.kind === "move" &&
    HAZARD_REMOVAL_MOVE_IDS.has(action.description.move_id)
  );
  if (
    hazardUrgency?.urgency === "high" &&
    removal &&
    selected.kind === "move" &&
    selected.id !== removal.id &&
    !actionCanGuaranteeKo(selected, battleState.opponentActive) &&
    !isGuaranteedRevealedKo(selected)
  ) {
    return {
      action: removal,
      reason: {
        type: "critical_hazard_removal",
        detail:
          "High team-level entry-hazard damage makes immediate hazard removal more valuable than non-lethal chip damage.",
        hazard_urgency: hazardUrgency,
      },
    };
  }
  return null;
}
