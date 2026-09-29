#!/usr/bin/env -S deno run --allow-env --allow-net --allow-read --allow-write

import { DecisionModel } from "./decision.ts";
import { formatBattleEvent } from "./battle-log.ts";
import { JevDecisionModel } from "./jev.ts";
import { getLoginAssertion, redactProtocolMessage } from "./login.ts";
import { BattleRecorder } from "./recorder.ts";
import type { BattleRequest } from "./types.ts";

const localOverride = Deno.args.includes("--local");
const liveOverride = Deno.args.includes("--live");
if (localOverride && liveOverride) {
  throw new Error("Use either --local or --live, not both.");
}

const liveMode = liveOverride ||
  (!localOverride && Deno.env.get("PS_LIVE") === "1");
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
let battleRoom = "";
let authenticationStarted = false;

const recorder = new BattleRecorder();
const decisionModel = Deno.env.get("OPENROUTER_API_KEY")
  ? new JevDecisionModel({ recorder })
  : new DecisionModel();
const battleTurns = new Map();
const requestVersions = new Map();
const battleSides = new Map();
const finishingRooms = new Set();

console.log(
  Deno.env.get("OPENROUTER_API_KEY")
    ? "Decision model: Jev via OpenRouter"
    : "Decision model: first legal action (set OPENROUTER_API_KEY to enable Jev)",
);
console.log(
  liveMode
    ? `Server: official Pokémon Showdown as ${name}`
    : `Server: local development as ${name}`,
);

const ws = new WebSocket(url);

function send(message: string): void {
  console.log(`→ ${redactProtocolMessage(message)}`);
  ws.send(message);
}

function handleLine(roomid: string, line: string): void {
  if (decisionModel instanceof JevDecisionModel) {
    decisionModel.observe(roomid, line);
  }
  if (roomid && line.startsWith("|player|")) {
    const [, , side, playerName] = line.split("|");
    if (playerName?.toLowerCase() === name.toLowerCase()) {
      battleSides.set(roomid, side);
    }
  }
  if (roomid === battleRoom) {
    const event = formatBattleEvent(line, battleSides.get(roomid));
    if (event) console.log(`[battle] ${event}`);
    if (!line.startsWith("|request|")) {
      recorder.record(roomid, "public_event", { line, display: event });
    }
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
    if (!queued) {
      queued = true;
      send(`|/search ${format}`);
      console.log(
        liveMode
          ? `Queued as ${name} on the official server.`
          : `Queued as ${name}; now queue ${format} in the browser.`,
      );
    }
    return;
  }

  if (roomid && line.startsWith("|init|battle")) {
    battleRoom = roomid;
    battleTurns.set(roomid, 0);
    recorder.record(roomid, "battle_start", {
      format,
      bot_name: name,
      live_mode: liveMode,
    });
    console.log(`Matched in ${roomid}`);
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
      const version = (requestVersions.get(roomid) || 0) + 1;
      requestVersions.set(roomid, version);
      void chooseForRequest(roomid, version, request);
    } catch (error) {
      console.error("Could not parse battle request:", error);
    }
    return;
  }

  if (roomid === battleRoom && line.startsWith("|error|")) {
    console.error(`Showdown ${line.slice("|error|".length)}`);
    return;
  }

  if (roomid === battleRoom && (line.startsWith("|win|") || line === "|tie")) {
    void finishBattle(roomid, line);
  }
}

async function finishBattle(roomid: string, line: string): Promise<void> {
  if (finishingRooms.has(roomid)) return;
  finishingRooms.add(roomid);
  const winner = line === "|tie" ? null : line.slice("|win|".length);
  console.log(
    winner
      ? `${winner} won. Bot is leaving the queue.`
      : "Battle tied. Bot is leaving the queue.",
  );
  recorder.record(roomid, "battle_end", { winner, tie: !winner });
  await recorder.flush(roomid);
  battleTurns.delete(roomid);
  requestVersions.delete(roomid);
  battleSides.delete(roomid);
  if (decisionModel instanceof JevDecisionModel) decisionModel.clear(roomid);
  ws.close();
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
    console.error("Could not choose a battle action:", error);
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
ws.onclose = () => console.log("Disconnected.");

Deno.addSignalListener("SIGINT", () => {
  void recorder.flushAll().finally(() => ws.close());
});
