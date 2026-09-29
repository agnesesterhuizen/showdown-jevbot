import { assert, assertEquals, assertRejects } from "jsr:@std/assert";

import { generateLegalActions } from "../src/actions.ts";
import {
  buildJevRequest,
  formatDecisionSummary,
  JevDecisionModel,
} from "../src/jev.ts";
import { formatBattleEvent } from "../src/battle-log.ts";
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
  estimateBaselineDamage,
} from "../src/tactics.ts";

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
  tacticalPayload.state.legal_actions.find((action) => action.id === "move_1")
    .incoming_damage,
  undefined,
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
