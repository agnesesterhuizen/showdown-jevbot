import type { Data } from "./types.ts";

function safeFilename(roomid: string): string {
  return roomid.replace(/[^a-z0-9_-]/gi, "_");
}

function joinPath(directory: string, filename: string): string {
  return `${directory.replace(/[\\/]+$/, "")}/${filename}`;
}

/** Write battle records as JSONL. */
export class BattleRecorder {
  directory: string;
  enabled: boolean;
  clock: () => string;
  pending = new Map<string, Promise<void>>();
  constructor({
    directory = Deno.env.get("BOT_LOG_DIR") || "logs/jevbot",
    enabled = Deno.env.get("BOT_RECORD") !== "0",
    clock = () => new Date().toISOString(),
  }: { directory?: string; enabled?: boolean; clock?: () => string } = {}) {
    this.directory = directory;
    this.enabled = enabled;
    this.clock = clock;
  }

  record(roomid: string, type: string, data: Data = {}): Promise<void> {
    if (!this.enabled || !roomid) return Promise.resolve();
    const entry = JSON.stringify({ timestamp: this.clock(), type, ...data }) +
      "\n";
    const previous = this.pending.get(roomid) || Promise.resolve();
    const write = previous.then(async () => {
      await Deno.mkdir(this.directory, { recursive: true });
      await Deno.writeTextFile(this.pathFor(roomid), entry, { append: true });
    });
    const handled = write.catch((error: Error) => {
      console.error(`[recorder] Could not write ${roomid}: ${error.message}`);
    });
    this.pending.set(roomid, handled);
    return handled;
  }

  pathFor(roomid: string): string {
    return joinPath(this.directory, `${safeFilename(roomid)}.jsonl`);
  }

  async flush(roomid: string): Promise<void> {
    await (this.pending.get(roomid) || Promise.resolve());
    this.pending.delete(roomid);
  }

  async flushAll(): Promise<void> {
    await Promise.all(
      [...this.pending.keys()].map((roomid) => this.flush(roomid)),
    );
  }
}
