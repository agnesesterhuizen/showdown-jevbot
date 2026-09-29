import randomSets from "npm:pokemon-showdown@0.11.11/data/random-battles/gen9/sets.json" with {
  type: "json",
};
import type { Pokemon } from "./types.ts";

function toID(value?: string | null): string {
  return (value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function uniqueStrings(values: unknown[]): string[] {
  return [
    ...new Set(
      values.filter((value): value is string =>
        typeof value === "string" && Boolean(value)
      ),
    ),
  ];
}

function getSpeciesName(pokemon: Pokemon): string | null {
  if (pokemon.species) return pokemon.species;
  if (pokemon.details) return pokemon.details.split(",")[0];
  return pokemon.ident?.split(": ").at(-1) || null;
}

function containsAll(values: string[], candidates: string[]): boolean {
  const candidateIds = new Set(candidates.map(toID));
  return values.every((value) => candidateIds.has(toID(value)));
}

/** Infer possible Gen 9 Random Battle sets. */
export function inferGen9RandomBattleSet(pokemon: Pokemon) {
  const species = getSpeciesName(pokemon);
  const speciesData = randomSets[toID(species)];
  if (!speciesData) return null;

  const revealedMoves = uniqueStrings(
    pokemon.revealedMoves || pokemon.revealed_moves || [],
  );
  const revealedAbility = pokemon.ability || null;
  const revealedTeraType = pokemon.terastallized
    ? (pokemon.teraType ||
      (typeof pokemon.terastallized === "string"
        ? pokemon.terastallized
        : null))
    : null;
  const roles = speciesData.sets || [];
  const matchingRoles = roles.filter((role) =>
    containsAll(revealedMoves, role.movepool || []) &&
    (!revealedAbility ||
      (role.abilities || []).some((ability) =>
        toID(ability) === toID(revealedAbility)
      )) &&
    (!revealedTeraType ||
      (role.teraTypes || []).some((teraType) =>
        toID(teraType) === toID(revealedTeraType)
      ))
  );
  const inferenceMismatch = !matchingRoles.length &&
    Boolean(revealedMoves.length || revealedAbility || revealedTeraType);
  const candidates = matchingRoles.length ? matchingRoles : roles;

  return {
    species,
    level: speciesData.level || null,
    revealedMoves,
    revealedAbility,
    revealedTeraType,
    possibleRoles: candidates.map((role) => role.role),
    possibleMoves: uniqueStrings(
      candidates.flatMap((role) => role.movepool || []),
    ),
    possibleAbilities: uniqueStrings(
      candidates.flatMap((role) => role.abilities || []),
    ),
    possibleTeraTypes: uniqueStrings(
      candidates.flatMap((role) => role.teraTypes || []),
    ),
    inferenceMismatch,
  };
}

export function addGen9RandomBattleInference(team: Pokemon[]): Pokemon[] {
  return (team || []).map((pokemon) => ({
    ...pokemon,
    randomBattleSet: inferGen9RandomBattleSet(pokemon),
  }));
}
