import type { BattleSnapshot, Data, Pokemon } from "./types.ts";

const TRACKED_EVENT_TYPES = new Set([
  "ability",
  "boost",
  "cant",
  "clearallboost",
  "clearboost",
  "clearnegativeboost",
  "clearpositiveboost",
  "copyboost",
  "crit",
  "curestatus",
  "damage",
  "detailschange",
  "drag",
  "end",
  "endability",
  "enditem",
  "faint",
  "fieldend",
  "fieldstart",
  "formechange",
  "heal",
  "immune",
  "invertboost",
  "item",
  "move",
  "mustrecharge",
  "prepare",
  "replace",
  "resisted",
  "setboost",
  "sethp",
  "sidestart",
  "sideend",
  "start",
  "status",
  "supereffective",
  "swapboost",
  "swapsideconditions",
  "switch",
  "terastallize",
  "turn",
  "unboost",
  "upkeep",
  "weather",
]);

const STATUS_IDS = new Set(["brn", "frz", "par", "psn", "slp", "tox"]);
const HAZARD_LAYER_LIMITS = new Map([
  ["spikes", 3],
  ["toxicspikes", 2],
  ["stealthrock", 1],
  ["stickyweb", 1],
]);

function toID(value?: string): string {
  return (value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function sideOf(ident?: string): string | null {
  return ident?.match(/^(p[1-4])[a-z]?:/)?.[1] ||
    ident?.match(/^(p[1-4])(?::|$)/)?.[1] || null;
}

function getConditionStatus(condition?: string): string | undefined {
  const tokens = condition?.split(" ") || [];
  return tokens.find((token) => STATUS_IDS.has(token));
}

function isFainted(condition?: string): boolean {
  return condition?.split(" ").includes("fnt") ||
    condition?.startsWith("0 fnt") || false;
}

function effectName(effect?: string): string {
  return (effect || "").replace(/^(?:ability|item|move): /, "");
}

function effectId(effect?: string): string {
  return toID(effectName(effect));
}

function mapValues<T>(map: Map<string, T>): T[] {
  return [...map.values()];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/** Track battle state. */
export class BattleStateTracker {
  maxEvents: number;
  battles = new Map<string, Data>();
  constructor({ maxEvents = 80 }: { maxEvents?: number } = {}) {
    this.maxEvents = maxEvents;
    this.battles = new Map();
  }

  observe(roomid: string, line: string): void {
    if (!roomid || !line.startsWith("|")) return;
    const parts = line.split("|");
    const type = parts[1]?.replace(/^-/, "");
    if (!TRACKED_EVENT_TYPES.has(type)) return;

    const battle = this.getBattle(roomid);
    battle.events.push(line);
    if (battle.events.length > this.maxEvents) {
      battle.events.splice(0, battle.events.length - this.maxEvents);
    }
    this.updateBattle(battle, type, parts);
  }

  getSnapshot(roomid: string, ownSide: string): BattleSnapshot {
    const battle = this.battles.get(roomid);
    if (!battle) return this.emptySnapshot();

    const sides = new Set([
      ...battle.sides.keys(),
      ...[...battle.pokemon.values()].map((pokemon) => pokemon.side),
    ]);
    const opponentSideId =
      [...sides].find((side) => side && side !== ownSide) || null;
    const own = ownSide ? this.buildSideSnapshot(battle, ownSide) : null;
    const opponent = opponentSideId
      ? this.buildSideSnapshot(battle, opponentSideId)
      : null;
    return {
      turn: battle.turn,
      ownSide: own,
      opponentSide: opponent,
      field: {
        weather: battle.field.weather,
        terrain: battle.field.terrain,
        pseudoWeather: mapValues(battle.field.pseudoWeather).map(clone),
      },
      recentEvents: [...battle.events],
      opponentActive: opponent?.active || null,
    };
  }

  emptySnapshot(): BattleSnapshot {
    return {
      turn: 0,
      ownSide: null,
      opponentSide: null,
      field: { weather: null, terrain: null, pseudoWeather: [] },
      recentEvents: [],
      opponentActive: null,
    };
  }

  clear(roomid: string): void {
    this.battles.delete(roomid);
  }

  getBattle(roomid: string): Data {
    let battle = this.battles.get(roomid);
    if (!battle) {
      battle = {
        events: [],
        turn: 0,
        pokemon: new Map(),
        activeBySide: new Map(),
        sides: new Map(),
        field: { weather: null, terrain: null, pseudoWeather: new Map() },
      };
      this.battles.set(roomid, battle);
    }
    return battle;
  }

  getSide(battle: Data, side: string): Data {
    let sideState = battle.sides.get(side);
    if (!sideState) {
      sideState = { id: side, conditions: new Map(), terastallized: false };
      battle.sides.set(side, sideState);
    }
    return sideState;
  }

  getPokemon(battle: Data, ident?: string): Pokemon | null {
    const side = sideOf(ident);
    if (!side) return null;
    let pokemon = battle.pokemon.get(ident);
    if (!pokemon) {
      pokemon = {
        ident,
        side,
        active: false,
        condition: null,
        fainted: false,
        revealedMoves: [],
        boosts: {},
        volatileEffects: [],
      };
      battle.pokemon.set(ident, pokemon);
    }
    this.getSide(battle, side);
    return pokemon;
  }

  setCondition(pokemon: Pokemon, condition?: string): void {
    if (!condition) return;
    pokemon.condition = condition;
    pokemon.fainted = isFainted(condition);
    const status = getConditionStatus(condition);
    if (status) pokemon.status = status;
    else if (pokemon.fainted) delete pokemon.status;
  }

  activatePokemon(battle: Data, pokemon: Pokemon): void {
    const previousIdent = battle.activeBySide.get(pokemon.side);
    if (previousIdent && previousIdent !== pokemon.ident) {
      const previous = battle.pokemon.get(previousIdent);
      if (previous) {
        previous.active = false;
        previous.boosts = {};
        previous.volatileEffects = [];
      }
    }
    pokemon.active = true;
    pokemon.boosts = {};
    pokemon.volatileEffects = [];
    battle.activeBySide.set(pokemon.side, pokemon.ident);
  }

  updateBattle(battle: Data, type: string, parts: string[]): void {
    if (type === "turn") {
      battle.turn = Number(parts[2]) || battle.turn;
      return;
    }
    if (type === "weather") {
      battle.field.weather = effectId(parts[2]) === "none"
        ? null
        : effectName(parts[2]);
      return;
    }
    if (type === "fieldstart" || type === "fieldend") {
      this.updateFieldCondition(battle, type, parts[2]);
      return;
    }
    if (type === "sidestart" || type === "sideend") {
      this.updateSideCondition(battle, type, parts[2], parts[3]);
      return;
    }
    if (type === "swapsideconditions") {
      this.swapSideConditions(battle);
      return;
    }
    if (type === "clearallboost") {
      for (const pokemon of battle.pokemon.values()) pokemon.boosts = {};
      return;
    }

    const ident = parts[2];
    const pokemon = this.getPokemon(battle, ident);
    if (!pokemon) return;

    if (type === "switch" || type === "drag") {
      pokemon.details = parts[3];
      this.setCondition(pokemon, parts[4]);
      this.activatePokemon(battle, pokemon);
      return;
    }
    if (type === "replace") {
      pokemon.details = parts[3] || pokemon.details;
      this.setCondition(pokemon, parts[4]);
      pokemon.active = true;
      battle.activeBySide.set(pokemon.side, pokemon.ident);
      return;
    }
    if (type === "detailschange") {
      pokemon.details = parts[3] || pokemon.details;
      return;
    }
    if (type === "formechange") {
      pokemon.forme = parts[3];
      pokemon.details = this.replaceSpecies(pokemon.details, parts[3]);
      return;
    }
    if (["damage", "heal", "sethp"].includes(type)) {
      this.setCondition(pokemon, parts[3]);
      return;
    }
    if (type === "status") {
      pokemon.status = parts[3];
      return;
    }
    if (type === "curestatus") {
      if (!parts[3] || pokemon.status === parts[3]) delete pokemon.status;
      return;
    }
    if (type === "move") {
      if (parts[3] && !pokemon.revealedMoves.includes(parts[3])) {
        pokemon.revealedMoves.push(parts[3]);
      }
      return;
    }
    if (type === "ability") {
      pokemon.ability = parts[3];
      return;
    }
    if (type === "immune") {
      const ability = parts.slice(3).join("|").match(/ability: ([^|]+)/i)?.[1];
      if (ability) pokemon.ability = ability.trim();
      return;
    }
    if (type === "endability") {
      pokemon.abilityState = "suppressed or removed";
      return;
    }
    if (type === "item") {
      pokemon.item = parts[3];
      pokemon.itemState = "held";
      return;
    }
    if (type === "enditem") {
      pokemon.item = null;
      pokemon.itemState = `${parts[3]} (consumed or removed)`;
      return;
    }
    if (type === "terastallize") {
      pokemon.teraType = parts[3];
      pokemon.terastallized = true;
      this.getSide(battle, pokemon.side).terastallized = true;
      return;
    }
    if (type === "faint") {
      this.setCondition(pokemon, "0 fnt");
      return;
    }
    if (type === "boost" || type === "unboost" || type === "setboost") {
      this.updateBoost(pokemon, type, parts[3], Number(parts[4]));
      return;
    }
    if (type === "swapboost") {
      this.swapBoosts(
        battle,
        pokemon,
        this.getPokemon(battle, parts[3]),
        parts[4],
      );
      return;
    }
    if (type === "invertboost") {
      for (const stat of Object.keys(pokemon.boosts)) {
        pokemon.boosts[stat] *= -1;
      }
      return;
    }
    if (type === "clearboost") {
      pokemon.boosts = {};
      return;
    }
    if (type === "clearpositiveboost" || type === "clearnegativeboost") {
      const clearPositive = type === "clearpositiveboost";
      for (
        const [stat, amount] of Object.entries(
          pokemon.boosts as Record<string, number>,
        )
      ) {
        if ((clearPositive && amount > 0) || (!clearPositive && amount < 0)) {
          delete pokemon.boosts[stat];
        }
      }
      return;
    }
    if (type === "copyboost") {
      const target = this.getPokemon(battle, parts[3]);
      if (target) target.boosts = { ...pokemon.boosts };
      return;
    }
    if (type === "start" || type === "end") {
      this.updateVolatile(pokemon, type, parts[3]);
    }
  }

  replaceSpecies(details?: string, species?: string): string | undefined {
    if (!species) return details;
    if (!details) return species;
    return `${species}${
      details.includes(",") ? details.slice(details.indexOf(",")) : ""
    }`;
  }

  updateBoost(pokemon: Pokemon, type: string, stat?: string, amount = 0): void {
    if (!stat || !Number.isFinite(amount)) return;
    const previous = pokemon.boosts[stat] || 0;
    const next = type === "setboost"
      ? amount
      : previous + (type === "unboost" ? -amount : amount);
    if (next) pokemon.boosts[stat] = Math.max(-6, Math.min(6, next));
    else delete pokemon.boosts[stat];
  }

  swapBoosts(
    _battle: Data,
    source: Pokemon,
    target: Pokemon | null,
    stats?: string,
  ): void {
    if (!target) return;
    for (const stat of (stats || "").split(",").filter(Boolean)) {
      const sourceBoost = source.boosts[stat] || 0;
      const targetBoost = target.boosts[stat] || 0;
      if (targetBoost) source.boosts[stat] = targetBoost;
      else delete source.boosts[stat];
      if (sourceBoost) target.boosts[stat] = sourceBoost;
      else delete target.boosts[stat];
    }
  }

  updateVolatile(pokemon: Pokemon, type: string, effect?: string): void {
    const id = effectId(effect);
    if (!id || /^(ability|item):/.test(effect || "")) return;
    if (type === "start") {
      if (!pokemon.volatileEffects.some((volatile) => volatile.id === id)) {
        pokemon.volatileEffects.push({ id, name: effectName(effect) });
      }
    } else {
      pokemon.volatileEffects = pokemon.volatileEffects.filter((volatile) =>
        volatile.id !== id
      );
    }
  }

  updateFieldCondition(battle: Data, type: string, condition?: string): void {
    const id = effectId(condition);
    if (!id) return;
    const name = effectName(condition);
    if (type === "fieldstart") {
      battle.field.pseudoWeather.set(id, {
        id,
        name,
        startedTurn: battle.turn,
      });
      if (id.endsWith("terrain")) battle.field.terrain = name;
    } else {
      battle.field.pseudoWeather.delete(id);
      if (battle.field.terrain && effectId(battle.field.terrain) === id) {
        battle.field.terrain = null;
      }
    }
  }

  updateSideCondition(
    battle: Data,
    type: string,
    side?: string,
    condition?: string,
  ): void {
    const sideId = sideOf(side);
    const id = effectId(condition);
    if (!sideId || !id) return;
    const sideState = this.getSide(battle, sideId);
    if (type === "sideend") {
      sideState.conditions.delete(id);
      return;
    }
    const layerLimit = HAZARD_LAYER_LIMITS.get(id);
    const existing = sideState.conditions.get(id);
    sideState.conditions.set(id, {
      id,
      name: effectName(condition),
      startedTurn: existing?.startedTurn ?? battle.turn,
      ...(layerLimit
        ? { layers: Math.min(layerLimit, (existing?.layers || 0) + 1) }
        : {}),
    });
  }

  swapSideConditions(battle: Data): void {
    const sides = [...battle.sides.values()];
    if (sides.length !== 2) return;
    const [first, second] = sides;
    const conditions = first.conditions;
    first.conditions = second.conditions;
    second.conditions = conditions;
  }

  buildSideSnapshot(battle: Data, side: string): Data {
    const sideState = this.getSide(battle, side);
    const team = [...battle.pokemon.values()]
      .filter((pokemon) => pokemon.side === side)
      .map((pokemon) => clone(pokemon));
    const activeIdent = battle.activeBySide.get(side);
    const active = activeIdent
      ? team.find((pokemon) => pokemon.ident === activeIdent) || null
      : null;
    return {
      id: side,
      active,
      team,
      conditions: mapValues(sideState.conditions).map(clone),
      terastallized: sideState.terastallized,
      remainingPokemon: team.filter((pokemon) => !pokemon.fainted).length,
      faintedPokemon: team.filter((pokemon) => pokemon.fainted).length,
    };
  }
}
