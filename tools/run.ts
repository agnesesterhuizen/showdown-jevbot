#!/usr/bin/env -S deno run --allow-env --allow-net --allow-read --allow-write

import { DecisionModel } from "../src/decision.ts";
import { formatBattleEvent, formatOpponentChat } from "../src/battle-log.ts";
import { JevDecisionModel } from "../src/jev.ts";
import { LadderScore, parseGameLimit } from "./ladder.ts";
import { getLoginAssertion, redactProtocolMessage } from "../src/login.ts";
import { BattleRecorder } from "../src/recorder.ts";
import type { BattleRequest } from "../src/types.ts";

const localOverride = Deno.args.includes("--local");
const liveOverride = Deno.args.includes("--live");
const parallelMode = Deno.args.includes("--parallel");
if (localOverride && liveOverride) {
  throw new Error("Use either --local or --live, not both.");
}

const liveMode = liveOverride ||
  (!localOverride && Deno.env.get("PS_LIVE") === "1");
const gameLimit = parseGameLimit(Deno.args);
if (gameLimit > 1 && !liveMode) {
  throw new Error("--games is only supported in live mode.");
}
if (parallelMode && !liveMode) {
  throw new Error("--parallel is only supported in live mode.");
}
const maxActiveGames = parallelMode ? 5 : 1;
const url = Deno.env.get("PS_URL") ||
  (liveMode
    ? "wss://sim3.psim.us/showdown/websocket"
    : "ws://127.0.0.1:8000/showdown/websocket");
const name = liveMode
  ? Deno.env.get("PS_USERNAME")
  : Deno.env.get("BOT_NAME") || "JevBot";
const password = Deno.env.get("PS_PASSWORD");
const format = "gen9randombattle";

if (liveMode && (!Deno.env.get("PS_USERNAME") || !password)) {
  throw new Error(
    "PS_LIVE=1 requires PS_USERNAME and PS_PASSWORD in the environment.",
  );
}

let queued = false;
let authenticationStarted = false;

const ladderRunStartedAt = new Date().toISOString();
const ladderRunStartedMs = Date.now();
const logRoot = Deno.env.get("BOT_LOG_DIR") || "logs/jevbot";
const runId = `run-${ladderRunStartedAt.replace(/[^0-9A-Za-z]/g, "-")}`;
const runDirectory = liveMode
  ? `${logRoot.replace(/[\\/]+$/, "")}/${runId}`
  : null;
const recorder = new BattleRecorder({
  directory: runDirectory ? `${runDirectory}/logs` : logRoot,
});
const ladderScore = new LadderScore(name, gameLimit);
const decisionModel = Deno.env.get("OPENROUTER_API_KEY")
  ? new JevDecisionModel({ recorder, logDecisions: !parallelMode })
  : new DecisionModel();
const activeRooms = new Set<string>();
const gameNumbers = new Map<string, number>();
const gameStartedAt = new Map<string, number>();
const battleStatus = new Map<string, { own: number; opponent: number }>();
let startedGames = 0;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let finalizingRun = false;
const battleTurns = new Map();
const requestVersions = new Map();
const battleSides = new Map();
const battlePlayers = new Map<
  string,
  Map<string, { name: string; rating: string }>
>();
const announcedRatings = new Set();
const finishingRooms = new Set();

console.log(
  Deno.env.get("OPENROUTER_API_KEY")
    ? "Decision model: Jev via OpenRouter"
    : "Decision model: first legal action (set OPENROUTER_API_KEY to enable Jev)",
);
if (gameLimit > 1) {
  console.log(
    `[ladder] Running ${gameLimit} rated ${format} games${
      parallelMode ? ` (up to ${maxActiveGames} at once)` : ""
    }.`,
  );
}
if (runDirectory) console.log(`[ladder] Run: ${runDirectory}`);
console.log(
  liveMode
    ? `Server: official Pokémon Showdown as ${name}`
    : `Server: local development as ${name}`,
);

const ws = new WebSocket(url);
const blue = (text: string) =>
  Deno.stdout.isTerminal() ? `\x1b[34m${text}\x1b[0m` : text;

let manifestWrites = Promise.resolve();

function writeRunManifest(
  status: "running" | "complete" | "interrupted",
): Promise<void> {
  if (!runDirectory) return Promise.resolve();
  manifestWrites = manifestWrites.then(async () => {
    const manifest = {
      run_id: runId,
      started_at: ladderRunStartedAt,
      finished_at: status === "running" ? null : new Date().toISOString(),
      status,
      format,
      bot_name: name,
      live_mode: liveMode,
      parallel: parallelMode,
      max_active_games: maxActiveGames,
      logs_directory: "logs",
      audit_directory: "audit",
      report: "audit.md",
      ...ladderScore.summary(),
    };
    await Deno.mkdir(runDirectory, { recursive: true });
    await Deno.mkdir(`${runDirectory}/logs`, { recursive: true });
    await Deno.writeTextFile(
      `${runDirectory}/run.json`,
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  });
  return manifestWrites;
}

if (runDirectory) await writeRunManifest("running");

function send(message: string): void {
  if (!parallelMode) console.log(`→ ${redactProtocolMessage(message)}`);
  ws.send(message);
}

function gamePrefix(roomid: string): string {
  return parallelMode ? `[G${gameNumbers.get(roomid) || "?"}]` : "[battle]";
}

function formatElapsed(elapsedMs: number): string {
  const seconds = Math.floor(elapsedMs / 1_000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function updateBattleStatus(roomid: string, line: string): void {
  if (!line.startsWith("|faint|")) return;
  const side = line.split("|")[2]?.match(/^(p[1-4])[a-z]?:/)?.[1];
  const ownSide = battleSides.get(roomid);
  const status = battleStatus.get(roomid);
  if (!side || !ownSide || !status) return;
  if (side === ownSide) status.own = Math.max(0, status.own - 1);
  else status.opponent = Math.max(0, status.opponent - 1);
}

function printParallelHeartbeat(): void {
  if (!parallelMode || !activeRooms.size) return;
  const progress = [...activeRooms]
    .sort((left, right) => (gameNumbers.get(left) || 0) - (gameNumbers.get(right) || 0))
    .map((roomid) => {
      const status = battleStatus.get(roomid) || { own: 6, opponent: 6 };
      return `G${gameNumbers.get(roomid) || "?"} ${status.own}\u2013${status.opponent}`;
    })
    .join(", ");
  console.log(`[ladder] ${formatElapsed(Date.now() - ladderRunStartedMs)} \u2014 ${progress}`);
}

function announceRatings(roomid: string): void {
  if (announcedRatings.has(roomid)) return;
  const ownSide = battleSides.get(roomid);
  const players = battlePlayers.get(roomid);
  if (!ownSide || !players || players.size < 2) return;
  const own = players.get(ownSide);
  const opponent = [...players.entries()].find(([side]) => side !== ownSide)
    ?.[1];
  if (!own || !opponent) return;
  announcedRatings.add(roomid);
  console.log(
    `${gamePrefix(roomid)} Elo: ${own.name} ${own.rating || "?"} vs ${opponent.name} ${
      opponent.rating || "?"
    }`,
  );
}

function queueNextBattle(): void {
  const reservedGames = ladderScore.completedGames + activeRooms.size +
    (queued ? 1 : 0);
  if (
    queued || ladderScore.complete || activeRooms.size >= maxActiveGames ||
    reservedGames >= gameLimit
  ) return;
  queued = true;
  send(`|/search ${format}`);
  if (!parallelMode) {
    console.log(
      liveMode
        ? `[ladder] Queued game ${
          ladderScore.completedGames + 1
        }/${gameLimit} as ${name}.`
        : `Queued as ${name}; now queue ${format} in the browser.`,
    );
  }
}

async function finalizeRun(
  status: "complete" | "interrupted",
): Promise<void> {
  try {
    await writeRunManifest(status);
    if (runDirectory) {
      console.log(`[ladder] Run manifest written to ${runDirectory}/run.json`);
    }
  } catch (error) {
    console.error(`[ladder] Could not write run manifest: ${error.message}`);
  }
}

function handleLine(roomid: string, line: string): void {
  if (decisionModel instanceof JevDecisionModel) {
    decisionModel.observe(roomid, line);
  }
  if (roomid && line.startsWith("|player|")) {
    const [, , side, playerName, , rating] = line.split("|");
    const players = battlePlayers.get(roomid) || new Map();
    players.set(side, { name: playerName, rating: rating || "" });
    battlePlayers.set(roomid, players);
    if (playerName?.toLowerCase() === name.toLowerCase()) {
      battleSides.set(roomid, side);
    }
    announceRatings(roomid);
  }
  if (activeRooms.has(roomid)) {
    const ownSide = battleSides.get(roomid);
    const chat = formatOpponentChat(line, name, ownSide);
    if (chat) {
      console.log(
        blue(parallelMode ? `${gamePrefix(roomid)} [opponent] ${chat}` : `[opponent] ${chat}`),
      );
    }
    const event = formatBattleEvent(line, ownSide);
    if (event && !parallelMode) console.log(`${gamePrefix(roomid)} ${event}`);
    if (!line.startsWith("|request|")) {
      recorder.record(roomid, "public_event", { line, display: event });
    }
    updateBattleStatus(roomid, line);
  }

  if (line.startsWith("|challstr|")) {
    if (liveMode) void authenticate(line.slice("|challstr|".length));
    else send(`|/trn ${name}`);
    return;
  }

  if (
    line.startsWith("|updateuser|") &&
    line.slice("|updateuser|".length).trimStart().split("|", 1)[0]
        .toLowerCase() === name.toLowerCase()
  ) {
    queueNextBattle();
    return;
  }

  if (roomid && line.startsWith("|init|battle")) {
    queued = false;
    activeRooms.add(roomid);
    startedGames += 1;
    gameNumbers.set(roomid, startedGames);
    gameStartedAt.set(roomid, Date.now());
    battleStatus.set(roomid, { own: 6, opponent: 6 });
    battleTurns.set(roomid, 0);
    recorder.record(roomid, "battle_start", {
      format,
      bot_name: name,
      live_mode: liveMode,
      game_number: startedGames,
      ladder: ladderScore.summary(),
    });
    console.log(
      parallelMode
        ? `${gamePrefix(roomid)} Started.`
        : `Matched in ${roomid}`,
    );
    queueNextBattle();
    return;
  }

  if (roomid && line.startsWith("|turn|")) {
    battleTurns.set(roomid, Number(line.slice("|turn|".length)) || 0);
    return;
  }

  if (roomid && line.startsWith("|request|")) {
    try {
      const request = JSON.parse(
        line.slice("|request|".length),
      ) as BattleRequest;
      battleSides.set(roomid, request.side.id);
      announceRatings(roomid);
      const version = (requestVersions.get(roomid) || 0) + 1;
      requestVersions.set(roomid, version);
      void chooseForRequest(roomid, version, request);
    } catch (error) {
      console.error("Could not parse battle request:", error);
    }
    return;
  }

  if (activeRooms.has(roomid) && line.startsWith("|error|")) {
    console.error(`${gamePrefix(roomid)} Showdown ${line.slice("|error|".length)}`);
    return;
  }

  if (activeRooms.has(roomid) && (line.startsWith("|win|") || line === "|tie")) {
    void finishBattle(roomid, line);
  }
}

async function finishBattle(roomid: string, line: string): Promise<void> {
  if (finishingRooms.has(roomid)) return;
  finishingRooms.add(roomid);
  const winner = line === "|tie" ? null : line.slice("|win|".length);
  ladderScore.record(winner);
  if (parallelMode) {
    const duration = formatElapsed(Date.now() - (gameStartedAt.get(roomid) || Date.now()));
    console.log(
      `${gamePrefix(roomid)} ${winner ? `${winner} won` : "Tied"} \u2014 ${duration}. Score: ${ladderScore.display()}`,
    );
  } else {
    console.log(winner ? `${winner} won.` : "Battle tied.");
    console.log(`[ladder] Score: ${ladderScore.display()}`);
  }
  recorder.record(roomid, "battle_end", {
    winner,
    tie: !winner,
    game_number: gameNumbers.get(roomid),
    ladder: ladderScore.summary(),
  });
  await recorder.flush(roomid);
  await writeRunManifest(ladderScore.complete ? "complete" : "running");
  activeRooms.delete(roomid);
  battleTurns.delete(roomid);
  requestVersions.delete(roomid);
  battleSides.delete(roomid);
  battlePlayers.delete(roomid);
  gameNumbers.delete(roomid);
  gameStartedAt.delete(roomid);
  battleStatus.delete(roomid);
  announcedRatings.delete(roomid);
  if (decisionModel instanceof JevDecisionModel) decisionModel.clear(roomid);
  if (ladderScore.complete) {
    if (finalizingRun) return;
    finalizingRun = true;
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
    console.log(`[ladder] Complete: ${ladderScore.display()}`);
    await finalizeRun("complete");
    ws.close();
  } else {
    queueNextBattle();
  }
}

async function authenticate(challstr: string): Promise<void> {
  if (authenticationStarted) return;
  authenticationStarted = true;
  try {
    const assertion = await getLoginAssertion({
      username: name,
      password,
      challstr,
    });
    send(`|/trn ${name},0,${assertion}`);
  } catch (error) {
    console.error(`Could not authenticate ${name}: ${error.message}`);
    ws.close();
  }
}

async function chooseForRequest(
  roomid: string,
  version: number,
  request: BattleRequest,
): Promise<void> {
  try {
    const choice = await decisionModel.choose({
      roomid,
      turn: battleTurns.get(roomid) || 0,
      request,
    });
    if (!choice || requestVersions.get(roomid) !== version) return;
    const rqid = request.rqid === undefined ? "" : `|${request.rqid}`;
    send(`${roomid}|/choose ${choice}${rqid}`);
  } catch (error) {
    console.error(`${gamePrefix(roomid)} Could not choose a battle action:`, error);
  }
}

ws.onopen = () => console.log(`Connected to ${url}`);
ws.onmessage = (event) => {
  const lines = String(event.data).split("\n");
  let roomid = "";
  if (lines[0].startsWith(">")) roomid = lines.shift().slice(1);
  for (const line of lines) handleLine(roomid, line);
};
ws.onerror = (error) =>
  console.error(
    "WebSocket error:",
    error instanceof ErrorEvent ? error.message : error,
  );
ws.onclose = () => {
  if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
  console.log("Disconnected.");
};

if (parallelMode) heartbeatTimer = setInterval(printParallelHeartbeat, 60_000);

Deno.addSignalListener("SIGINT", () => {
  if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
  void recorder.flushAll().finally(async () => {
    await finalizeRun("interrupted");
    ws.close();
  });
});
