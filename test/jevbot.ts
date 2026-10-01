import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert";

import { generateLegalActions } from "../src/actions.ts";
import {
  buildJevRequest,
  formatDecisionSummary,
  JevDecisionModel,
} from "../src/jev.ts";
import { formatBattleEvent, formatOpponentChat } from "../src/battle-log.ts";
import { getLoginAssertion, redactProtocolMessage } from "../src/login.ts";
import {
  addGen9RandomBattleInference,
  inferGen9RandomBattleSet,
} from "../src/randbats.ts";
import { BattleRecorder } from "../src/recorder.ts";
import { BattleStateTracker } from "../src/state.ts";
import {
  describeEntryHazards,
  describeIncomingDamage,
  describeOpponentThreats,
  describeTeamHazardUrgency,
  estimateBaselineDamage,
} from "../src/tactics.ts";
import { chooseTacticalOverride } from "../src/safety.ts";
import { LadderScore, parseGameLimit } from "../tools/ladder.ts";
import {
  compactBattleLog,
  parseAuditOptions,
  reviewPrompt,
} from "../tools/audit.ts";

const request = {
  rqid: 7,
  active: [{
    moves: [
      {
        move: "Earthquake",
        id: "earthquake",
        pp: 16,
        maxpp: 16,
        target: "allAdjacent",
        disabled: false,
      },
      {
        move: "Dragon Claw",
        id: "dragonclaw",
        pp: 24,
        maxpp: 24,
        target: "normal",
        disabled: false,
      },
      {
        move: "Fire Fang",
        id: "firefang",
        pp: 24,
        maxpp: 24,
        target: "normal",
        disabled: true,
      },
    ],
    trapped: false,
    canTerastallize: "Ground",
  }],
  side: {
    name: "JevBot",
    id: "p1",
    pokemon: [
      {
        ident: "p1: Garchomp",
        details: "Garchomp, L80, M",
        condition: "300/300",
        active: true,
        stats: { atk: 300, def: 200, spa: 150, spd: 180, spe: 250 },
        moves: ["earthquake", "dragonclaw", "firefang"],
        baseAbility: "roughskin",
        ability: "roughskin",
        item: "lifeorb",
        teraType: "Ground",
      },
      {
        ident: "p1: Rotom-Wash",
        details: "Rotom-Wash, L82",
        condition: "240/240",
        active: false,
        stats: { atk: 100, def: 220, spa: 240, spd: 220, spe: 190 },
        moves: ["hydropump", "voltswitch"],
        baseAbility: "levitate",
        ability: "levitate",
        item: "leftovers",
        teraType: "Steel",
      },
      {
        ident: "p1: Fainted",
        details: "Pikachu, L88",
        condition: "0 fnt",
        active: false,
        stats: {},
        moves: ["thunderbolt"],
        baseAbility: "static",
        item: "",
        teraType: "Electric",
      },
    ],
  },
};

assertEquals(parseGameLimit([]), 1);
assertEquals(parseGameLimit(["--live"]), 1);
assertEquals(parseGameLimit(["--games", "3"]), 3);
assertEquals(parseGameLimit(["--games=4"]), 4);
assertRejects(
  async () => parseGameLimit(["--games", "0"]),
  Error,
  "positive integer",
);
const ladderScore = new LadderScore("JevBot", 3);
ladderScore.record("JevBot");
ladderScore.record("Opponent");
ladderScore.record(null);
assertEquals(ladderScore.complete, true);
assertEquals(ladderScore.summary(), {
  target_games: 3,
  completed_games: 3,
  wins: 1,
  losses: 1,
  ties: 1,
});
assertEquals(ladderScore.display(), "3/3 — 1W-1L-1T");
assertThrows(
  () => parseAuditOptions([]),
  Error,
  "--run PATH or --latest is required",
);
assertEquals(
  parseAuditOptions(["--run", "logs/jevbot/run-test"]).runDirectory,
  "logs/jevbot/run-test",
);
assertEquals(
  parseAuditOptions(["--run=logs/jevbot/run-test/", "--model", "test-model"]),
  { runDirectory: "logs/jevbot/run-test", latest: false, model: "test-model" },
);
assertEquals(parseAuditOptions(["--latest"]).latest, true);
assertThrows(
  () => parseAuditOptions(["--run", "logs/jevbot/run-test", "--latest"]),
  Error,
  "either --run PATH or --latest",
);
const compactAudit = compactBattleLog("logs/jevbot/battle-test.jsonl", [
  { type: "battle_start", format: "gen9randombattle", bot_name: "JevBot" },
  { type: "public_event", display: "── Turn 1 ──" },
  {
    type: "decision",
    turn: 1,
    selected_action: { id: "move_1" },
    result: { source: "jev", answer: { confidence: 0.7 } },
    state: {
      own_side: {
        active: { details: "Garchomp", condition: "300/300" },
        conditions: [],
      },
      opponent_side: {
        active: { details: "Corviknight", condition: "300/300" },
      },
      current_active_request: { tactics: {} },
      legal_actions: [{
        id: "move_1",
        action: "Use Earthquake",
        accuracy: 80,
        baseline_damage: { estimated_damage_percent_range: [0, 0] },
        incoming_damage: {
          observed_revealed_move_damage: [{
            move: "Brave Bird",
            observed_damage_percent_range: [45, 52],
            could_ko_current_active: true,
          }],
        },
      }],
    },
  },
  { type: "battle_end", winner: "JevBot", tie: false },
]);
assert(compactAudit.includes("winner: JevBot"));
assert(compactAudit.includes("Selected: move_1: Use Earthquake"));
assert(compactAudit.includes("80% accuracy"));
assert(
  compactAudit.includes(
    "observed incoming: Brave Bird 45-52%; similar roll can KO",
  ),
);
const auditPrompt = reviewPrompt("test packet");
assert(auditPrompt.includes("it has 100% accuracy"));
assert(auditPrompt.includes("not knowable in advance"));
const compactSwitchAudit = compactBattleLog("logs/jevbot/battle-switch.jsonl", [
  { type: "battle_start", format: "gen9randombattle", bot_name: "JevBot" },
  {
    type: "decision",
    turn: 1,
    selected_action: { id: "switch_2" },
    result: { source: "jev", answer: {} },
    state: {
      own_side: {
        active: { details: "Garchomp", condition: "300/300" },
        conditions: [],
        team: [
          { slot: 1, details: "Garchomp", active: true },
          { slot: 2, details: "Rotom-Wash", active: false },
        ],
      },
      opponent_side: {
        active: { details: "Corviknight", condition: "300/300" },
      },
      current_active_request: { tactics: {} },
      legal_actions: [{ id: "switch_2", action: "Switch to team slot 2" }],
    },
  },
]);
assert(compactSwitchAudit.includes("Switch to team slot 2 (Rotom-Wash)"));

const actions = generateLegalActions(request);
assertEquals(actions.map((action) => action.id), [
  "move_1",
  "move_1_tera",
  "move_2",
  "move_2_tera",
  "switch_2",
]);
assertEquals(
  actions.find((action) => action.id === "switch_2").command,
  "switch 2",
);

const forcedSwitch = generateLegalActions({
  ...request,
  active: undefined,
  forceSwitch: [true],
});
assertEquals(forcedSwitch.map((action) => action.command), ["switch 2"]);

const tracker = new BattleStateTracker({ maxEvents: 2 });
tracker.observe(
  "battle-test",
  "|switch|p2a: Corviknight|Corviknight, L80|300/300",
);
tracker.observe("battle-test", "|-damage|p1a: Garchomp|200/300");
tracker.observe("battle-test", "|turn|4");
const snapshot = tracker.getSnapshot("battle-test", "p1");
assertEquals(snapshot.recentEvents, [
  "|-damage|p1a: Garchomp|200/300",
  "|turn|4",
]);
assertEquals(snapshot.opponentActive.details, "Corviknight, L80");
const analyzedActions = generateLegalActions(request, snapshot);
assertEquals(
  analyzedActions.find((action) => action.id === "move_1").description
    .type_matchup,
  "No effect due to type immunity",
);
assertEquals(
  analyzedActions.find((action) => action.id === "move_2").description
    .type_effectiveness_multiplier,
  0.5,
);

const protectRequest = {
  ...request,
  active: [{
    moves: [{
      move: "Protect",
      id: "protect",
      pp: 15,
      maxpp: 16,
      target: "self",
      disabled: false,
    }],
    trapped: false,
  }],
};
const protectTracker = new BattleStateTracker();
for (
  const line of [
    "|switch|p1a: Garchomp|Garchomp, L80, M|300/300",
    "|switch|p2a: Corviknight|Corviknight, L80|300/300",
    "|turn|4",
    "|move|p1a: Garchomp|Protect|p1a: Garchomp",
    "|-singleturn|p1a: Garchomp|Protect",
    "|turn|5",
  ]
) protectTracker.observe("battle-protect", line);
const protectActions = generateLegalActions(
  protectRequest,
  protectTracker.getSnapshot("battle-protect", "p1"),
);
assertEquals(
  protectActions[0].description.tactical_warnings,
  [
    "Protect follows 1 consecutive successful Protect-family move; its success chance is 33.3% (1/3).",
  ],
);
for (
  const line of [
    "|move|p1a: Garchomp|Protect|p1a: Garchomp",
    "|-singleturn|p1a: Garchomp|Protect",
    "|turn|6",
  ]
) protectTracker.observe("battle-protect", line);
assertEquals(
  generateLegalActions(
    protectRequest,
    protectTracker.getSnapshot("battle-protect", "p1"),
  )[0].description.tactical_warnings,
  [
    "Protect follows 2 consecutive successful Protect-family moves; its success chance is 11.1% (1/9).",
  ],
);

const protectResponseRequest = {
  ...request,
  active: [{
    moves: [
      {
        move: "Calm Mind",
        id: "calmmind",
        pp: 20,
        maxpp: 32,
        target: "self",
        disabled: false,
      },
      {
        move: "Dragon Claw",
        id: "dragonclaw",
        pp: 24,
        maxpp: 24,
        target: "normal",
        disabled: false,
      },
    ],
    trapped: false,
  }],
};
const protectResponseTracker = new BattleStateTracker();
for (
  const line of [
    "|switch|p1a: Garchomp|Garchomp, L80, M|300/300",
    "|switch|p2a: Corviknight|Corviknight, L80|300/300",
    "|turn|4",
    "|move|p2a: Corviknight|Protect|p2a: Corviknight",
    "|-singleturn|p2a: Corviknight|Protect",
    "|turn|5",
  ]
) protectResponseTracker.observe("battle-opponent-protect", line);
const protectResponseSnapshot = protectResponseTracker.getSnapshot(
  "battle-opponent-protect",
  "p1",
);
const protectResponsePayload = buildJevRequest(
  {
    roomid: "battle-opponent-protect",
    turn: 5,
    request: protectResponseRequest,
  },
  generateLegalActions(protectResponseRequest, protectResponseSnapshot),
  "typesafe/jev-1.13",
  protectResponseSnapshot,
);
assertEquals(
  protectResponsePayload.state.current_active_request.tactics
    .protect_response_options,
  {
    consecutive_successful_protects: 1,
    repeated_protect_success_percent: 33.3,
    repeated_protect_success_fraction: "1/3",
    detail:
      "The opponent just succeeded with 1 consecutive Protect-family move; another has a 33.3% (1/3) success chance.",
    instruction:
      "Compare setup or a useful pivot before attacking into a possible repeated Protect; attacking can still be right when it covers another line.",
    setup_options: [{
      id: "move_1",
      action: "Use Calm Mind",
      boosts: { spa: 1, spd: 1 },
    }],
  },
);

const structuredTracker = new BattleStateTracker();
const structuredRoom = "battle-structured-state";
for (
  const line of [
    "|turn|3",
    "|switch|p1a: Garchomp|Garchomp, L80, M|300/300",
    "|switch|p2a: Charizard|Charizard, L85, M|250/250",
    "|-sidestart|p1: JevBot|Stealth Rock",
    "|-sidestart|p1: JevBot|Spikes",
    "|-sidestart|p1: JevBot|Spikes",
    "|-sidestart|p1: JevBot|Spikes",
    "|-sidestart|p1: JevBot|Spikes",
    "|-sidestart|p2: Opponent|Reflect",
    "|-fieldstart|move: Electric Terrain",
    "|-fieldstart|move: Trick Room",
    "|-weather|Sandstorm",
    "|-boost|p2a: Charizard|spa|2",
    "|-unboost|p2a: Charizard|spe|1",
    "|-start|p2a: Charizard|Substitute",
    "|-start|p2a: Charizard|ability: Flash Fire",
    "|-item|p2a: Charizard|Leftovers",
    "|-enditem|p2a: Charizard|Leftovers",
    "|-terastallize|p2a: Charizard|Dragon",
    "|switch|p2a: Rotom-Wash|Rotom-Wash, L82|150/250 par",
  ]
) structuredTracker.observe(structuredRoom, line);
const structuredSnapshot = structuredTracker.getSnapshot(structuredRoom, "p1");
assertEquals(structuredSnapshot.turn, 3);
assertEquals(structuredSnapshot.field.weather, "Sandstorm");
assertEquals(structuredSnapshot.field.terrain, "Electric Terrain");
assertEquals(
  structuredSnapshot.field.pseudoWeather.map((effect) => effect.id),
  ["electricterrain", "trickroom"],
);
assertEquals(
  structuredSnapshot.ownSide.conditions.find((condition) =>
    condition.id === "stealthrock"
  ).layers,
  1,
);
assertEquals(
  structuredSnapshot.ownSide.conditions.find((condition) =>
    condition.id === "spikes"
  ).layers,
  3,
);
assertEquals(
  structuredSnapshot.opponentSide.conditions.find((condition) =>
    condition.id === "reflect"
  ).name,
  "Reflect",
);
assertEquals(structuredSnapshot.opponentSide.terastallized, true);
assertEquals(structuredSnapshot.opponentSide.active.details, "Rotom-Wash, L82");
assertEquals(structuredSnapshot.opponentSide.active.status, "par");
assertEquals(structuredSnapshot.opponentSide.team.length, 2);
const charizard = structuredSnapshot.opponentSide.team.find((pokemon) =>
  pokemon.ident === "p2a: Charizard"
);
assertEquals(charizard.active, false);
assertEquals(charizard.boosts, {});
assertEquals(charizard.volatileEffects, []);
assertEquals(charizard.teraType, "Dragon");
assertEquals(charizard.terastallized, true);
assertEquals(charizard.item, null);
assertEquals(charizard.itemState, "Leftovers (consumed or removed)");
JSON.stringify(structuredSnapshot);

structuredTracker.observe(structuredRoom, "|-fieldend|move: Electric Terrain");
structuredTracker.observe(structuredRoom, "|-fieldend|move: Trick Room");
structuredTracker.observe(structuredRoom, "|-sideend|p2: Opponent|Reflect");
structuredTracker.observe(structuredRoom, "|-weather|none");
const endedSnapshot = structuredTracker.getSnapshot(structuredRoom, "p1");
assertEquals(endedSnapshot.field.weather, null);
assertEquals(endedSnapshot.field.terrain, null);
assertEquals(endedSnapshot.field.pseudoWeather, []);
assertEquals(endedSnapshot.opponentSide.conditions, []);

const charizardInference = inferGen9RandomBattleSet({
  details: "Charizard, L85, M",
  revealedMoves: ["Flamethrower"],
  ability: "Blaze",
  teraType: "Dragon",
  terastallized: true,
});
assertEquals(charizardInference.level, 85);
assertEquals(charizardInference.possibleRoles, ["Fast Attacker"]);
assert(charizardInference.possibleMoves.includes("Hurricane"));
assert(!charizardInference.possibleMoves.includes("Dragon Dance"));
assertEquals(charizardInference.possibleAbilities, ["Blaze"]);
assertEquals(charizardInference.inferenceMismatch, false);
const mismatchInference = inferGen9RandomBattleSet({
  details: "Charizard, L85, M",
  revealedMoves: ["Surf"],
});
assertEquals(mismatchInference.inferenceMismatch, true);
assertEquals(mismatchInference.possibleRoles, [
  "Fast Attacker",
  "Setup Sweeper",
]);
assertEquals(inferGen9RandomBattleSet({ details: "MissingNo, L100" }), null);
assertEquals(
  addGen9RandomBattleInference([{
    details: "Charizard, L85, M",
    revealedMoves: ["Flamethrower"],
  }])[0].randomBattleSet.possibleRoles[0],
  "Fast Attacker",
);

const hazards = [
  { id: "stealthrock", name: "Stealth Rock", layers: 1 },
  { id: "spikes", name: "Spikes", layers: 2 },
  { id: "toxicspikes", name: "Toxic Spikes", layers: 2 },
  { id: "stickyweb", name: "Sticky Web" },
];
const garchompEntry = describeEntryHazards(request.side.pokemon[0], {
  conditions: hazards,
}, { pseudoWeather: [] });
assertEquals(garchompEntry.entry_hazard_hp_loss_percent, 22.9);
assert(
  garchompEntry.entry_hazard_effects.includes(
    "Toxic Spikes: becomes badly poisoned unless an ability prevents it",
  ),
);
assert(
  garchompEntry.entry_hazard_effects.includes("Sticky Web: -1 Speed stage"),
);
const bootsEntry = describeEntryHazards(
  { ...request.side.pokemon[1], item: "heavydutyboots" },
  { conditions: hazards },
  { pseudoWeather: [] },
);
assertEquals(bootsEntry.hazards_prevented_by_heavy_duty_boots, true);
assertEquals(bootsEntry.entry_hazard_hp_loss_percent, 0);
const teamHazardUrgency = describeTeamHazardUrgency(request.side.pokemon, {
  ownSide: { conditions: hazards },
  field: { pseudoWeather: [] },
});
assertEquals(teamHazardUrgency.urgency, "low");
assertEquals(
  teamHazardUrgency.affected_pokemon.find((pokemon) =>
    pokemon.pokemon === "p1: Garchomp"
  ).entry_hazard_hp_loss_percent,
  22.9,
);
const opponentThreats = describeOpponentThreats({
  details: "Charizard, L85, M",
  revealedMoves: ["Earthquake"],
  ability: "Blaze",
}, { details: "Pikachu, L88", ability: "Static" });
assertEquals(opponentThreats.known_super_effective_moves, [
  "Earthquake (2x super-effective)",
]);
const incomingDamage = describeIncomingDamage({
  details: "Charizard, L85, M",
  revealedMoves: ["Earthquake"],
  ability: "Blaze",
}, {
  details: "Pikachu, L88",
  condition: "180/180",
  stats: { hp: 180, atk: 100, def: 120, spa: 120, spd: 120, spe: 200 },
  ability: "Static",
  item: "lightball",
}, {
  ownSide: { conditions: [] },
  opponentSide: { conditions: [] },
  field: { pseudoWeather: [] },
});
assertEquals(
  incomingDamage.revealed_move_damage_estimates[0].move,
  "Earthquake",
);
assertEquals(
  incomingDamage.revealed_move_damage_estimates[0]
    .estimated_damage_percent_range,
  [103.3, 122.2],
);
assertEquals(
  incomingDamage.possible_move_damage_estimates[0].move,
  "Flare Blitz",
);
const observedDamageTracker = new BattleStateTracker();
for (
  const line of [
    "|switch|p1a: Pikachu|Pikachu, L88|180/180",
    "|switch|p2a: Charizard|Charizard, L85, M|300/300",
    "|turn|1",
    "|move|p2a: Charizard|Earthquake|p1a: Pikachu",
    "|-damage|p1a: Pikachu|80/180",
    "|turn|2",
  ]
) {
  observedDamageTracker.observe("battle-observed-damage", line);
}
const observedDamageSnapshot = observedDamageTracker.getSnapshot(
  "battle-observed-damage",
  "p1",
);
assertEquals(observedDamageSnapshot.observedDamage, [{
  source: "p2a: Charizard",
  target: "p1a: Pikachu",
  move: "Earthquake",
  damage_hp: 100,
  target_max_hp: 180,
  damage_percent: 55.6,
  turn: 1,
}]);
const observedIncomingDamage = describeIncomingDamage(
  observedDamageSnapshot.opponentActive,
  observedDamageSnapshot.ownSide.active,
  observedDamageSnapshot,
);
assertEquals(observedIncomingDamage.observed_revealed_move_damage, [{
  move: "Earthquake",
  observed_hit_count: 1,
  observed_damage_hp_range: [100, 100],
  observed_damage_percent_range: [55.6, 55.6],
  could_ko_current_active: true,
  detail:
    "Earthquake has already dealt up to 100 HP (55.6%) to this active Pokémon; at its current HP, a similar roll could KO. This is an observed warning, not a guaranteed future roll.",
}]);

const tacticalActions = generateLegalActions(request, {
  ownSide: { conditions: hazards },
  field: { pseudoWeather: [] },
  opponentActive: { details: "Rotom-Wash, L82", ability: "Levitate" },
});
assertEquals(
  tacticalActions.find((action) => action.id === "move_1").description
    .type_matchup,
  "No effect due to known ability immunity: Levitate",
);
const rotomSwitch =
  tacticalActions.find((action) => action.id === "switch_2").description;
assertEquals(rotomSwitch.entry_hazard_hp_loss_percent, 12.5);
assertEquals(rotomSwitch.grounded, false);
assertEquals(rotomSwitch.grounded_reason, "levitate");
assertEquals(typeof rotomSwitch.incoming_damage, "object");
assertEquals(typeof rotomSwitch.next_turn_best_damaging_moves, "object");
assertEquals(
  tacticalActions.find((action) => action.id === "move_1").description
    .incoming_damage.revealed_move_damage_estimates,
  [],
);
const inferredLevitateActions = generateLegalActions(request, {
  opponentActive: { details: "Eelektross, L87, M" },
});
assertEquals(
  inferredLevitateActions.find((action) => action.id === "move_1").description
    .type_matchup,
  "No effect due to inferred ability immunity: Levitate",
);
const immuneTracker = new BattleStateTracker();
immuneTracker.observe(
  "battle-immune",
  "|switch|p2a: Eelektross|Eelektross, L87, M|100/100",
);
immuneTracker.observe(
  "battle-immune",
  "|-immune|p2a: Eelektross|[from] ability: Levitate",
);
assertEquals(
  immuneTracker.getSnapshot("battle-immune", "p1").opponentActive.ability,
  "Levitate",
);
const teraActions = generateLegalActions(request, {
  opponentActive: {
    details: "Charizard, L85, M",
    teraType: "Dragon",
    terastallized: true,
  },
});
assertEquals(
  teraActions.find((action) => action.id === "move_2").description
    .opponent_types,
  ["Dragon"],
);
assertEquals(
  teraActions.find((action) => action.id === "move_2").description
    .type_effectiveness_multiplier,
  2,
);
const rangedActions = generateLegalActions(request, {
  field: { pseudoWeather: [] },
  opponentSide: { conditions: [] },
  opponentActive: {
    details: "Charizard, L85, M",
    condition: "250/250",
    ability: "Blaze",
  },
});
assertEquals(
  rangedActions.find((action) => action.id === "move_2").description
    .baseline_damage,
  {
    available: true,
    calculation_engine: "@smogon/calc",
    estimated_damage_hp_range: [109, 129],
    estimated_damage_percent_range: [40.2, 47.6],
    estimated_target_max_hp: 271,
    caveat:
      "Damage uses @smogon/calc Gen 9 mechanics with exact private stats when available and Gen 9 Random Battle default stats otherwise; hidden opponent information remains an assumption.",
  },
);
assertEquals(
  rangedActions.find((action) => action.id === "move_2").description
    .speed_comparison.speed_order,
  "likely faster",
);
const conditionalMoveRequest = {
  ...request,
  active: [{
    moves: [{
      move: "First Impression",
      id: "firstimpression",
      pp: 7,
      maxpp: 8,
      target: "normal",
      disabled: false,
    }, {
      move: "Sucker Punch",
      id: "suckerpunch",
      pp: 7,
      maxpp: 8,
      target: "normal",
      disabled: false,
    }],
    trapped: false,
  }],
  side: {
    ...request.side,
    pokemon: [{
      ...request.side.pokemon[0],
      enteredTurn: 1,
      moves: ["firstimpression", "suckerpunch"],
    }, ...request.side.pokemon.slice(1)],
  },
};
const conditionalActions = generateLegalActions(conditionalMoveRequest, {
  turn: 5,
  opponentSide: {
    active: { ident: "p2a: Pikachu", details: "Pikachu, L93" },
    conditions: [],
  },
  opponentActive: { ident: "p2a: Pikachu", details: "Pikachu, L93" },
  recentEvents: [
    "|turn|4",
    "|move|p2a: Pikachu|Protect|p2a: Pikachu",
    "|-singleturn|p2a: Pikachu|move: Protect",
    "|turn|5",
  ],
});
assertEquals(
  conditionalActions.find((action) => action.id === "move_1").description
    .conditional_action_warning,
  "First Impression fails because this Pokémon is no longer on its first turn after entering.",
);
assertEquals(
  conditionalActions.find((action) => action.id === "move_2").description
    .conditional_action_warning,
  "Sucker Punch fails if the opponent repeats Protect; its next Protect chance is 33.3% (1/3).",
);
const boostedOpponentActions = generateLegalActions(request, {
  field: { pseudoWeather: [] },
  opponentSide: { conditions: [] },
  opponentActive: { details: "Charizard, L85, M", boosts: { spe: 1 } },
});
assertEquals(
  boostedOpponentActions.find((action) => action.id === "move_2").description
    .speed_comparison.speed_order,
  "likely slower",
);
const teraDamageActions = generateLegalActions(request, {
  field: { pseudoWeather: [] },
  opponentSide: { conditions: [] },
  opponentActive: { details: "Pikachu, L93", condition: "200/200" },
});
assert(
  teraDamageActions.find((action) => action.id === "move_1_tera").description
    .baseline_damage.estimated_damage_hp_range[1] >
    teraDamageActions.find((action) => action.id === "move_1").description
      .baseline_damage.estimated_damage_hp_range[1],
);
const teraBlastDamage = estimateBaselineDamage(
  { id: "terablast", name: "Tera Blast", category: "Special" },
  { ...request.side.pokemon[0], terastallized: true },
  { details: "Pikachu, L93", condition: "200/200" },
  { field: { pseudoWeather: [] }, opponentSide: { conditions: [] } },
);
assertEquals(teraBlastDamage.calculation_engine, "@smogon/calc");
assert(teraBlastDamage.estimated_damage_hp_range[0] > 0);
const rageFistTracker = new BattleStateTracker();
rageFistTracker.observe(
  "battle-rage-fist",
  "|switch|p1a: Garchomp|Garchomp, L80, M|300/300",
);
rageFistTracker.observe(
  "battle-rage-fist",
  "|switch|p2a: Annihilape|Annihilape, L82, M|300/300",
);
rageFistTracker.observe("battle-rage-fist", "|turn|1");
rageFistTracker.observe(
  "battle-rage-fist",
  "|move|p1a: Garchomp|Dragon Claw|p2a: Annihilape",
);
rageFistTracker.observe(
  "battle-rage-fist",
  "|-damage|p2a: Annihilape|200/300",
);
rageFistTracker.observe(
  "battle-rage-fist",
  "|move|p1a: Garchomp|Dragon Claw|p2a: Annihilape",
);
rageFistTracker.observe(
  "battle-rage-fist",
  "|-damage|p2a: Annihilape|100/300",
);
rageFistTracker.observe(
  "battle-rage-fist",
  "|-damage|p2a: Annihilape|90/300|[from] brn",
);
const rageFistOpponent = rageFistTracker.getSnapshot(
  "battle-rage-fist",
  "p1",
).opponentActive;
assertEquals(rageFistOpponent.rageFistHitsTaken, 2);
const baseRageFistDamage = estimateBaselineDamage(
  { id: "ragefist", name: "Rage Fist", category: "Physical" },
  { details: "Annihilape, L82, M", condition: "300/300" },
  request.side.pokemon[0],
);
const boostedRageFistDamage = estimateBaselineDamage(
  { id: "ragefist", name: "Rage Fist", category: "Physical" },
  rageFistOpponent,
  request.side.pokemon[0],
);
assert(
  boostedRageFistDamage.estimated_damage_hp_range[0] >
    baseRageFistDamage.estimated_damage_hp_range[1],
);
assertEquals(boostedRageFistDamage.rage_fist_hits_taken, 2);
assertEquals(boostedRageFistDamage.effective_base_power, 150);
const tacticalPayload = buildJevRequest(
  { roomid: "battle-tactical", turn: 5, request },
  tacticalActions,
  "typesafe/jev-1.13",
  {
    turn: 5,
    ownSide: { conditions: hazards },
    opponentSide: {
      active: { details: "Rotom-Wash, L82", ability: "Levitate" },
      team: [],
      conditions: [],
    },
    field: { weather: null, terrain: null, pseudoWeather: [] },
  },
);
assertEquals(
  tacticalPayload.state.legal_actions.find((action) => action.id === "switch_2")
    .entry_hazard_hp_loss_percent,
  12.5,
);
assertEquals(
  tacticalPayload.state.current_active_request.tactics.incoming_damage
    .revealed_move_damage_estimates,
  [],
);
assertEquals(
  tacticalPayload.state.current_active_request.tactics.team_hazard_urgency
    .urgency,
  "low",
);
assertEquals(
  tacticalPayload.state.legal_actions.find((action) => action.id === "move_1")
    .incoming_damage,
  undefined,
);
const pivotActions = generateLegalActions(request, {
  ownSide: { conditions: [] },
  opponentSide: {
    active: {
      details: "Rotom-Wash, L82",
      condition: "250/250",
      ability: "Levitate",
      boosts: { spe: 2 },
    },
    conditions: [],
  },
  field: { weather: null, terrain: null, pseudoWeather: [] },
  opponentActive: {
    details: "Rotom-Wash, L82",
    condition: "250/250",
    ability: "Levitate",
    boosts: { spe: 2 },
  },
});
const pivotPayload = buildJevRequest(
  { roomid: "battle-pivot", turn: 5, request },
  pivotActions,
  "typesafe/jev-1.13",
  {
    turn: 5,
    ownSide: { conditions: [] },
    opponentSide: {
      active: {
        details: "Rotom-Wash, L82",
        condition: "250/250",
        ability: "Levitate",
        boosts: { spe: 2 },
      },
      team: [],
      conditions: [],
    },
    field: { weather: null, terrain: null, pseudoWeather: [] },
  },
);
const pivotComparison = pivotPayload.state.current_active_request.tactics
  .safe_pivot_comparison;
assertEquals(
  pivotComparison.instruction,
  "No legal attack guarantees a KO. Compare these pivots before sacrificing the active Pokémon.",
);
assertEquals(
  pivotComparison.safe_against_revealed_moves[0].id,
  "switch_2",
);
const priorityFinisherPayload = buildJevRequest(
  { roomid: "battle-priority", turn: 5, request },
  [
    {
      id: "move_1",
      command: "move 1",
      kind: "move",
      description: {
        action: "Use Tackle",
        move_id: "tackle",
        priority: 0,
        baseline_damage: { estimated_damage_hp_range: [20, 25] },
      },
    },
    {
      id: "move_2",
      command: "move 2",
      kind: "move",
      description: {
        action: "Use Extreme Speed",
        move_id: "extremespeed",
        priority: 2,
        baseline_damage: { estimated_damage_hp_range: [100, 120] },
      },
    },
    {
      id: "move_3",
      command: "move 3",
      kind: "move",
      description: {
        action: "Use Sucker Punch",
        move_id: "suckerpunch",
        priority: 1,
        baseline_damage: { estimated_damage_hp_range: [100, 120] },
      },
    },
  ],
  "typesafe/jev-1.13",
  {
    turn: 5,
    opponentSide: {
      active: { details: "Pikachu, L93", condition: "100/100" },
      team: [],
      conditions: [],
    },
  },
);
assertEquals(
  priorityFinisherPayload.state.current_active_request.tactics
    .priority_finishing_options,
  [{
    id: "move_2",
    action: "Use Extreme Speed",
    priority: 2,
    detail:
      "Minimum damage guarantees the KO. This priority move acts before normal-priority attacks.",
  }],
);
const teraWarningPayload = buildJevRequest(
  { roomid: "battle-tera", turn: 5, request },
  [
    {
      id: "move_1",
      command: "move 1",
      kind: "move",
      description: {
        action: "Use Dragon Claw",
        slot: 1,
        move_id: "dragonclaw",
        priority: 0,
        baseline_damage: { estimated_damage_hp_range: [100, 120] },
      },
    },
    {
      id: "move_1_tera",
      command: "move 1 terastallize",
      kind: "move-terastallize",
      description: {
        action: "Terastallize into Water, then use Dragon Claw",
        slot: 1,
        move_id: "dragonclaw",
        tera_type: "Water",
        priority: 0,
        baseline_damage: { estimated_damage_hp_range: [100, 120] },
      },
    },
  ],
  "typesafe/jev-1.13",
  {
    turn: 5,
    opponentSide: {
      active: {
        details: "Pikachu, L93",
        condition: "100/100",
        revealedMoves: ["Thunderbolt"],
      },
      team: [],
      conditions: [],
    },
  },
);
assertEquals(
  teraWarningPayload.state.current_active_request.tactics.tera_warnings,
  [{
    id: "move_1_tera",
    action: "Terastallize into Water, then use Dragon Claw",
    warnings: [
      "Use Dragon Claw already guarantees the KO without Terastallizing.",
      "Thunderbolt: 0x → 2x",
    ],
  }],
);
const teraFinisherPayload = buildJevRequest(
  { roomid: "battle-tera-finisher", turn: 5, request },
  [
    {
      id: "move_1",
      command: "move 1",
      kind: "move",
      description: {
        action: "Use Thunderbolt",
        slot: 1,
        move_id: "thunderbolt",
        baseline_damage: { estimated_damage_hp_range: [70, 80] },
      },
    },
    {
      id: "move_1_tera",
      command: "move 1 terastallize",
      kind: "move-terastallize",
      description: {
        action: "Terastallize into Electric, then use Thunderbolt",
        slot: 1,
        move_id: "thunderbolt",
        baseline_damage: { estimated_damage_hp_range: [100, 120] },
      },
    },
  ],
  "typesafe/jev-1.13",
  {
    turn: 5,
    opponentSide: {
      active: { details: "Pikachu, L93", condition: "100/100" },
      team: [],
      conditions: [],
    },
  },
);
assertEquals(
  teraFinisherPayload.state.current_active_request.tactics
    .tera_finishing_options,
  [{
    id: "move_1_tera",
    action: "Terastallize into Electric, then use Thunderbolt",
    detail:
      "Terastallizing changes this otherwise non-lethal move into a guaranteed KO by minimum damage.",
  }],
);
const responseOptionsPayload = buildJevRequest(
  { roomid: "battle-response-options", turn: 5, request },
  [
    {
      id: "move_1",
      command: "move 1",
      kind: "move",
      description: {
        action: "Use Haze",
        move_id: "haze",
        baseline_damage: { estimated_damage_hp_range: [0, 0] },
        incoming_damage: {
          current_hp_percent: 40,
          revealed_move_damage_estimates: [{
            move: "Shadow Ball",
            estimated_damage_percent_range: [50, 60],
          }],
        },
      },
    },
    {
      id: "move_2",
      command: "move 2",
      kind: "move",
      description: {
        action: "Use Recover",
        move_id: "recover",
        baseline_damage: { estimated_damage_hp_range: [0, 0] },
        incoming_damage: {
          current_hp_percent: 40,
          revealed_move_damage_estimates: [{
            move: "Shadow Ball",
            estimated_damage_percent_range: [50, 60],
          }],
        },
      },
    },
    {
      id: "move_3",
      command: "move 3",
      kind: "move",
      description: {
        action: "Use Rest",
        move_id: "rest",
        baseline_damage: { estimated_damage_hp_range: [0, 0] },
        incoming_damage: {
          current_hp_percent: 40,
          revealed_move_damage_estimates: [{
            move: "Shadow Ball",
            estimated_damage_percent_range: [50, 60],
          }],
        },
      },
    },
    {
      id: "switch_2",
      command: "switch 2",
      kind: "switch",
      description: {
        action: "Switch to team slot 2",
        ability: "Unaware",
      },
    },
  ],
  "typesafe/jev-1.13",
  {
    turn: 5,
    opponentSide: {
      active: {
        details: "Spectrier, L81",
        condition: "100/100",
        boosts: { spa: 2 },
      },
      team: [],
      conditions: [],
    },
  },
);
assertEquals(
  responseOptionsPayload.state.current_active_request.tactics
    .anti_setup_options.moves,
  [{
    id: "move_1",
    action: "Use Haze",
    detail: "Removes or reverses the opponent's stat boosts.",
  }],
);
assertEquals(
  responseOptionsPayload.state.current_active_request.tactics
    .anti_setup_options.unaware_switches,
  [{
    id: "switch_2",
    action: "Switch to team slot 2",
    detail: "Unaware ignores the opponent's offensive stat boosts.",
  }],
);
assertEquals(
  responseOptionsPayload.state.current_active_request.tactics
    .safe_recovery_options,
  [{
    id: "move_2",
    action: "Use Recover",
    hp_after_recovery_percent: 90,
    maximum_revealed_follow_up_damage_percent: 60,
    detail:
      "This recovery move leaves the active able to survive every revealed damaging move next turn; no legal attack currently guarantees a KO.",
  }, {
    id: "move_3",
    action: "Use Rest",
    hp_after_recovery_percent: 100,
    maximum_revealed_follow_up_damage_percent: 60,
    detail:
      "Rest leaves the active able to survive every revealed damaging move next turn, but puts it to sleep; no legal attack currently guarantees a KO.",
  }],
);
const accurateKoPayload = buildJevRequest(
  { roomid: "battle-accuracy", turn: 5, request },
  [
    {
      id: "move_1",
      command: "move 1",
      kind: "move",
      description: {
        action: "Use Fire Blast",
        move_id: "fireblast",
        priority: 0,
        accuracy: 85,
        baseline_damage: { estimated_damage_hp_range: [100, 120] },
      },
    },
    {
      id: "move_2",
      command: "move 2",
      kind: "move",
      description: {
        action: "Use Flamethrower",
        move_id: "flamethrower",
        priority: 0,
        accuracy: 100,
        baseline_damage: { estimated_damage_hp_range: [100, 120] },
      },
    },
  ],
  "typesafe/jev-1.13",
  {
    turn: 5,
    opponentSide: {
      active: { details: "Pikachu, L93", condition: "100/100" },
      team: [],
      conditions: [],
    },
  },
);
assertEquals(
  accurateKoPayload.state.current_active_request.tactics
    .accurate_ko_alternatives,
  [{
    risky_action: {
      id: "move_1",
      action: "Use Fire Blast",
      accuracy_percent: 85,
    },
    reliable_ko_options: [{
      id: "move_2",
      action: "Use Flamethrower",
      accuracy_percent: 100,
    }],
    detail:
      "These moves all guarantee the KO by minimum damage and act at least as early; prefer the accurate option unless it has a separate strategic cost.",
  }],
);
const immunityAccurateKoPayload = buildJevRequest(
  { roomid: "battle-accuracy-immunity", turn: 5, request },
  [
    {
      id: "move_1",
      command: "move 1",
      kind: "move",
      description: {
        action: "Use Hurricane",
        move_id: "hurricane",
        priority: 0,
        accuracy: 70,
        type_effectiveness_multiplier: 1,
        baseline_damage: { estimated_damage_hp_range: [100, 120] },
      },
    },
    {
      id: "move_2",
      command: "move 2",
      kind: "move",
      description: {
        action: "Use Thunderbolt",
        move_id: "thunderbolt",
        priority: 0,
        accuracy: 100,
        type_effectiveness_multiplier: 0,
        type_matchup: "No effect due to inferred ability immunity: Volt Absorb",
        // This deliberately mirrors @smogon/calc's raw damage output. The
        // ability immunity, not the raw calculation, decides whether it can
        // be a KO.
        baseline_damage: { estimated_damage_hp_range: [100, 120] },
      },
    },
  ],
  "typesafe/jev-1.13",
  {
    turn: 5,
    opponentSide: {
      active: { details: "Kilowattrel, L83", condition: "100/100" },
      team: [],
      conditions: [],
    },
  },
);
assertEquals(
  immunityAccurateKoPayload.state.current_active_request.tactics
    ?.accurate_ko_alternatives,
  undefined,
);
const hazardResponsePayload = buildJevRequest(
  { roomid: "battle-hazards", turn: 5, request },
  [
    {
      id: "move_1",
      command: "move 1",
      kind: "move",
      description: { action: "Use Taunt", move_id: "taunt" },
    },
    {
      id: "switch_2",
      command: "switch 2",
      kind: "switch",
      description: {
        action: "Switch to team slot 2",
        entry_hazard_hp_loss_percent: 0,
        entry_hazard_effects: ["Toxic Spikes: absorbs the hazard on entry"],
      },
    },
  ],
  "typesafe/jev-1.13",
  {
    turn: 5,
    ownSide: {
      conditions: [{ id: "toxicspikes", name: "Toxic Spikes", layers: 2 }],
    },
    opponentSide: {
      active: {
        details: "Forretress, L82",
        condition: "100/100",
        revealedMoves: ["Spikes"],
      },
      team: [],
      conditions: [],
    },
  },
);
assertEquals(
  hazardResponsePayload.state.current_active_request.tactics
    .hazard_response_options,
  {
    instruction:
      "Hazards have long-term team costs. Consider denying a likely setter with Taunt or using and preserving a Toxic Spikes absorber; do not assume inferred moves are confirmed.",
    taunt_option: { id: "move_1", action: "Use Taunt" },
    opponent_hazard_threats: {
      possible_hazard_moves: [{
        move: "Spikes",
        hazard: "spikes",
        source: "revealed",
      }, {
        move: "Stealth Rock",
        hazard: "stealthrock",
        source: "inferred",
      }],
      caveat:
        "Inferred hazards come from compatible Random Battle sets, not confirmed opponent moves.",
    },
    toxic_spikes_absorbers: [{
      id: "switch_2",
      action: "Switch to team slot 2",
      entry_hazard_hp_loss_percent: 0,
    }],
  },
);
assertEquals(
  formatDecisionSummary(rangedActions.find((action) => action.id === "move_2")),
  "Use Dragon Claw; damage 40.2-47.6%; likely faster",
);
assertEquals(
  formatDecisionSummary({
    id: "switch_2",
    description: {
      action: "Switch to team slot 2",
      entry_hazard_hp_loss_percent: 12.5,
      speed_comparison: { speed_order: "likely slower" },
      incoming_damage: {
        revealed_move_damage_estimates: [{
          move: "Earthquake",
          estimated_damage_percent_range: [80, 94.4],
        }],
      },
    },
  }),
  "Switch to team slot 2; likely slower; entry hazards 12.5%; revealed Earthquake 80-94.4%",
);

const guaranteedKoActions = [
  {
    id: "move_1",
    command: "move 1",
    kind: "move",
    description: {
      action: "Use Tackle",
      move_id: "tackle",
      priority: 0,
      speed_comparison: { speed_order: "likely slower" },
      // Even a guaranteed KO is unusable when the revealed faster move is
      // guaranteed to KO first.
      baseline_damage: { estimated_damage_hp_range: [100, 120] },
      incoming_damage: {
        current_hp_percent: 20,
        revealed_move_damage_estimates: [{
          move: "Earthquake",
          estimated_damage_percent_range: [30, 40],
        }],
      },
    },
  },
  {
    id: "switch_2",
    command: "switch 2",
    kind: "switch",
    description: {
      action: "Switch to team slot 2",
      entry_hazard_hp_loss_percent: 12.5,
      incoming_damage: {
        current_hp_percent: 100,
        revealed_move_damage_estimates: [{
          move: "Earthquake",
          estimated_damage_percent_range: [20, 30],
        }],
      },
    },
  },
];
const guaranteedKoOverride = chooseTacticalOverride(
  guaranteedKoActions[0],
  guaranteedKoActions,
  { opponentActive: { details: "Pikachu, L93", condition: "100/100" } },
  request.side.pokemon,
);
assertEquals(guaranteedKoOverride.action.id, "switch_2");
assertEquals(guaranteedKoOverride.reason.type, "revealed_guaranteed_ko_escape");

const priorityKoActions = [
  {
    ...guaranteedKoActions[0],
    description: {
      ...guaranteedKoActions[0].description,
      speed_comparison: { speed_order: "likely faster" },
      incoming_damage: {
        current_hp_percent: 20,
        revealed_move_damage_estimates: [{
          move: "Bullet Punch",
          priority: 1,
          estimated_damage_percent_range: [30, 40],
        }],
      },
    },
  },
  guaranteedKoActions[1],
];
const priorityKoOverride = chooseTacticalOverride(
  priorityKoActions[0],
  priorityKoActions,
  { opponentActive: { details: "Scizor, L80", condition: "100/100" } },
  request.side.pokemon,
);
assertEquals(priorityKoOverride.action.id, "switch_2");
assertEquals(
  priorityKoOverride.reason.type,
  "revealed_priority_guaranteed_ko_escape",
);

const hazardRemovalActions = [
  {
    id: "move_1",
    command: "move 1",
    kind: "move",
    description: {
      action: "Use Surf",
      move_id: "surf",
      baseline_damage: { estimated_damage_hp_range: [20, 25] },
      incoming_damage: { revealed_move_damage_estimates: [] },
    },
  },
  {
    id: "move_2",
    command: "move 2",
    kind: "move",
    description: { action: "Use Rapid Spin", move_id: "rapidspin" },
  },
];
const hazardRemovalOverride = chooseTacticalOverride(
  hazardRemovalActions[0],
  hazardRemovalActions,
  {
    ownSide: { conditions: hazards },
    field: { pseudoWeather: [] },
    opponentActive: {
      details: "Pikachu, L93",
      condition: "100/100",
    },
  },
  [
    { ...request.side.pokemon[0], condition: "300/300" },
    { ...request.side.pokemon[1], condition: "240/240" },
    { details: "Charizard, L85", condition: "250/250", item: "leftovers" },
  ],
);
assertEquals(hazardRemovalOverride.action.id, "move_2");
assertEquals(hazardRemovalOverride.reason.type, "critical_hazard_removal");

let loginRequest;
assertEquals(
  await getLoginAssertion({
    username: "LiveBot",
    password: "test-password",
    challstr: "4|server-challenge",
    fetchImpl: async (url, options) => {
      loginRequest = { url, options };
      return new Response(']{"assertion":"signed-assertion"}', { status: 200 });
    },
  }),
  "signed-assertion",
);
assertEquals(loginRequest.url, "https://play.pokemonshowdown.com/api/login");
assertEquals(loginRequest.options.method, "POST");
assertEquals(loginRequest.options.body.get("name"), "LiveBot");
assertEquals(loginRequest.options.body.get("pass"), "test-password");
assertEquals(loginRequest.options.body.get("challstr"), "4|server-challenge");
await assertRejects(
  () =>
    getLoginAssertion({
      username: "LiveBot",
      password: "test-password",
      challstr: "4|server-challenge",
      fetchImpl: async () =>
        new Response(']{"assertion":";;invalid"}', { status: 200 }),
    }),
  Error,
  "Login was rejected",
);
assertEquals(
  redactProtocolMessage("|/trn LiveBot,0,signed-assertion"),
  "|/trn LiveBot,0,[assertion redacted]",
);
assertEquals(formatBattleEvent("|turn|5", "p1"), "── Turn 5 ──");
assertEquals(
  formatBattleEvent("|switch|p2a: Charizard|Charizard, L85, M|250/250", "p1"),
  "Opponent sent out Charizard (250/250)",
);
assertEquals(
  formatBattleEvent("|move|p1a: Garchomp|Earthquake|p2a: Charizard", "p1"),
  "You Garchomp used Earthquake",
);
assertEquals(
  formatBattleEvent("|-damage|p2a: Charizard|100/250 brn", "p1"),
  "Opponent Charizard: 100/250 brn",
);
assertEquals(
  formatBattleEvent("|-terastallize|p2a: Charizard|Dragon", "p1"),
  "Opponent Charizard Terastallized into Dragon",
);
assertEquals(formatBattleEvent("|chat|p1|hello", "p1"), null);
assertEquals(
  formatOpponentChat("|c|Opponent|good luck!", "JevBot", "p1"),
  "Opponent: good luck!",
);
assertEquals(
  formatOpponentChat("|c:|1700000000|Opponent|well played", "JevBot", "p1"),
  "Opponent: well played",
);
assertEquals(formatOpponentChat("|c|JevBot|hello", "JevBot", "p1"), null);
assertEquals(formatOpponentChat("|c|p1|hello", "JevBot", "p1"), null);

const recorderDirectory = await Deno.makeTempDir({
  prefix: "jevbot-recorder-",
});
const recorder = new BattleRecorder({
  directory: recorderDirectory,
  clock: () => "2026-09-29T12:00:00.000Z",
});
recorder.record("battle-test", "battle_start", { format: "gen9randombattle" });
recorder.record("battle-test", "decision", {
  turn: 1,
  selected_action: { id: "move_1" },
});
await recorder.flush("battle-test");
const recordedLines = (await Deno.readTextFile(recorder.pathFor("battle-test")))
  .trim().split("\n").map((line) => JSON.parse(line));
assertEquals(recordedLines, [
  {
    timestamp: "2026-09-29T12:00:00.000Z",
    type: "battle_start",
    format: "gen9randombattle",
  },
  {
    timestamp: "2026-09-29T12:00:00.000Z",
    type: "decision",
    turn: 1,
    selected_action: { id: "move_1" },
  },
]);

const payload = buildJevRequest(
  { roomid: "battle-test", turn: 4, request },
  actions,
  "typesafe/jev-1.13",
  snapshot,
);
assertEquals(payload.questions.action.type, "choice");
assertEquals(
  Object.keys(payload.questions.action.criteria),
  actions.map((action) => action.id),
);
assertEquals(payload.questions.action.criteria.move_1, "Use Earthquake");
assertEquals(payload.state.own_side.team.length, 3);
assertEquals(payload.state.opponent_side.active.details, "Corviknight, L80");
assertEquals(
  payload.state.opponent_side.team[0].randomBattleSet.species,
  "Corviknight",
);
assertEquals(payload.state.field, {
  weather: null,
  terrain: null,
  pseudoWeather: [],
});

let fetched = false;
const recordedDecisions = [];
const model = new JevDecisionModel({
  apiKey: "test-key",
  recorder: {
    record: (roomid, type, data) =>
      recordedDecisions.push({ roomid, type, data }),
  },
  fetchImpl: async (_url, options) => {
    fetched = true;
    assertEquals(options.headers.Authorization, "Bearer test-key");
    const sent = JSON.parse(options.body);
    assertEquals(sent.state.battle.turn, 4);
    assertEquals(sent.state.own_side.team[0].pokemon, "p1: Garchomp");
    assertEquals(JSON.stringify(sent).includes("test-key"), false);
    return new Response(
      JSON.stringify({
        answers: {
          action: {
            type: "choice",
            choice: "switch_2",
            confidence: 0.7,
            probabilities: {
              move_1: 0.1,
              move_1_tera: 0.05,
              move_2: 0.1,
              move_2_tera: 0.05,
              switch_2: 0.7,
            },
          },
        },
        usage: { cost: 0.00001 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  },
});
assertEquals(
  await model.choose({ roomid: "battle-test", turn: 4, request }),
  "switch 2",
);
assertEquals(fetched, true);
assertEquals(recordedDecisions.length, 1);
assertEquals(recordedDecisions[0].roomid, "battle-test");
assertEquals(recordedDecisions[0].type, "decision");
assertEquals(recordedDecisions[0].data.selected_action.id, "switch_2");
assertEquals(recordedDecisions[0].data.result.source, "jev");
assert(
  typeof recordedDecisions[0].data.result.request_payload_bytes === "number",
);
assert(recordedDecisions[0].data.result.request_payload_bytes > 0);
assertEquals(JSON.stringify(recordedDecisions[0]).includes("test-key"), false);

const forcedDecisionRecords = [];
const forcedModel = new JevDecisionModel({
  apiKey: "test-key",
  fetchImpl: async () => {
    throw new Error("The API should not be called for a forced action.");
  },
  recorder: {
    record: (roomid, type, data) =>
      forcedDecisionRecords.push({ roomid, type, data }),
  },
});
assertEquals(
  await forcedModel.choose({
    roomid: "battle-forced-choice",
    turn: 1,
    request: { ...request, active: undefined, forceSwitch: [true] },
  }),
  "switch 2",
);
assertEquals(
  forcedDecisionRecords[0].data.result.source,
  "single_legal_action",
);

if (Deno.args.includes("--live")) {
  assert(
    Deno.env.get("OPENROUTER_API_KEY"),
    "OPENROUTER_API_KEY must be set for --live",
  );
  const liveModel = new JevDecisionModel();
  liveModel.observe(
    "battle-jev-smoke",
    "|switch|p1a: Garchomp|Garchomp, L80, M|300/300",
  );
  liveModel.observe(
    "battle-jev-smoke",
    "|switch|p2a: Corviknight|Corviknight, L80|300/300",
  );
  const choice = await liveModel.choose({
    roomid: "battle-jev-smoke",
    turn: 1,
    request,
  });
  assert(actions.some((action) => action.command === choice));
  console.log(`Live Jev smoke choice: ${choice}`);
}

console.log("JevBot tests passed.");
