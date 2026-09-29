import Sim from "npm:pokemon-showdown@0.11.11";
import {
  calculate as calculateDamage,
  Field as CalcField,
  Move as CalcMove,
  Pokemon as CalcPokemon,
} from "npm:@smogon/calc@0.12.0";
import type { BattleSnapshot, Data, Pokemon } from "./types.ts";

import { inferGen9RandomBattleSet } from "./randbats.ts";

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
const CALC_STATS = ["hp", "atk", "def", "spa", "spd", "spe"];
const DEFAULT_RANDBATS_EVS = {
  hp: 85,
  atk: 85,
  def: 85,
  spa: 85,
  spd: 85,
  spe: 85,
};
const DEFAULT_IVS = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };
const CALC_WEATHER = new Map([
  ["sunnyday", "Sun"],
  ["desolateland", "Harsh Sunshine"],
  ["raindance", "Rain"],
  ["primordialsea", "Heavy Rain"],
  ["sandstorm", "Sand"],
  ["snow", "Snow"],
  ["hail", "Hail"],
]);
const CALC_TERRAIN = new Map([
  ["electricterrain", "Electric"],
  ["grassyterrain", "Grassy"],
  ["mistyterrain", "Misty"],
  ["psychicterrain", "Psychic"],
]);

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
  const possibleAbilities =
    inferGen9RandomBattleSet(target)?.possibleAbilities ||
    [];
  const inferredImmunities = possibleAbilities.filter((possibleAbility) =>
    ABILITY_TYPE_IMMUNITIES.get(toID(possibleAbility))?.has(moveType)
  );
  if (
    inferredImmunities.length &&
    inferredImmunities.length === possibleAbilities.length &&
    !ABILITY_BYPASSERS.has(toID(attackerAbility))
  ) {
    return {
      target_types: types,
      type_effectiveness_multiplier: 0,
      type_matchup: `No effect due to inferred ability immunity: ${
        inferredImmunities.join(
          ", ",
        )
      }`,
      inferred_ability_immunity: inferredImmunities,
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
    ...(inferredImmunities.length
      ? {
        possible_ability_immunities: inferredImmunities,
        ability_immunity_caveat:
          "This move may be ineffective if the opponent has one of these possible abilities.",
      }
      : {}),
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

function hasCondition(side?: Data | null, id?: string): boolean {
  return !!conditionById(side?.conditions || [], id);
}

function canonicalCalcName(value: string | null | undefined, dexTable: Data) {
  if (!value) return undefined;
  const entry = dexTable.get(value);
  return entry?.exists ? entry.name : undefined;
}

function hpFromCondition(pokemon?: Pokemon | null): [number, number] | null {
  const [current, maximum] = pokemon?.condition?.split(" ")[0]?.split("/") ||
    [];
  const hp = Number(current);
  const maxHp = Number(maximum);
  return Number.isFinite(hp) && Number.isFinite(maxHp) && maxHp > 0
    ? [hp, maxHp]
    : null;
}

function teraTypeOf(pokemon?: Pokemon | null): string | undefined {
  if (!pokemon?.terastallized) return undefined;
  const teraType = pokemon.teraType ||
    (typeof pokemon.terastallized === "string" ? pokemon.terastallized : null);
  return teraType || undefined;
}

/** Translate observed Showdown state into a calculator Pokemon. */
function toCalcPokemon(pokemon: Pokemon, species: Data, level: number) {
  const calcPokemon = new CalcPokemon(9, species.name, {
    level,
    ability: canonicalCalcName(knownAbility(pokemon), Dex.abilities),
    abilityOn: Boolean(knownAbility(pokemon)),
    item: canonicalCalcName(pokemon.item, Dex.items),
    teraType: teraTypeOf(pokemon) as never,
    status: (statusOf(pokemon) || undefined) as never,
    boosts: pokemon.boosts || {},
    evs: DEFAULT_RANDBATS_EVS,
    ivs: DEFAULT_IVS,
  });
  const suppliedStats = pokemon.stats || {};
  for (const stat of CALC_STATS) {
    const value = Number(suppliedStats[stat]);
    if (Number.isFinite(value) && value > 0) {
      // Private side requests expose exact stats but not the originating EVs
      // and nature. The calculator's public stat fields are authoritative.
      calcPokemon.rawStats[stat] = value;
      calcPokemon.stats[stat] = value;
    }
  }
  const observedHp = hpFromCondition(pokemon);
  if (observedHp) {
    const [currentHp, observedMaxHp] = observedHp;
    const hasPrivateStats = Object.keys(suppliedStats).length > 0;
    if (hasPrivateStats) {
      // The max HP in a private side request is authoritative, even when the
      // request's `stats` object omits an HP entry.
      calcPokemon.rawStats.hp = observedMaxHp;
      calcPokemon.stats.hp = observedMaxHp;
    }
    const maxHp = calcPokemon.maxHP();
    calcPokemon.originalCurHP = Math.max(
      0,
      Math.min(
        maxHp,
        hasPrivateStats
          ? currentHp
          : Math.round(maxHp * currentHp / observedMaxHp),
      ),
    );
  }
  return calcPokemon;
}

function calcSide(side?: Data | null, pokemon?: Pokemon | null): Data {
  const volatiles = new Set(getVolatiles(pokemon));
  return {
    isReflect: hasCondition(side, "reflect"),
    isLightScreen: hasCondition(side, "lightscreen"),
    isAuroraVeil: hasCondition(side, "auroraveil"),
    isTailwind: hasCondition(side, "tailwind"),
    isProtected: volatiles.has("protect") || volatiles.has("maxguard"),
    isCharge: volatiles.has("charge"),
    isHelpingHand: volatiles.has("helpinghand"),
    isPowerTrick: volatiles.has("powertrick"),
  };
}

function toCalcField(
  battleState: BattleSnapshot,
  attackerSide?: Data | null,
  targetSide?: Data | null,
  attacker?: Pokemon | null,
  target?: Pokemon | null,
) {
  const effects = fieldIds(battleState.field);
  const weather = [...effects].map((effect) => CALC_WEATHER.get(effect)).find(
    Boolean,
  );
  const terrain = [...effects].map((effect) => CALC_TERRAIN.get(effect)).find(
    Boolean,
  );
  return new CalcField({
    gameType: "Singles",
    weather: weather as never,
    terrain: terrain as never,
    isGravity: effects.has("gravity"),
    attackerSide: calcSide(attackerSide, attacker),
    defenderSide: calcSide(targetSide, target),
  });
}

/** Calculate Gen 9 damage through @smogon/calc. */
export function estimateBaselineDamage(
  move: Data,
  attacker?: Pokemon | null,
  target?: Pokemon | null,
  battleState: BattleSnapshot = {},
  targetSide: Data | null | undefined = battleState.opponentSide,
  attackerSide: Data | null | undefined = battleState.ownSide,
): Data | null {
  if (!attacker || !target || move.category === "Status") {
    return {
      available: false,
      reason: "Move does not deal direct damage or is missing a battler",
    };
  }
  const attackerLevel = getLevel(attacker);
  const targetLevel = getLevel(target);
  const attackerSpecies = getSpecies(attacker);
  const targetSpecies = getSpecies(target);
  if (!attackerLevel || !targetLevel || !attackerSpecies || !targetSpecies) {
    return { available: false, reason: "Missing level or species data" };
  }
  try {
    const calcAttacker = toCalcPokemon(
      attacker,
      attackerSpecies,
      attackerLevel,
    );
    const calcTarget = toCalcPokemon(target, targetSpecies, targetLevel);
    const result = calculateDamage(
      9,
      calcAttacker,
      calcTarget,
      new CalcMove(9, move.name),
      toCalcField(battleState, attackerSide, targetSide, attacker, target),
    );
    const rolls =
      (Array.isArray(result.damage) ? result.damage : [result.damage])
        .flat(Infinity) as unknown[];
    const numericRolls = rolls
      .filter((damage): damage is number =>
        typeof damage === "number" && Number.isFinite(damage)
      );
    if (!numericRolls.length) {
      return {
        available: false,
        reason: "Calculator returned no damage rolls",
      };
    }
    const minimum = Math.min(...numericRolls);
    const maximum = Math.max(...numericRolls);
    const targetHp = calcTarget.maxHP();
    return {
      available: true,
      calculation_engine: "@smogon/calc",
      estimated_damage_hp_range: [minimum, maximum],
      estimated_damage_percent_range: [
        roundedPercent(minimum * 100 / targetHp),
        roundedPercent(maximum * 100 / targetHp),
      ],
      estimated_target_max_hp: targetHp,
      caveat:
        "Damage uses @smogon/calc Gen 9 mechanics with exact private stats when available and Gen 9 Random Battle default stats otherwise; hidden opponent information remains an assumption.",
    };
  } catch (error) {
    return {
      available: false,
      reason: `Calculator could not estimate this move: ${error.message}`,
    };
  }
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
      battleState.opponentSide,
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
  const [currentHp, maximumHp] = hpFromCondition(target) || [];
  const currentHpPercent = currentHp !== undefined && maximumHp !== undefined
    ? roundedPercent(currentHp * 100 / maximumHp)
    : null;
  const revealedKoThreats = currentHpPercent === null
    ? []
    : revealed.filter((entry) =>
      entry.estimated_damage_percent_range?.[1] >= currentHpPercent
    ).map((entry) => entry.move);
  return {
    revealed_move_damage_estimates: revealed.sort(byMaximumDamage),
    possible_move_damage_estimates: possible.slice(0, 5),
    ...(currentHpPercent === null ? {} : {
      current_hp_percent: currentHpPercent,
      revealed_moves_that_can_ko: revealedKoThreats,
    }),
    ...(unestimated.length
      ? { unestimated_possible_damaging_moves: unestimated }
      : {}),
    caveat:
      "Possible-move estimates are candidate-set possibilities, not confirmed opponent moves.",
  };
}

function lastMoveBy(
  opponent?: Pokemon | null,
  battleState?: BattleSnapshot,
): string | null {
  if (!opponent?.side) return null;
  for (const line of [...(battleState?.recentEvents || [])].reverse()) {
    const parts = line.split("|");
    if (parts[1] === "move" && parts[2]?.startsWith(opponent.side)) {
      return parts[3] || null;
    }
  }
  return null;
}

function revealedRecoveryMoves(opponent?: Pokemon | null): string[] {
  return (opponent?.revealedMoves || opponent?.revealed_moves || []).filter(
    (moveName) => Boolean(Dex.moves.get(String(moveName)).heal),
  );
}

/** Describe the risk and tactical context of staying in to use a move. */
export function describeMoveTactics(
  move: Data,
  attacker: Pokemon,
  opponent: Pokemon | null | undefined,
  battleState: BattleSnapshot,
): Data {
  const warnings = [];
  const boosts = Object.entries(opponent?.boosts || {})
    .filter(([, amount]) => Number(amount) > 0)
    .map(([stat, amount]) => `${stat} +${amount}`);
  if (boosts.length) {
    warnings.push(`Opponent has positive boosts: ${boosts.join(", ")}`);
  }
  const recoveryMoves = revealedRecoveryMoves(opponent);
  if (recoveryMoves.length) {
    warnings.push(
      `Opponent has revealed recovery: ${recoveryMoves.join(", ")}`,
    );
  }

  const result: Data = {
    opponent_threats: describeOpponentThreats(opponent, attacker),
    incoming_damage: describeIncomingDamage(opponent, attacker, battleState),
    ...(warnings.length ? { tactical_warnings: warnings } : {}),
  };
  if (toID(move.id) === "encore") {
    const lastMove = lastMoveBy(opponent, battleState);
    if (lastMove) {
      result.support_opportunity =
        `Encore can force the opponent to repeat its last move: ${lastMove}.`;
    }
    if (toID(knownAbility(attacker)) === "prankster") {
      result.support_priority =
        "Prankster gives this status move +1 priority against non-Dark targets.";
    }
  }
  if (toID(move.id) === "leechseed") {
    result.support_opportunity =
      "Leech Seed creates recurring chip and recovery, which is valuable against a foe with revealed recovery.";
  }
  return result;
}

/** Describe what a switch-in can threaten on the following turn. */
export function describeSwitchOffense(
  pokemon: Pokemon,
  battleState: BattleSnapshot,
): Data {
  const opponent = battleState.opponentActive;
  if (!opponent) return {};
  const damagingMoves = (pokemon.moves || []).flatMap((moveName) => {
    const move = Dex.moves.get(String(moveName));
    if (!move.exists || move.category === "Status") return [];
    const baselineDamage = estimateBaselineDamage(
      move,
      pokemon,
      opponent,
      battleState,
    );
    return [{
      move: move.name,
      type: move.type,
      ...describeMoveMatchup(move.type, opponent, knownAbility(pokemon)),
      baseline_damage: baselineDamage,
    }];
  });
  damagingMoves.sort((left, right) =>
    (right.baseline_damage?.estimated_damage_percent_range?.[1] || 0) -
    (left.baseline_damage?.estimated_damage_percent_range?.[1] || 0)
  );
  const supportMoves = (pokemon.moves || []).flatMap((moveName) => {
    const move = Dex.moves.get(String(moveName));
    return move.exists && move.category === "Status" ? [move.name] : [];
  });
  return {
    next_turn_best_damaging_moves: damagingMoves.slice(0, 3),
    ...(supportMoves.length ? { next_turn_support_moves: supportMoves } : {}),
    next_turn_offense_caveat:
      "These estimates apply after the switch-in survives this turn; the opponent may also switch.",
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
    ...describeSwitchOffense(pokemon, battleState),
  };
}
