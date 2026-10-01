import { generateLegalActions } from "./actions.ts";
import { DecisionModel as FallbackDecisionModel } from "./decision.ts";
import { addGen9RandomBattleInference } from "./randbats.ts";
import { chooseTacticalOverride } from "./safety.ts";
import { BattleStateTracker } from "./state.ts";
import {
  describeMoveMatchup,
  describeOpponentHazardThreats,
  describeOpponentProtectOpportunity,
  describeTeamHazardUrgency,
} from "./tactics.ts";
import type {
  BattleSnapshot,
  Data,
  DecisionContext,
  DecisionRecorder,
  DecisionResult,
  LegalAction,
  Pokemon,
} from "./types.ts";
import Sim from "npm:pokemon-showdown@0.11.11";

const DEFAULT_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
const DEFAULT_MODEL = "typesafe/jev-1.13";
const { Dex } = Sim;
const SHARED_MOVE_TACTIC_KEYS = [
  "opponent_threats",
  "incoming_damage",
  "tactical_warnings",
];
const CONDITIONAL_PRIORITY_MOVE_IDS = new Set([
  "firstimpression",
  "grassyglide",
  "suckerpunch",
  "thunderclap",
  "upperhand",
]);

function summarizePokemon(pokemon: Pokemon, index: number): Data {
  return {
    slot: index + 1,
    pokemon: pokemon.ident || pokemon.details,
    details: pokemon.details,
    condition: pokemon.condition,
    active: pokemon.active,
    ability: pokemon.ability || pokemon.baseAbility,
    item: pokemon.item || "none or consumed",
    moves: pokemon.moves,
    tera_type: pokemon.teraType,
    terastallized: pokemon.terastallized,
    stats: pokemon.stats,
  };
}

function summarizeOwnSide(publicState?: Data | null): Data {
  return {
    active: publicState?.active || null,
    conditions: publicState?.conditions || [],
    terastallized: publicState?.terastallized || false,
    remaining_pokemon: publicState?.remainingPokemon,
    fainted_pokemon: publicState?.faintedPokemon,
  };
}

function summarizeOpponentSide(publicState?: Data | null): Data | null {
  if (!publicState) return null;
  return {
    ...publicState,
    team: addGen9RandomBattleInference(publicState.team),
  };
}

function formatPercentRange(range?: [number, number]): string | null {
  return range ? `${range[0]}-${range[1]}%` : null;
}

function sharedMoveTactics(actions: LegalAction[]): Data | undefined {
  const move = actions.find((action) => action.kind === "move");
  if (!move) return undefined;
  const tactics = Object.fromEntries(
    SHARED_MOVE_TACTIC_KEYS.flatMap((key) =>
      move.description[key] === undefined ? [] : [[key, move.description[key]]]
    ),
  );
  return Object.keys(tactics).length ? tactics : undefined;
}

function hpFromCondition(condition?: string): [number, number] | null {
  const match = condition?.match(/^(\d+)\/(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2])];
}

function actionGuaranteesKo(
  action: LegalAction,
  opponent?: Pokemon | null,
): boolean {
  // @smogon/calc reports raw move damage and does not apply ability
  // immunities. The matchup layer is the authority when it says a move has
  // no effect (including a Random Battle ability that is certain by
  // inference), so such a move can never be a KO.
  if (Number(action.description.type_effectiveness_multiplier) === 0) {
    return false;
  }
  const hp = hpFromCondition(opponent?.condition);
  const minimumDamage = Number(
    action.description.baseline_damage?.estimated_damage_hp_range?.[0],
  );
  return !!hp && Number.isFinite(minimumDamage) && minimumDamage >= hp[0];
}

function maximumRevealedDamage(action: LegalAction): number | null {
  const estimates = action.description.incoming_damage
    ?.revealed_move_damage_estimates || [];
  const values = estimates
    .map((entry) => Number(entry.estimated_damage_percent_range?.[1]))
    .filter(Number.isFinite);
  return values.length ? Math.max(...values) : null;
}

/**
 * Give the model a compact comparison when attacking is unlikely to remove the
 * opponent and there is a credible safer pivot. The detailed switch actions
 * remain the source of truth; this only makes that comparison hard to miss.
 */
function safePivotComparison(
  actions: LegalAction[],
  opponent?: Pokemon | null,
): Data | undefined {
  const moves = actions.filter((action) => action.kind.startsWith("move"));
  if (
    !moves.length ||
    moves.some((action) => actionGuaranteesKo(action, opponent))
  ) {
    return undefined;
  }
  const reference = moves[0];
  const incoming = reference.description.incoming_damage;
  const currentHp = incoming?.current_hp_percent === undefined
    ? null
    : Number(incoming.current_hp_percent);
  const speed = reference.description.speed_comparison?.speed_order;
  const knownKoMoves = incoming?.revealed_moves_that_can_ko || [];
  const knownSuperEffective = reference.description.opponent_threats
    ?.known_super_effective_moves || [];
  const reasons = [
    ...(speed === "likely slower" ? ["active is likely slower"] : []),
    ...(currentHp !== null && Number.isFinite(currentHp) && currentHp <= 40
      ? [`active is at ${currentHp}% HP`]
      : []),
    ...(knownKoMoves.length
      ? [`revealed KO threat: ${knownKoMoves.join(", ")}`]
      : []),
    ...(knownSuperEffective.length
      ? [`revealed super-effective threat: ${knownSuperEffective.join(", ")}`]
      : []),
  ];
  if (!reasons.length) return undefined;

  const pivots: Data[] = actions.flatMap((action) => {
    if (action.kind !== "switch") return [];
    const pivotHp = Number(
      action.description.incoming_damage?.current_hp_percent,
    );
    if (!Number.isFinite(pivotHp)) return [];
    const entryHazards =
      Number(action.description.entry_hazard_hp_loss_percent) || 0;
    const hpAfterEntry = pivotHp - entryHazards;
    const maximumIncoming = maximumRevealedDamage(action);
    if (
      hpAfterEntry <= 0 ||
      (maximumIncoming !== null && maximumIncoming >= hpAfterEntry)
    ) {
      return [];
    }
    return [{
      id: action.id,
      action: action.description.action,
      hp_after_entry_percent: Math.round(hpAfterEntry * 10) / 10,
      entry_hazard_hp_loss_percent: entryHazards,
      maximum_revealed_damage_percent: maximumIncoming,
    }];
  }).sort((left, right) =>
    (Number(left.maximum_revealed_damage_percent) || 0) +
    Number(left.entry_hazard_hp_loss_percent) -
    ((Number(right.maximum_revealed_damage_percent) || 0) +
      Number(right.entry_hazard_hp_loss_percent))
  );
  if (!pivots.length) return undefined;
  return {
    instruction:
      "No legal attack guarantees a KO. Compare these pivots before sacrificing the active Pokémon.",
    reasons,
    safe_against_revealed_moves: pivots.slice(0, 3),
    caveat:
      "Unknown coverage and opponent switching remain possible; inspect each legal switch before deciding.",
  };
}

function priorityFinishingOptions(
  actions: LegalAction[],
  opponent?: Pokemon | null,
): Data[] {
  return actions.flatMap((action) => {
    if (
      !action.kind.startsWith("move") ||
      Number(action.description.priority) <= 0 ||
      CONDITIONAL_PRIORITY_MOVE_IDS.has(action.description.move_id) ||
      !actionGuaranteesKo(action, opponent)
    ) return [];
    return [{
      id: action.id,
      action: action.description.action,
      priority: action.description.priority,
      detail:
        "Minimum damage guarantees the KO. This priority move acts before normal-priority attacks.",
    }];
  });
}

function teraFinishingOptions(
  actions: LegalAction[],
  opponent?: Pokemon | null,
): Data[] {
  const standardMoves = new Map(
    actions.filter((action) => action.kind === "move").map((action) => [
      action.description.slot,
      action,
    ]),
  );
  return actions.flatMap((action) => {
    const standard = standardMoves.get(action.description.slot);
    if (
      action.kind !== "move-terastallize" ||
      !actionGuaranteesKo(action, opponent) ||
      (standard && actionGuaranteesKo(standard, opponent))
    ) return [];
    return [{
      id: action.id,
      action: action.description.action,
      detail:
        "Terastallizing changes this otherwise non-lethal move into a guaranteed KO by minimum damage.",
    }];
  });
}

function accuracyPercent(action: LegalAction): number | null {
  const accuracy = action.description.accuracy;
  if (accuracy === true) return 100;
  const percent = Number(accuracy);
  return Number.isFinite(percent) ? percent : null;
}

function accurateKoAlternatives(
  actions: LegalAction[],
  opponent?: Pokemon | null,
): Data[] {
  const moveActions = actions.filter((action) =>
    action.kind === "move" || action.kind === "move-terastallize"
  );
  return moveActions.flatMap((risky) => {
    const riskyAccuracy = accuracyPercent(risky);
    if (
      riskyAccuracy === null || riskyAccuracy >= 100 ||
      !actionGuaranteesKo(risky, opponent)
    ) return [];
    const reliable = moveActions.filter((candidate) =>
      candidate.kind === risky.kind &&
      Number(candidate.description.priority) >=
        Number(risky.description.priority) &&
      accuracyPercent(candidate) === 100 &&
      actionGuaranteesKo(candidate, opponent)
    );
    if (!reliable.length) return [];
    return [{
      risky_action: {
        id: risky.id,
        action: risky.description.action,
        accuracy_percent: riskyAccuracy,
      },
      reliable_ko_options: reliable.map((candidate) => ({
        id: candidate.id,
        action: candidate.description.action,
        accuracy_percent: 100,
      })),
      detail:
        "These moves all guarantee the KO by minimum damage and act at least as early; prefer the accurate option unless it has a separate strategic cost.",
    }];
  });
}

function defensiveTeraLosses(
  teraType: string,
  active?: Pokemon,
  opponent?: Pokemon | null,
): string[] {
  if (!active) return [];
  const teraActive = { ...active, teraType, terastallized: true };
  const ability = active.ability || active.baseAbility || null;
  return (opponent?.revealedMoves || opponent?.revealed_moves || []).flatMap(
    (moveName) => {
      const move = Dex.moves.get(String(moveName));
      if (!move.exists || move.category === "Status") return [];
      const before = Number(
        describeMoveMatchup(move.type, active, ability)
          .type_effectiveness_multiplier,
      );
      const after = Number(
        describeMoveMatchup(move.type, teraActive, ability)
          .type_effectiveness_multiplier,
      );
      if (
        !Number.isFinite(before) || !Number.isFinite(after) || before >= 1 ||
        after <= before
      ) {
        return [];
      }
      return [`${move.name}: ${before}x → ${after}x`];
    },
  );
}

function teraWarnings(
  actions: LegalAction[],
  active?: Pokemon,
  opponent?: Pokemon | null,
): Data[] {
  const standardMoves = new Map(
    actions.filter((action) => action.kind === "move").map((action) => [
      action.description.slot,
      action,
    ]),
  );
  return actions.flatMap((action) => {
    if (action.kind !== "move-terastallize") return [];
    const warnings = [];
    const standard = standardMoves.get(action.description.slot);
    if (standard && actionGuaranteesKo(standard, opponent)) {
      warnings.push(
        `${standard.description.action} already guarantees the KO without Terastallizing.`,
      );
    }
    warnings.push(
      ...defensiveTeraLosses(
        String(action.description.tera_type || ""),
        active,
        opponent,
      ),
    );
    return warnings.length
      ? [{ id: action.id, action: action.description.action, warnings }]
      : [];
  });
}

function setupOptions(actions: LegalAction[]): Data[] {
  return actions.flatMap((action) => {
    if (!action.kind.startsWith("move")) return [];
    const move = Dex.moves.get(String(action.description.move_id));
    if (!move.exists || move.category !== "Status") return [];
    const boosts = { ...move.boosts, ...move.self?.boosts };
    const positiveBoosts = Object.fromEntries(
      Object.entries(boosts).filter(([, amount]) => Number(amount) > 0),
    );
    if (!Object.keys(positiveBoosts).length) {
      return [];
    }
    return [{
      id: action.id,
      action: action.description.action,
      boosts: positiveBoosts,
    }];
  });
}

const ANTI_SETUP_MOVE_IDS = new Set([
  "haze",
  "clearsmog",
  "spectralthief",
  "topsyturvy",
]);

function antiSetupOptions(
  actions: LegalAction[],
  opponent?: Pokemon | null,
): Data | undefined {
  const boosts = Object.entries(opponent?.boosts || {})
    .filter(([, amount]) => Number(amount) > 0)
    .map(([stat, amount]) => `${stat} +${amount}`);
  if (!boosts.length) return undefined;
  const moves = actions.flatMap((action) => {
    if (action.kind !== "move") return [];
    const move = Dex.moves.get(String(action.description.move_id));
    if (!move.exists) return [];
    let detail: string | undefined;
    if (ANTI_SETUP_MOVE_IDS.has(move.id)) {
      detail = move.id === "spectralthief"
        ? "Steals the opponent's stat boosts before dealing damage."
        : "Removes or reverses the opponent's stat boosts.";
    } else if (move.forceSwitch) {
      detail = "Phazes the boosted opponent if it hits.";
    }
    return detail
      ? [{ id: action.id, action: action.description.action, detail }]
      : [];
  });
  const unawareSwitches = actions.filter((action) =>
    action.kind === "switch" &&
    String(action.description.ability || action.description.baseAbility)
        .toLowerCase().replace(/[^a-z0-9]/g, "") === "unaware"
  ).map((action) => ({
    id: action.id,
    action: action.description.action,
    detail: "Unaware ignores the opponent's offensive stat boosts.",
  }));
  if (!moves.length && !unawareSwitches.length) return undefined;
  return {
    opponent_positive_boosts: boosts,
    instruction:
      "The opponent is boosted. Compare these direct answers before trading damage into a potential sweep.",
    ...(moves.length ? { moves } : {}),
    ...(unawareSwitches.length ? { unaware_switches: unawareSwitches } : {}),
  };
}

function safeRecoveryOptions(
  actions: LegalAction[],
  opponent?: Pokemon | null,
): Data[] {
  const damaging = actions.filter((action) => action.kind.startsWith("move"));
  if (damaging.some((action) => actionGuaranteesKo(action, opponent))) {
    return [];
  }
  const reference = damaging[0];
  if (!reference) return [];
  const currentHp = Number(
    reference?.description.incoming_damage?.current_hp_percent,
  );
  const revealedDamage = maximumRevealedDamage(reference);
  if (
    !Number.isFinite(currentHp) || revealedDamage === null
  ) return [];
  return actions.flatMap((action) => {
    if (action.kind !== "move") return [];
    const move = Dex.moves.get(String(action.description.move_id));
    if (!move.exists) return [];
    const halfRecovery = Array.isArray(move.heal) && move.heal[0] === 1 &&
      move.heal[1] === 2;
    const rest = move.id === "rest";
    if (!halfRecovery && !rest) return [];
    const hpAfterRecovery = rest ? 100 : Math.min(100, currentHp + 50);
    if (hpAfterRecovery <= revealedDamage) return [];
    return [{
      id: action.id,
      action: action.description.action,
      hp_after_recovery_percent: Math.round(hpAfterRecovery * 10) / 10,
      maximum_revealed_follow_up_damage_percent: revealedDamage,
      detail: rest
        ? "Rest leaves the active able to survive every revealed damaging move next turn, but puts it to sleep; no legal attack currently guarantees a KO."
        : "This recovery move leaves the active able to survive every revealed damaging move next turn; no legal attack currently guarantees a KO.",
    }];
  });
}

function protectResponseOptions(
  actions: LegalAction[],
  opponent: Pokemon | null | undefined,
  battleState: BattleSnapshot,
  pivotComparison?: Data,
): Data | undefined {
  const protect = describeOpponentProtectOpportunity(opponent, battleState);
  if (!protect) return undefined;
  const setup = setupOptions(actions);
  return {
    ...protect,
    instruction:
      "Compare setup or a useful pivot before attacking into a possible repeated Protect; attacking can still be right when it covers another line.",
    ...(setup.length ? { setup_options: setup } : {}),
    ...(pivotComparison
      ? { safe_pivots: pivotComparison.safe_against_revealed_moves }
      : {}),
  };
}

function hazardResponseOptions(
  actions: LegalAction[],
  opponent: Pokemon | null | undefined,
  battleState: BattleSnapshot,
): Data | undefined {
  const hazardThreats = describeOpponentHazardThreats(opponent);
  const taunt = actions.find((action) =>
    action.kind.startsWith("move") && action.description.move_id === "taunt"
  );
  const toxicSpikesActive = (battleState.ownSide?.conditions || []).some(
    (condition) => condition.id === "toxicspikes",
  );
  const absorbers = toxicSpikesActive
    ? actions.filter((action) =>
      action.kind === "switch" &&
      (action.description.entry_hazard_effects || []).some((effect) =>
        String(effect).includes("Toxic Spikes: absorbs the hazard")
      )
    ).map((action) => ({
      id: action.id,
      action: action.description.action,
      entry_hazard_hp_loss_percent:
        action.description.entry_hazard_hp_loss_percent,
    }))
    : [];
  if ((!hazardThreats || !taunt) && !absorbers.length) return undefined;
  return {
    instruction:
      "Hazards have long-term team costs. Consider denying a likely setter with Taunt or using and preserving a Toxic Spikes absorber; do not assume inferred moves are confirmed.",
    ...(hazardThreats && taunt
      ? {
        taunt_option: { id: taunt.id, action: taunt.description.action },
        opponent_hazard_threats: hazardThreats,
      }
      : {}),
    ...(absorbers.length ? { toxic_spikes_absorbers: absorbers } : {}),
  };
}

function summarizeAction(action: LegalAction): Data {
  const description = { ...action.description };
  if (action.kind === "move" || action.kind === "move-terastallize") {
    for (const key of SHARED_MOVE_TACTIC_KEYS) delete description[key];
  }
  return { id: action.id, command: action.command, ...description };
}

function payloadBytes(payload: Data): number {
  return new TextEncoder().encode(JSON.stringify(payload)).byteLength;
}

/** Format a decision for console output. */
export function formatDecisionSummary(
  action: Pick<LegalAction, "id" | "description">,
): string {
  const description = action.description || {};
  const details = [];
  const damage = formatPercentRange(
    description.baseline_damage?.estimated_damage_percent_range,
  );
  if (damage) details.push(`damage ${damage}`);
  else if (description.type_matchup) details.push(description.type_matchup);
  if (description.speed_comparison?.speed_order) {
    details.push(description.speed_comparison.speed_order);
  }
  if (typeof description.entry_hazard_hp_loss_percent === "number") {
    details.push(`entry hazards ${description.entry_hazard_hp_loss_percent}%`);
  }
  const revealedIncoming = description.incoming_damage
    ?.revealed_move_damage_estimates?.[0];
  const incomingDamage = formatPercentRange(
    revealedIncoming?.estimated_damage_percent_range,
  );
  if (revealedIncoming && incomingDamage) {
    details.push(`revealed ${revealedIncoming.move} ${incomingDamage}`);
  }
  return [description.action || action.id, ...details].join("; ");
}

export function buildJevRequest(
  context: DecisionContext,
  actions: LegalAction[],
  model = DEFAULT_MODEL,
  snapshot: BattleSnapshot = {},
): Data {
  const { request, roomid, turn } = context;
  const active = request.active?.[0];
  const { ownSide = null, opponentSide = null, field, recentEvents = [] } =
    snapshot;
  const activeTactics = sharedMoveTactics(actions);
  const pivotComparison = safePivotComparison(actions, opponentSide?.active);
  const priorityFinishers = priorityFinishingOptions(
    actions,
    opponentSide?.active,
  );
  const teraFinishers = teraFinishingOptions(actions, opponentSide?.active);
  const accurateKos = accurateKoAlternatives(actions, opponentSide?.active);
  const ownActive = request.side.pokemon.find((pokemon) => pokemon.active);
  const teraActionWarnings = teraWarnings(
    actions,
    ownActive,
    opponentSide?.active,
  );
  const protectResponses = protectResponseOptions(
    actions,
    opponentSide?.active,
    snapshot,
    pivotComparison,
  );
  const hazardResponses = hazardResponseOptions(
    actions,
    opponentSide?.active,
    snapshot,
  );
  const antiSetupResponses = antiSetupOptions(actions, opponentSide?.active);
  const safeRecoveries = safeRecoveryOptions(actions, opponentSide?.active);
  const teamHazardUrgency = describeTeamHazardUrgency(
    request.side.pokemon,
    snapshot,
  );
  return {
    model,
    session_id: roomid,
    state: {
      battle: {
        format: "Generation 9 Random Battle, singles",
        turn: snapshot.turn || turn,
        objective:
          "Win the battle by choosing one legal action for the current turn.",
      },
      own_side: {
        team: request.side.pokemon.map(summarizePokemon),
        ...summarizeOwnSide(ownSide),
      },
      opponent_side: summarizeOpponentSide(opponentSide),
      field: field || { weather: null, terrain: null, pseudoWeather: [] },
      current_active_request: active
        ? {
          trapped: !!active.trapped,
          maybe_trapped: !!active.maybeTrapped,
          can_terastallize_into: active.canTerastallize,
          moves: active.moves,
          ...((activeTactics || teamHazardUrgency || pivotComparison ||
              priorityFinishers.length || teraActionWarnings.length ||
              protectResponses || accurateKos.length || hazardResponses ||
              teraFinishers.length || antiSetupResponses ||
              safeRecoveries.length)
            ? {
              tactics: {
                ...activeTactics,
                ...(teamHazardUrgency
                  ? { team_hazard_urgency: teamHazardUrgency }
                  : {}),
                ...(pivotComparison
                  ? { safe_pivot_comparison: pivotComparison }
                  : {}),
                ...(priorityFinishers.length
                  ? { priority_finishing_options: priorityFinishers }
                  : {}),
                ...(teraFinishers.length
                  ? { tera_finishing_options: teraFinishers }
                  : {}),
                ...(teraActionWarnings.length
                  ? { tera_warnings: teraActionWarnings }
                  : {}),
                ...(protectResponses
                  ? { protect_response_options: protectResponses }
                  : {}),
                ...(accurateKos.length
                  ? { accurate_ko_alternatives: accurateKos }
                  : {}),
                ...(hazardResponses
                  ? { hazard_response_options: hazardResponses }
                  : {}),
                ...(antiSetupResponses
                  ? { anti_setup_options: antiSetupResponses }
                  : {}),
                ...(safeRecoveries.length
                  ? { safe_recovery_options: safeRecoveries }
                  : {}),
              },
            }
            : {}),
        }
        : undefined,
      recent_public_battle_events: recentEvents,
      legal_actions: actions.map(summarizeAction),
    },
    questions: {
      action: {
        type: "choice",
        instructions: {
          question: "Which option is the best legal action for this turn?",
          inspect: [
            "`own_side`",
            "`opponent_side`",
            "`field`",
            "`current_active_request`",
            "`recent_public_battle_events`",
            "`legal_actions`",
          ],
          priorities: [
            "Prefer actions that improve the probability of winning the whole battle, not merely this turn.",
            "Account for type matchups, damage, speed, status, setup, hazards, recovery, switching, and observed information.",
            "When `safe_pivot_comparison` is present, do not sacrifice the active to a non-lethal attack without comparing those pivots.",
            "When `safe_pivot_comparison` says the active is likely slower and a listed pivot survives every revealed attack, default to that pivot unless you can name a concrete winning reason to stay in.",
            "When `observed_revealed_move_damage` is present, treat its prior hits on this same active Pokémon as a concrete warning about hidden items or stat spreads; it is advisory, not proof that the next roll is guaranteed.",
            "Never select a damaging action whose `type_matchup` says it has no effect.",
            "Never select an action with `conditional_action_warning` when the warning says it will fail. Treat its Sucker Punch warning as a risk to compare, not proof that it fails.",
            "When `priority_finishing_options` is present, prefer one of those guaranteed KOs over a slower attack unless a higher-priority response is a known concern.",
            "Treat `tera_warnings` as a reason to preserve Tera and defensive typing unless Tera has a separate strategic benefit.",
            "When `tera_finishing_options` is present, prefer its guaranteed KO unless preserving Tera has a concrete, higher-value purpose.",
            "When `protect_response_options` is present, seriously compare its setup or pivot options before attacking into a possible repeated Protect.",
            "When `accurate_ko_alternatives` is present, prefer its 100%-accurate KO over the listed inaccurate KO unless there is a separate strategic cost.",
            "When `hazard_response_options` is present, value Taunt against likely hazard setup and preserve a listed Toxic Spikes absorber, while treating inferred moves as uncertain.",
            "When `anti_setup_options` is present, compare its Haze, phazing, boost-theft, or Unaware answers before letting a boosted opponent attack again.",
            "When `safe_recovery_options` is present, prefer it over non-lethal chip unless the immediate board state gives a concrete reason not to heal.",
            "Treat `randomBattleSet` fields as possibilities rather than confirmed opponent facts.",
            "Conserve Terastallization unless its expected strategic value justifies using it now.",
          ],
        },
        criteria: Object.fromEntries(
          // `legal_actions` already contains the full tactical evidence. Keeping
          // a second copy here made large battles exceed the decision endpoint's
          // input limit, especially with Tera variants and several switch-ins.
          actions.map((action) => [action.id, action.description.action]),
        ),
      },
    },
  };
}

export class JevDecisionModel {
  apiKey: string;
  endpoint: string;
  model: string;
  timeoutMs: number;
  fetch: typeof fetch;
  fallback: FallbackDecisionModel;
  tracker: BattleStateTracker;
  recorder: DecisionRecorder | null;
  debug: boolean;
  logDecisions: boolean;
  constructor({
    apiKey = Deno.env.get("OPENROUTER_API_KEY"),
    endpoint = Deno.env.get("JEV_ENDPOINT") || DEFAULT_ENDPOINT,
    model = Deno.env.get("JEV_MODEL") || DEFAULT_MODEL,
    timeoutMs = Number(Deno.env.get("JEV_TIMEOUT_MS")) || 5000,
    fetchImpl = globalThis.fetch,
    fallback = new FallbackDecisionModel(),
    tracker = new BattleStateTracker(),
    recorder = null,
    debug = Deno.env.get("JEV_DEBUG") === "1",
    logDecisions = true,
  }: {
    apiKey?: string;
    endpoint?: string;
    model?: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    fallback?: FallbackDecisionModel;
    tracker?: BattleStateTracker;
    recorder?: DecisionRecorder | null;
    debug?: boolean;
    logDecisions?: boolean;
  } = {}) {
    if (!apiKey) throw new Error("OPENROUTER_API_KEY is required to use Jev.");
    this.apiKey = apiKey;
    this.endpoint = endpoint;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    this.fallback = fallback;
    this.tracker = tracker;
    this.recorder = recorder;
    this.debug = debug;
    this.logDecisions = logDecisions;
  }

  observe(roomid: string, line: string): void {
    this.tracker.observe(roomid, line);
  }

  clear(roomid: string): void {
    this.tracker.clear(roomid);
  }

  async choose(context: DecisionContext): Promise<string | null> {
    const snapshot = this.tracker.getSnapshot(
      context.roomid,
      context.request.side.id,
    );
    const actions = generateLegalActions(context.request, snapshot);
    if (!actions.length) return null;
    const payload = buildJevRequest(context, actions, this.model, snapshot);
    const requestMetrics = {
      request_payload_bytes: payloadBytes(payload),
    };
    if (actions.length === 1) {
      this.recordDecision(context, payload, actions[0], {
        source: "single_legal_action",
        ...requestMetrics,
      });
      return actions[0].command;
    }

    if (this.debug) {
      console.log("[jev] request:", JSON.stringify(payload, null, 2));
    }

    const started = Date.now();
    try {
      const response = await this.fetch(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(
          result.error?.message ||
            `OpenRouter returned HTTP ${response.status}`,
        );
      }

      const answer = result.answers?.action;
      const modelSelected = actions.find((action) =>
        action.id === answer?.choice
      );
      if (!modelSelected) {
        throw new Error(
          `Jev returned unknown action ${JSON.stringify(answer?.choice)}`,
        );
      }
      const override = chooseTacticalOverride(
        modelSelected,
        actions,
        snapshot,
        context.request.side.pokemon,
      );
      const selected = override?.action || modelSelected;

      const elapsed = Date.now() - started;
      const confidence = typeof answer.confidence === "number"
        ? answer.confidence.toFixed(3)
        : "unknown";
      const cost = typeof result.usage?.cost === "number"
        ? `$${result.usage.cost.toFixed(8)}`
        : "unknown cost";
      if (this.logDecisions) {
        console.log(
          `[jev] ${context.roomid} turn ${context.turn}: ${selected.id} — ${
            formatDecisionSummary(selected)
          } ` +
            `(${confidence} confidence, ${elapsed}ms, ${cost})`,
        );
        if (override) {
          console.log(
            `[jev] tactical override: ${modelSelected.id} -> ${selected.id} (${override.reason.type})`,
          );
        }
      }
      this.recordDecision(context, payload, selected, {
        source: "jev",
        answer,
        ...(override
          ? {
            tactical_override: {
              model_selected_action: modelSelected.id,
              selected_action: selected.id,
              ...override.reason,
            },
          }
          : {}),
        usage: result.usage,
        elapsed_ms: elapsed,
        ...requestMetrics,
      });
      if (this.debug) {
        console.log("[jev] answer:", JSON.stringify(answer, null, 2));
      }
      return selected.command;
    } catch (error) {
      const fallback = this.fallback.choose(context);
      console.error(
        `[jev] ${error.message}; falling back to ${fallback || "no action"}.`,
      );
      const selected = actions.find((action) => action.command === fallback) ||
        null;
      this.recordDecision(context, payload, selected, {
        source: "fallback",
        error: error.message,
        ...requestMetrics,
      });
      return fallback;
    }
  }

  recordDecision(
    context: DecisionContext,
    payload: Data,
    selected: LegalAction | null,
    result: DecisionResult,
  ): void {
    this.recorder?.record(context.roomid, "decision", {
      turn: context.turn,
      state: payload.state,
      selected_action: selected
        ? { id: selected.id, command: selected.command }
        : null,
      result,
    });
  }
}
