import Sim from "npm:pokemon-showdown@0.11.11";
import type { BattleSnapshot, Data, Pokemon } from "./types.ts";

import { inferGen9RandomBattleSet } from "./local-bot-randbats.ts";

const { Dex } = Sim;

const ABILITY_TYPE_IMMUNITIES = new Map([
  ["levitate", new Set(["Ground"])],
  ["eelevate", new Set(["Ground"])],
  ["flashfire", new Set(["Fire"])],
  ["waterabsorb", new Set(["Water"])],
  ["stormdrain", new Set(["Water"])],
  ["dryskin", new Set(["Water"])],
  ["voltabsorb", new Set(["Electric"])],
  ["lightningrod", new Set(["Electric"])],
  ["motordrive", new Set(["Electric"])],
  ["sapsipper", new Set(["Grass"])],
  ["eartheater", new Set(["Ground"])],
  ["wellbakedbody", new Set(["Fire"])],
]);
const ABILITY_BYPASSERS = new Set(["moldbreaker", "teravolt", "turboblaze"]);
const STATUS_IDS = new Set(["brn", "frz", "par", "psn", "slp", "tox"]);
const SLOW_SPEED_MOVES = new Set(["gyroball", "trickroom"]);

function toID(value?: string | null): string {
  return (value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function getSpecies(pokemon?: Pokemon | null) {
  const speciesName = pokemon?.details?.split(",")[0] || pokemon?.species;
  if (!speciesName) return null;
  const species = Dex.species.get(speciesName);
  return species.exists ? species : null;
}

export function getEffectiveTypes(pokemon?: Pokemon | null): string[] {
  if (!pokemon) return [];
  const teraType = pokemon.teraType ||
    (typeof pokemon.terastallized === "string" ? pokemon.terastallized : null);
  if (pokemon.terastallized && teraType) return [teraType];
  return getSpecies(pokemon)?.types || [];
}

function knownAbility(pokemon?: Pokemon | null): string | null {
  return pokemon?.abilityState
    ? null
    : pokemon?.ability || pokemon?.baseAbility || null;
}

export function describeMoveMatchup(
  moveType: string,
  target?: Pokemon | null,
  attackerAbility: string | null = null,
): Data {
  const types = getEffectiveTypes(target);
  if (!types.length) return {};
  const ability = knownAbility(target);
  const abilityImmune = ability &&
    ABILITY_TYPE_IMMUNITIES.get(toID(ability))?.has(moveType);
  if (abilityImmune && !ABILITY_BYPASSERS.has(toID(attackerAbility))) {
    return {
      target_types: types,
      type_effectiveness_multiplier: 0,
      type_matchup: `No effect due to known ability immunity: ${ability}`,
      known_ability_immunity: ability,
    };
  }
  const multiplier = Dex.getImmunity(moveType, types)
    ? 2 ** Dex.getEffectiveness(moveType, types)
    : 0;
  return {
    target_types: types,
    type_effectiveness_multiplier: multiplier,
    type_matchup: multiplier === 0
      ? "No effect due to type immunity"
      : multiplier > 1
      ? `${multiplier}x super-effective`
      : multiplier < 1
      ? `${multiplier}x resisted`
      : "Neutral",
  };
}

function groundedness(pokemon?: Pokemon | null, field?: Data | null): Data {
  const pseudoWeather = new Set(
    field?.pseudoWeather?.map((effect) => effect.id) || [],
  );
  const volatileEffects = new Set(
    pokemon?.volatileEffects?.map((effect) => effect.id) || [],
  );
  const types = getEffectiveTypes(pokemon);
  const item = toID(pokemon?.item);
  const ability = toID(knownAbility(pokemon));
  if (pseudoWeather.has("gravity")) {
    return { grounded: true, reason: "Gravity" };
  }
  if (
    volatileEffects.has("ingrain") || volatileEffects.has("smackdown") ||
    item === "ironball"
  ) {
    return { grounded: true, reason: "forced grounded" };
  }
  if (volatileEffects.has("magnetrise") || volatileEffects.has("telekinesis")) {
    return { grounded: false, reason: "temporarily airborne" };
  }
  if (types.includes("Flying")) {
    return { grounded: false, reason: "Flying type" };
  }
  if (ability === "levitate" || ability === "eelevate") {
    return { grounded: false, reason: knownAbility(pokemon) };
  }
  if (item === "airballoon") return { grounded: false, reason: "Air Balloon" };
  return { grounded: true, reason: "normally grounded" };
}

function hasStatus(pokemon?: Pokemon | null): boolean {
  if (pokemon?.status) return true;
  return pokemon?.condition?.split(" ").some((token) =>
    STATUS_IDS.has(token)
  ) || false;
}

function conditionById(conditions: Data[] = [], id: string): Data | null {
  return (conditions || []).find((condition) => condition.id === id) || null;
}

function roundedPercent(value: number): number {
  return Math.round(value * 10) / 10;
}

function getLevel(pokemon?: Pokemon | null): number {
  if (!pokemon) return null;
  const inferredLevel = inferGen9RandomBattleSet(pokemon)?.level;
  if (inferredLevel) return inferredLevel;
  const matchedLevel = pokemon?.details?.match(/, L(\d+)/)?.[1];
  return matchedLevel ? Number(matchedLevel) : null;
}

function calculateStat(base: number, level: number, ev = 85, iv = 31): number {
  return Math.floor((2 * base + iv + Math.floor(ev / 4)) * level / 100) + 5;
}

function calculateHp(base: number, level: number, ev = 85, iv = 31): number {
  return Math.floor((2 * base + iv + Math.floor(ev / 4)) * level / 100) +
    level + 10;
}

function knownMaxHp(pokemon?: Pokemon | null): number | null {
  if (!pokemon?.stats) return null;
  const maxHp = Number(pokemon.condition?.split(" ")[0]?.split("/")[1]);
  return Number.isFinite(maxHp) && maxHp > 0 ? maxHp : null;
}

function applyBoost(stat: number, boost = 0): number {
  if (boost >= 0) return Math.floor(stat * (2 + boost) / 2);
  return Math.floor(stat * 2 / (2 - boost));
}

function statusOf(pokemon?: Pokemon | null): string | null {
  if (pokemon?.status) return pokemon.status;
  return pokemon?.condition?.split(" ").find((token) =>
    STATUS_IDS.has(token)
  ) || null;
}

function getVolatiles(pokemon?: Pokemon | null): string[] {
  return [
    ...new Set(pokemon?.volatileEffects?.map((effect) => effect.id) || []),
  ];
}

function fieldIds(field?: Data | null): Set<string> {
  return new Set([
    ...(field?.pseudoWeather?.map((effect) => effect.id) || []),
    toID(field?.weather),
    toID(field?.terrain),
  ].filter(Boolean));
}

function getSpeedModifier(pokemon?: Pokemon | null, field?: Data | null): Data {
  let modifier = 1;
  const sources = [];
  const item = toID(pokemon?.item);
  const ability = toID(knownAbility(pokemon));
  const effects = fieldIds(field);
  if (item === "choicescarf") {
    modifier *= 1.5;
    sources.push("Choice Scarf");
  }
  if (item === "ironball") {
    modifier *= 0.5;
    sources.push("Iron Ball");
  }
  if (
    (ability === "chlorophyll" &&
      (effects.has("sunnyday") || effects.has("desolateland"))) ||
    (ability === "swiftswim" &&
      (effects.has("raindance") || effects.has("primordialsea"))) ||
    (ability === "sandrush" && effects.has("sandstorm")) ||
    (ability === "slushrush" && effects.has("snow")) ||
    (ability === "surgesurfer" && effects.has("electricterrain"))
  ) {
    modifier *= 2;
    sources.push(`${knownAbility(pokemon)} active`);
  }
  if (statusOf(pokemon) === "par") {
    modifier *= 0.5;
    sources.push("paralysis");
  }
  return { modifier, sources };
}

function estimateCurrentSpeed(
  pokemon?: Pokemon | null,
  field?: Data | null,
): Data | null {
  const species = getSpecies(pokemon);
  const level = getLevel(pokemon);
  if (!species || !level) return null;
  const raw = pokemon?.stats?.spe ||
    calculateStat(species.baseStats.spe, level);
  const boosted = applyBoost(raw, pokemon?.boosts?.spe || 0);
  const modifier = getSpeedModifier(pokemon, field);
  return {
    speed: Math.floor(boosted * modifier.modifier),
    sources: modifier.sources,
    raw,
  };
}

/** Estimate speed order. */
export function describeSpeedComparison(
  ownPokemon?: Pokemon | null,
  opponent?: Pokemon | null,
  field?: Data | null,
): Data | null {
  const own = estimateCurrentSpeed(ownPokemon, field);
  const opponentSpeed = estimateCurrentSpeed(opponent, field);
  if (!own || !opponentSpeed) return null;
  const opponentInference = inferGen9RandomBattleSet(opponent);
  const opponentSpecies = getSpecies(opponent);
  const opponentLevel = getLevel(opponent);
  const mayUseSlowSet = opponentInference?.possibleMoves.some((move) =>
    SLOW_SPEED_MOVES.has(toID(move))
  );
  const slowSetSpeed = mayUseSlowSet && opponentSpecies && opponentLevel
    ? applyBoost(
      calculateStat(opponentSpecies.baseStats.spe, opponentLevel, 0, 0),
      opponent?.boosts?.spe || 0,
    )
    : null;
  const relation = own.speed > opponentSpeed.speed
    ? "likely faster"
    : own.speed < opponentSpeed.speed
    ? "likely slower"
    : "speed tie on the default stat line";
  return {
    own_current_speed: own.speed,
    opponent_default_current_speed: opponentSpeed.speed,
    ...(slowSetSpeed === null
      ? {}
      : { opponent_possible_slow_set_speed: slowSetSpeed }),
    speed_order: relation,
    own_speed_modifiers: own.sources,
    opponent_known_speed_modifiers: opponentSpeed.sources,
    caveat:
      "Opponent default speed uses Gen 9 Random Battle 85 EV/31 IV neutral stats; unrevealed items, abilities, and sets can change it.",
  };
}

function stabModifier(pokemon?: Pokemon | null, moveType?: string): number {
  const species = getSpecies(pokemon);
  const baseTypes = species?.types || [];
  const teraType = pokemon?.teraType ||
    (typeof pokemon?.terastallized === "string" ? pokemon.terastallized : null);
  if (pokemon?.terastallized && teraType && toID(teraType) !== "stellar") {
    if (moveType === teraType) return baseTypes.includes(moveType) ? 2 : 1.5;
    return baseTypes.includes(moveType) ? 1.5 : 1;
  }
  return baseTypes.includes(moveType) ? 1.5 : 1;
}

function hasCondition(side?: Data | null, id?: string): boolean {
  return !!conditionById(side?.conditions || [], id);
}

function damageAbilityModifier(
  pokemon: Pokemon | null | undefined,
  move: Data,
  attacking: boolean,
): number {
  const ability = toID(knownAbility(pokemon));
  if (attacking) {
    if (
      move.category === "Physical" &&
      (ability === "hugepower" || ability === "purepower")
    ) return 2;
    if (
      move.category === "Physical" && ability === "guts" && statusOf(pokemon)
    ) return 1.5;
    if (
      move.category === "Special" && ability === "flareboost" &&
      statusOf(pokemon) === "brn"
    ) return 1.5;
    return 1;
  }
  if (move.category === "Physical" && ability === "furcoat") return 0.5;
  if (move.category === "Special" && ability === "icescales") return 0.5;
  if (["Fire", "Ice"].includes(move.type) && ability === "thickfat") return 0.5;
  if (ability === "fluffy") {
    return (move.flags?.contact ? 0.5 : 1) * (move.type === "Fire" ? 2 : 1);
  }
  const hp = pokemon?.condition?.split(" ")[0]?.split("/");
  if (ability === "multiscale" && hp?.[0] === hp?.[1]) return 0.5;
  return 1;
}

/** Estimate damage without a full battle simulation. */
export function estimateBaselineDamage(
  move: Data,
  attacker?: Pokemon | null,
  target?: Pokemon | null,
  battleState: BattleSnapshot = {},
  targetSide: Data | null | undefined = battleState.opponentSide,
): Data | null {
  if (
    !target || move.category === "Status" || !move.basePower ||
    move.basePowerCallback || move.damage || move.ohko ||
    move.id === "terablast" || move.overrideOffensiveStat ||
    move.overrideDefensiveStat ||
    move.overrideOffensivePokemon || move.overrideDefensivePokemon
  ) {
    return {
      available: false,
      reason: "Move has no fixed direct base power for a baseline estimate",
    };
  }
  const matchup = describeMoveMatchup(
    move.type,
    target,
    knownAbility(attacker),
  );
  if (matchup.type_effectiveness_multiplier === 0) {
    return {
      available: true,
      estimated_damage_percent_range: [0, 0],
      reason: matchup.type_matchup,
    };
  }
  const attackerLevel = getLevel(attacker);
  const targetLevel = getLevel(target);
  const attackerSpecies = getSpecies(attacker);
  const targetSpecies = getSpecies(target);
  if (!attackerLevel || !targetLevel || !attackerSpecies || !targetSpecies) {
    return { available: false, reason: "Missing level or species data" };
  }
  const stat = move.category === "Physical" ? "atk" : "spa";
  const defenseStat = move.category === "Physical" ? "def" : "spd";
  const attackerRawStat = attacker?.stats?.[stat] ||
    calculateStat(attackerSpecies.baseStats[stat], attackerLevel);
  const attack = applyBoost(attackerRawStat, attacker?.boosts?.[stat] || 0);
  const targetRawDefense = target?.stats?.[defenseStat] ||
    calculateStat(targetSpecies.baseStats[defenseStat], targetLevel);
  const targetDefense = applyBoost(
    targetRawDefense,
    target?.boosts?.[defenseStat] || 0,
  );
  const targetHp = knownMaxHp(target) ||
    calculateHp(targetSpecies.baseStats.hp, targetLevel);
  let modifier = stabModifier(attacker, move.type) *
    matchup.type_effectiveness_multiplier;
  const attackerItem = toID(attacker?.item);
  const targetItem = toID(target?.item);
  if (attackerItem === "lifeorb") modifier *= 1.3;
  if (attackerItem === "choiceband" && move.category === "Physical") {
    modifier *= 1.5;
  }
  if (attackerItem === "choicespecs" && move.category === "Special") {
    modifier *= 1.5;
  }
  if (targetItem === "assaultvest" && move.category === "Special") {
    modifier /= 1.5;
  }
  if (targetItem === "eviolite") modifier /= 1.5;
  modifier *= damageAbilityModifier(attacker, move, true);
  modifier *= damageAbilityModifier(target, move, false);
  if (
    statusOf(attacker) === "brn" && move.category === "Physical" &&
    toID(knownAbility(attacker)) !== "guts" && move.id !== "facade"
  ) {
    modifier *= 0.5;
  }
  const effects = fieldIds(battleState.field);
  if (
    (effects.has("sunnyday") || effects.has("desolateland")) &&
    move.type === "Fire"
  ) modifier *= 1.5;
  if (
    (effects.has("sunnyday") || effects.has("desolateland")) &&
    move.type === "Water"
  ) modifier *= 0.5;
  if (
    (effects.has("raindance") || effects.has("primordialsea")) &&
    move.type === "Water"
  ) modifier *= 1.5;
  if (
    (effects.has("raindance") || effects.has("primordialsea")) &&
    move.type === "Fire"
  ) modifier *= 0.5;
  if (
    effects.has("sandstorm") && move.category === "Special" &&
    getEffectiveTypes(target).includes("Rock")
  ) modifier *= 2 / 3;
  if (
    effects.has("snow") && move.category === "Physical" &&
    getEffectiveTypes(target).includes("Ice")
  ) modifier *= 2 / 3;
  if (
    (move.category === "Physical" &&
      (hasCondition(targetSide, "reflect") ||
        hasCondition(targetSide, "auroraveil"))) ||
    (move.category === "Special" &&
      (hasCondition(targetSide, "lightscreen") ||
        hasCondition(targetSide, "auroraveil")))
  ) {
    modifier *= 0.5;
  }
  const baseDamage = Math.floor(
    Math.floor(
      Math.floor(
        (2 * attackerLevel / 5 + 2) * move.basePower * attack / targetDefense,
      ) / 50,
    ),
  ) + 2;
  const maximum = Math.max(1, Math.floor(baseDamage * modifier));
  const minimum = Math.max(1, Math.floor(maximum * 0.85));
  return {
    available: true,
    estimated_damage_hp_range: [minimum, maximum],
    estimated_damage_percent_range: [
      roundedPercent(minimum * 100 / targetHp),
      roundedPercent(maximum * 100 / targetHp),
    ],
    estimated_target_max_hp: targetHp,
    caveat:
      "Baseline estimate uses exact private stats when available and default Gen 9 Random Battle stats otherwise; it excludes unrevealed modifiers, dynamic move power, critical hits, and full simulator-only effects.",
  };
}

export function describeIncomingDamage(
  opponent: Pokemon | null | undefined,
  target: Pokemon,
  battleState: BattleSnapshot,
): Data | null {
  if (!opponent) return null;
  const inference = inferGen9RandomBattleSet(opponent);
  const revealedMoveIds = new Set(
    (opponent.revealedMoves || opponent.revealed_moves || []).map(toID),
  );
  const possibleMoves = inference?.possibleMoves || [...revealedMoveIds];
  const revealed = [];
  const possible = [];
  const unestimated = [];
  for (const moveName of possibleMoves) {
    const move = Dex.moves.get(String(moveName));
    if (!move.exists || move.category === "Status") continue;
    const estimate = estimateBaselineDamage(
      move,
      opponent,
      target,
      battleState,
      battleState.ownSide,
    );
    if (!estimate.available) {
      if (unestimated.length < 6) unestimated.push(move.name);
      continue;
    }
    const entry = { move: move.name, ...estimate };
    if (revealedMoveIds.has(move.id)) revealed.push(entry);
    else possible.push(entry);
  }
  const byMaximumDamage = (left, right) =>
    (right.estimated_damage_percent_range?.[1] || 0) -
    (left.estimated_damage_percent_range?.[1] || 0);
  possible.sort(byMaximumDamage);
  return {
    revealed_move_damage_estimates: revealed.sort(byMaximumDamage),
    possible_move_damage_estimates: possible.slice(0, 5),
    ...(unestimated.length
      ? { unestimated_possible_damaging_moves: unestimated }
      : {}),
    caveat:
      "Possible-move estimates are candidate-set possibilities, not confirmed opponent moves.",
  };
}

/** Describe entry hazards. */
export function describeEntryHazards(
  pokemon: Pokemon,
  ownSide?: Data | null,
  field?: Data | null,
): Data {
  const conditions = ownSide?.conditions || [];
  const hasHazards = ["stealthrock", "spikes", "toxicspikes", "stickyweb"]
    .some((id) => conditionById(conditions, id));
  if (!hasHazards) {
    return { entry_hazard_hp_loss_percent: 0, entry_hazard_effects: [] };
  }

  if (toID(pokemon.item) === "heavydutyboots") {
    return {
      entry_hazard_hp_loss_percent: 0,
      entry_hazard_effects: [
        "Heavy-Duty Boots prevent all entry-hazard effects",
      ],
      hazards_prevented_by_heavy_duty_boots: true,
    };
  }

  const effects = [];
  let hpLossPercent = 0;
  const types = getEffectiveTypes(pokemon);
  const stealthRock = conditionById(conditions, "stealthrock");
  if (stealthRock && types.length) {
    const multiplier = Dex.getImmunity("Rock", types)
      ? 2 ** Dex.getEffectiveness("Rock", types)
      : 0;
    const percent = 12.5 * multiplier;
    hpLossPercent += percent;
    effects.push(`Stealth Rock: ${roundedPercent(percent)}% HP`);
  }

  const grounded = groundedness(pokemon, field);
  const spikes = conditionById(conditions, "spikes");
  if (spikes && grounded.grounded) {
    const layers = Math.min(3, spikes.layers || 1);
    const percent = [0, 12.5, 100 / 6, 25][layers];
    hpLossPercent += percent;
    effects.push(
      `Spikes (${layers} layer${layers === 1 ? "" : "s"}): ${
        roundedPercent(percent)
      }% HP`,
    );
  }

  const toxicSpikes = conditionById(conditions, "toxicspikes");
  if (toxicSpikes && grounded.grounded) {
    if (types.includes("Poison")) {
      effects.push("Toxic Spikes: absorbs the hazard on entry");
    } else if (types.includes("Steel") || hasStatus(pokemon)) {
      effects.push("Toxic Spikes: no additional status");
    } else {
      const status = (toxicSpikes.layers || 1) >= 2
        ? "badly poisoned"
        : "poisoned";
      effects.push(
        `Toxic Spikes: becomes ${status} unless an ability prevents it`,
      );
    }
  }

  if (conditionById(conditions, "stickyweb") && grounded.grounded) {
    effects.push("Sticky Web: -1 Speed stage");
  }
  return {
    entry_hazard_hp_loss_percent: roundedPercent(hpLossPercent),
    entry_hazard_effects: effects,
    grounded: grounded.grounded,
    grounded_reason: grounded.reason,
  };
}

export function describeOpponentThreats(
  opponent: Pokemon | null | undefined,
  target: Pokemon,
): Data | null {
  if (!opponent) return null;
  const inference = inferGen9RandomBattleSet(opponent);
  const revealedMoves = new Set(
    opponent.revealedMoves || opponent.revealed_moves || [],
  );
  const possibleMoves = inference?.possibleMoves || [...revealedMoves];
  const knownSuperEffectiveMoves = [];
  const possibleSuperEffectiveMoves = [];
  const possiblePriorityMoves = [];

  for (const moveName of possibleMoves) {
    const move = Dex.moves.get(String(moveName));
    if (!move.exists || move.category === "Status" || move.id === "terablast") {
      continue;
    }
    const matchup = describeMoveMatchup(
      move.type,
      target,
      knownAbility(opponent),
    );
    const label = `${move.name} (${matchup.type_matchup})`;
    if (move.priority > 0) possiblePriorityMoves.push(move.name);
    if (matchup.type_effectiveness_multiplier > 1) {
      if (revealedMoves.has(moveName)) knownSuperEffectiveMoves.push(label);
      else possibleSuperEffectiveMoves.push(label);
    }
  }
  return {
    known_super_effective_moves: [...new Set(knownSuperEffectiveMoves)],
    possible_super_effective_moves: [...new Set(possibleSuperEffectiveMoves)]
      .slice(0, 8),
    possible_priority_moves: [...new Set(possiblePriorityMoves)].slice(0, 8),
    possible_tera_blast: possibleMoves.some((move) =>
      toID(move) === "terablast"
    ),
  };
}

export function describeSwitchTactics(
  pokemon: Pokemon,
  battleState: BattleSnapshot,
): Data {
  return {
    ...describeEntryHazards(pokemon, battleState.ownSide, battleState.field),
    speed_comparison: describeSpeedComparison(
      pokemon,
      battleState.opponentActive,
      battleState.field,
    ),
    opponent_threats: describeOpponentThreats(
      battleState.opponentActive,
      pokemon,
    ),
    incoming_damage: describeIncomingDamage(
      battleState.opponentActive,
      pokemon,
      battleState,
    ),
  };
}
