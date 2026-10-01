import type { Data } from "../src/types.ts";

/** Parse an optional, bounded ladder-run game count from the CLI. */
export function parseGameLimit(args: string[]): number {
  const inline = args.find((argument) => argument.startsWith("--games="));
  const gamesIndex = args.indexOf("--games");
  const value = inline
    ? inline.slice("--games=".length)
    : gamesIndex === -1
    ? undefined
    : args[gamesIndex + 1];
  if (value === undefined) return 1;
  const games = Number(value);
  if (!Number.isInteger(games) || games < 1) {
    throw new Error("--games must be a positive integer.");
  }
  return games;
}

/** Running results for one bounded ladder session. */
export class LadderScore {
  botName: string;
  targetGames: number;
  wins = 0;
  losses = 0;
  ties = 0;

  constructor(botName: string, targetGames: number) {
    this.botName = botName;
    this.targetGames = targetGames;
  }

  record(winner: string | null): void {
    if (!winner) this.ties += 1;
    else if (winner.toLowerCase() === this.botName.toLowerCase()) {
      this.wins += 1;
    } else this.losses += 1;
  }

  get completedGames(): number {
    return this.wins + this.losses + this.ties;
  }

  get complete(): boolean {
    return this.completedGames >= this.targetGames;
  }

  summary(): Data {
    return {
      target_games: this.targetGames,
      completed_games: this.completedGames,
      wins: this.wins,
      losses: this.losses,
      ties: this.ties,
    };
  }

  display(): string {
    return `${this.completedGames}/${this.targetGames} — ${this.wins}W-${this.losses}L-${this.ties}T`;
  }
}
