function sideOf(ident?: string): string | null {
  return ident?.match(/^(p[1-4])[a-z]?:/)?.[1] || null;
}

function pokemonName(ident?: string): string {
  return ident?.split(": ").at(-1) || ident || "Unknown Pokémon";
}

function ownerName(ident?: string, ownSide?: string | null): string {
  const side = sideOf(ident);
  if (!side) return "";
  if (!ownSide) return side.toUpperCase();
  return side === ownSide ? "You" : "Opponent";
}

function conditionText(condition?: string): string {
  if (!condition) return "";
  return condition.replace(" fnt", " fainted");
}

/** Format an opponent chat message without treating it as a battle event. */
export function formatOpponentChat(
  line: string,
  ownName?: string,
  ownSide?: string | null,
): string | null {
  const parts = line.split("|");
  let speaker: string | undefined;
  let message: string | undefined;
  if (parts[1] === "c") {
    speaker = parts[2];
    message = parts.slice(3).join("|");
  } else if (parts[1] === "c:") {
    speaker = parts[3];
    message = parts.slice(4).join("|");
  } else {
    return null;
  }
  if (!speaker || !message) return null;
  if (
    speaker.toLowerCase() === ownName?.toLowerCase() ||
    speaker === ownSide
  ) return null;
  return `${speaker}: ${message}`;
}

/** Format a battle protocol line for console output. */
export function formatBattleEvent(
  line: string,
  ownSide?: string | null,
): string | null {
  if (!line.startsWith("|")) return null;
  const parts = line.split("|");
  const type = parts[1]?.replace(/^-/, "");
  const ident = parts[2];
  const subject = `${ownerName(ident, ownSide)} ${pokemonName(ident)}`.trim();
  switch (type) {
    case "turn":
      return `── Turn ${parts[2]} ──`;
    case "switch":
    case "drag":
      return `${ownerName(ident, ownSide)} sent out ${
        parts[3]?.split(",")[0]
      } (${conditionText(parts[4])})`;
    case "move":
      return `${subject} used ${parts[3]}`;
    case "damage":
      return `${subject}: ${conditionText(parts[3])}`;
    case "heal":
      return `${subject} recovered to ${conditionText(parts[3])}`;
    case "status":
      return `${subject} was ${parts[3]}`;
    case "curestatus":
      return `${subject} was cured of ${parts[3]}`;
    case "boost":
      return `${subject} ${parts[3]} +${parts[4]}`;
    case "unboost":
      return `${subject} ${parts[3]} -${parts[4]}`;
    case "setboost":
      return `${subject} ${parts[3]} set to ${parts[4]}`;
    case "terastallize":
      return `${subject} Terastallized into ${parts[3]}`;
    case "ability":
      return `${subject} revealed ${parts[3]}`;
    case "item":
      return `${subject} revealed ${parts[3]}`;
    case "enditem":
      return `${subject} lost ${parts[3]}`;
    case "faint":
      return `${subject} fainted`;
    case "sidestart":
      return `${parts[2]?.split(":").at(-1)?.trim() || "A side"}: ${
        parts[3]
      } started`;
    case "sideend":
      return `${parts[2]?.split(":").at(-1)?.trim() || "A side"}: ${
        parts[3]
      } ended`;
    case "weather":
      return parts[2] === "none" ? "Weather cleared" : `Weather: ${parts[2]}`;
    case "fieldstart":
      return `Field: ${parts[2]} started`;
    case "fieldend":
      return `Field: ${parts[2]} ended`;
    case "cant":
      return `${subject} cannot act (${parts[3]})`;
    default:
      return null;
  }
}
