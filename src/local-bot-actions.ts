import Sim from "npm:pokemon-showdown@0.11.11";
import type {
  BattleRequest,
  BattleSnapshot,
  LegalAction,
  Pokemon,
} from "./types.ts";

import {
  describeMoveMatchup,
  describeMoveTactics,
  describeSpeedComparison,
  describeSwitchTactics,
  estimateBaselineDamage,
} from "./local-bot-tactics.ts";

const { Dex } = Sim;

function summarizePokemon(pokemon: Pokemon) {
  return {
    pokemon: pokemon.ident || pokemon.details,
    details: pokemon.details,
    condition: pokemon.condition,
    ability: pokemon.ability || pokemon.baseAbility,
    item: pokemon.item || "none or consumed",
    moves: pokemon.moves,
    tera_type: pokemon.teraType,
    terastallized: pokemon.terastallized,
    stats: pokemon.stats,
  };
}

export function generateLegalActions(
  request: BattleRequest,
  battleState: BattleSnapshot = {},
): LegalAction[] {
  if (!request || request.wait) return [];
  if (request.teamPreview) return generateTeamPreviewActions(request);
  if (request.forceSwitch?.[0]) {
    return generateSwitchActions(request, true, battleState);
  }
  return generateMoveActions(request, battleState);
}

function generateTeamPreviewActions(request: BattleRequest): LegalAction[] {
  return request.side.pokemon.map((pokemon, index) => ({
    id: `lead_${index + 1}`,
    command: `team ${index + 1}`,
    kind: "team-preview",
    description: {
      action: `Lead with team slot ${index + 1}`,
      ...summarizePokemon(pokemon),
    },
  }));
}

function generateSwitchActions(
  request: BattleRequest,
  forced: boolean,
  battleState: BattleSnapshot,
): LegalAction[] {
  return request.side.pokemon.flatMap((pokemon, index) => {
    if (
      pokemon.active || pokemon.commanding || pokemon.condition.endsWith(" fnt")
    ) return [];
    return [{
      id: `switch_${index + 1}`,
      command: `switch ${index + 1}`,
      kind: forced ? "forced-switch" : "switch",
      description: {
        action: `${forced ? "Forced switch" : "Switch"} to team slot ${
          index + 1
        }`,
        ...summarizePokemon(pokemon),
        ...describeSwitchTactics(pokemon, battleState),
      },
    }];
  });
}

function generateMoveActions(
  request: BattleRequest,
  battleState: BattleSnapshot,
): LegalAction[] {
  const active = request.active?.[0];
  if (!active) return [];
  const opponent = battleState.opponentActive;
  const ownActiveRequest = request.side.pokemon.find((pokemon) =>
    pokemon.active
  );
  const ownActive = {
    ...ownActiveRequest,
    ...battleState.ownSide?.active,
    ...ownActiveRequest,
  };
  const speedComparison = describeSpeedComparison(
    ownActive,
    opponent,
    battleState.field,
  );

  const actions = [];
  for (const [index, move] of active.moves.entries()) {
    if (move.disabled) continue;
    const moveData = Dex.moves.get(move.id);
    const base = {
      move: move.move,
      move_id: move.id,
      slot: index + 1,
      pp: move.pp,
      max_pp: move.maxpp,
      target: move.target,
      type: moveData.type,
      category: moveData.category,
      base_power: moveData.basePower,
      accuracy: moveData.accuracy,
      priority: moveData.priority,
      effect: moveData.shortDesc,
      ...describeTypeMatchup(
        moveData.type,
        opponent,
        ownActive?.ability || ownActive?.baseAbility,
      ),
      speed_comparison: speedComparison,
      ...describeMoveTactics(moveData, ownActive, opponent, battleState),
      baseline_damage: estimateBaselineDamage(
        moveData,
        ownActive,
        opponent,
        battleState,
      ),
    };
    actions.push({
      id: `move_${index + 1}`,
      command: `move ${index + 1}`,
      kind: "move",
      description: { action: `Use ${move.move}`, ...base },
    });

    if (active.canTerastallize) {
      const teraAttacker = {
        ...ownActive,
        teraType: active.canTerastallize,
        terastallized: true,
      };
      actions.push({
        id: `move_${index + 1}_tera`,
        command: `move ${index + 1} terastallize`,
        kind: "move-terastallize",
        description: {
          action:
            `Terastallize into ${active.canTerastallize}, then use ${move.move}`,
          tera_type: active.canTerastallize,
          ...base,
          baseline_damage: estimateBaselineDamage(
            moveData,
            teraAttacker,
            opponent,
            battleState,
          ),
        },
      });
    }
  }

  if (!active.trapped) {
    actions.push(...generateSwitchActions(request, false, battleState));
  }
  return actions;
}

function describeTypeMatchup(
  moveType: string,
  opponent: Pokemon | null | undefined,
  attackerAbility?: string,
) {
  const speciesName = opponent?.details?.split(",")[0];
  if (!speciesName) return {};
  const species = Dex.species.get(speciesName);
  if (!species.exists) return {};
  const matchup = describeMoveMatchup(moveType, opponent, attackerAbility);
  const { target_types: targetTypes, ...matchupDetails } = matchup;
  return {
    opponent_species: species.name,
    opponent_types: targetTypes,
    ...matchupDetails,
  };
}
