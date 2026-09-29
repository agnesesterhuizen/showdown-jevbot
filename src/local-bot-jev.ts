import { generateLegalActions } from "./local-bot-actions.ts";
import { DecisionModel as FallbackDecisionModel } from "./local-bot-decision.ts";
import { addGen9RandomBattleInference } from "./local-bot-randbats.ts";
import { BattleStateTracker } from "./local-bot-state.ts";
import type {
  BattleSnapshot,
  Data,
  DecisionContext,
  DecisionRecorder,
  DecisionResult,
  LegalAction,
  Pokemon,
} from "./types.ts";

const DEFAULT_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
const DEFAULT_MODEL = "typesafe/jev-1.13";
const SHARED_MOVE_TACTIC_KEYS = [
  "opponent_threats",
  "incoming_damage",
  "tactical_warnings",
];

function summarizePokemon(pokemon: Pokemon, index: number): Data {
  return {
    slot: index + 1,
    pokemon: pokemon.ident || pokemon.details,
    details: pokemon.details,
    condition: pokemon.condition,
    active: pokemon.active,
    ability: pokemon.ability || pokemon.baseAbility,
    item: pokemon.item || "none or consumed",
    moves: pokemon.moves,
    tera_type: pokemon.teraType,
    terastallized: pokemon.terastallized,
    stats: pokemon.stats,
  };
}

function summarizeOwnSide(publicState?: Data | null): Data {
  return {
    active: publicState?.active || null,
    conditions: publicState?.conditions || [],
    terastallized: publicState?.terastallized || false,
    remaining_pokemon: publicState?.remainingPokemon,
    fainted_pokemon: publicState?.faintedPokemon,
  };
}

function summarizeOpponentSide(publicState?: Data | null): Data | null {
  if (!publicState) return null;
  return {
    ...publicState,
    team: addGen9RandomBattleInference(publicState.team),
  };
}

function formatPercentRange(range?: [number, number]): string | null {
  return range ? `${range[0]}-${range[1]}%` : null;
}

function sharedMoveTactics(actions: LegalAction[]): Data | undefined {
  const move = actions.find((action) => action.kind === "move");
  if (!move) return undefined;
  const tactics = Object.fromEntries(
    SHARED_MOVE_TACTIC_KEYS.flatMap((key) =>
      move.description[key] === undefined ? [] : [[key, move.description[key]]]
    ),
  );
  return Object.keys(tactics).length ? tactics : undefined;
}

function summarizeAction(action: LegalAction): Data {
  const description = { ...action.description };
  if (action.kind === "move" || action.kind === "move-terastallize") {
    for (const key of SHARED_MOVE_TACTIC_KEYS) delete description[key];
  }
  return { id: action.id, command: action.command, ...description };
}

/** Format a decision for console output. */
export function formatDecisionSummary(
  action: Pick<LegalAction, "id" | "description">,
): string {
  const description = action.description || {};
  const details = [];
  const damage = formatPercentRange(
    description.baseline_damage?.estimated_damage_percent_range,
  );
  if (damage) details.push(`damage ${damage}`);
  else if (description.type_matchup) details.push(description.type_matchup);
  if (description.speed_comparison?.speed_order) {
    details.push(description.speed_comparison.speed_order);
  }
  if (typeof description.entry_hazard_hp_loss_percent === "number") {
    details.push(`entry hazards ${description.entry_hazard_hp_loss_percent}%`);
  }
  const revealedIncoming = description.incoming_damage
    ?.revealed_move_damage_estimates?.[0];
  const incomingDamage = formatPercentRange(
    revealedIncoming?.estimated_damage_percent_range,
  );
  if (revealedIncoming && incomingDamage) {
    details.push(`revealed ${revealedIncoming.move} ${incomingDamage}`);
  }
  return [description.action || action.id, ...details].join("; ");
}

export function buildJevRequest(
  context: DecisionContext,
  actions: LegalAction[],
  model = DEFAULT_MODEL,
  snapshot: BattleSnapshot = {},
): Data {
  const { request, roomid, turn } = context;
  const active = request.active?.[0];
  const { ownSide = null, opponentSide = null, field, recentEvents = [] } =
    snapshot;
  const activeTactics = sharedMoveTactics(actions);
  return {
    model,
    session_id: roomid,
    state: {
      battle: {
        format: "Generation 9 Random Battle, singles",
        turn: snapshot.turn || turn,
        objective:
          "Win the battle by choosing one legal action for the current turn.",
      },
      own_side: {
        team: request.side.pokemon.map(summarizePokemon),
        ...summarizeOwnSide(ownSide),
      },
      opponent_side: summarizeOpponentSide(opponentSide),
      field: field || { weather: null, terrain: null, pseudoWeather: [] },
      current_active_request: active
        ? {
          trapped: !!active.trapped,
          maybe_trapped: !!active.maybeTrapped,
          can_terastallize_into: active.canTerastallize,
          moves: active.moves,
          ...(activeTactics ? { tactics: activeTactics } : {}),
        }
        : undefined,
      recent_public_battle_events: recentEvents,
      legal_actions: actions.map(summarizeAction),
    },
    questions: {
      action: {
        type: "choice",
        instructions: {
          question: "Which option is the best legal action for this turn?",
          inspect: [
            "`own_side`",
            "`opponent_side`",
            "`field`",
            "`current_active_request`",
            "`recent_public_battle_events`",
            "`legal_actions`",
          ],
          priorities: [
            "Prefer actions that improve the probability of winning the whole battle, not merely this turn.",
            "Account for type matchups, damage, speed, status, setup, hazards, recovery, switching, and observed information.",
            "Treat `randomBattleSet` fields as possibilities rather than confirmed opponent facts.",
            "Conserve Terastallization unless its expected strategic value justifies using it now.",
          ],
        },
        criteria: Object.fromEntries(
          // `legal_actions` already contains the full tactical evidence. Keeping
          // a second copy here made large battles exceed the decision endpoint's
          // input limit, especially with Tera variants and several switch-ins.
          actions.map((action) => [action.id, action.description.action]),
        ),
      },
    },
  };
}

export class JevDecisionModel {
  apiKey: string;
  endpoint: string;
  model: string;
  timeoutMs: number;
  fetch: typeof fetch;
  fallback: FallbackDecisionModel;
  tracker: BattleStateTracker;
  recorder: DecisionRecorder | null;
  debug: boolean;
  constructor({
    apiKey = Deno.env.get("OPENROUTER_API_KEY"),
    endpoint = Deno.env.get("JEV_ENDPOINT") || DEFAULT_ENDPOINT,
    model = Deno.env.get("JEV_MODEL") || DEFAULT_MODEL,
    timeoutMs = Number(Deno.env.get("JEV_TIMEOUT_MS")) || 5000,
    fetchImpl = globalThis.fetch,
    fallback = new FallbackDecisionModel(),
    tracker = new BattleStateTracker(),
    recorder = null,
    debug = Deno.env.get("JEV_DEBUG") === "1",
  }: {
    apiKey?: string;
    endpoint?: string;
    model?: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    fallback?: FallbackDecisionModel;
    tracker?: BattleStateTracker;
    recorder?: DecisionRecorder | null;
    debug?: boolean;
  } = {}) {
    if (!apiKey) throw new Error("OPENROUTER_API_KEY is required to use Jev.");
    this.apiKey = apiKey;
    this.endpoint = endpoint;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    this.fallback = fallback;
    this.tracker = tracker;
    this.recorder = recorder;
    this.debug = debug;
  }

  observe(roomid: string, line: string): void {
    this.tracker.observe(roomid, line);
  }

  clear(roomid: string): void {
    this.tracker.clear(roomid);
  }

  async choose(context: DecisionContext): Promise<string | null> {
    const snapshot = this.tracker.getSnapshot(
      context.roomid,
      context.request.side.id,
    );
    const actions = generateLegalActions(context.request, snapshot);
    if (!actions.length) return null;
    const payload = buildJevRequest(context, actions, this.model, snapshot);
    if (actions.length === 1) {
      this.recordDecision(context, payload, actions[0], {
        source: "single_legal_action",
      });
      return actions[0].command;
    }

    if (this.debug) {
      console.log("[jev] request:", JSON.stringify(payload, null, 2));
    }

    const started = Date.now();
    try {
      const response = await this.fetch(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(
          result.error?.message ||
            `OpenRouter returned HTTP ${response.status}`,
        );
      }

      const answer = result.answers?.action;
      const selected = actions.find((action) => action.id === answer?.choice);
      if (!selected) {
        throw new Error(
          `Jev returned unknown action ${JSON.stringify(answer?.choice)}`,
        );
      }

      const elapsed = Date.now() - started;
      const confidence = typeof answer.confidence === "number"
        ? answer.confidence.toFixed(3)
        : "unknown";
      const cost = typeof result.usage?.cost === "number"
        ? `$${result.usage.cost.toFixed(8)}`
        : "unknown cost";
      console.log(
        `[jev] ${context.roomid} turn ${context.turn}: ${selected.id} — ${
          formatDecisionSummary(selected)
        } ` +
          `(${confidence} confidence, ${elapsed}ms, ${cost})`,
      );
      this.recordDecision(context, payload, selected, {
        source: "jev",
        answer,
        usage: result.usage,
        elapsed_ms: elapsed,
      });
      if (this.debug) {
        console.log("[jev] answer:", JSON.stringify(answer, null, 2));
      }
      return selected.command;
    } catch (error) {
      const fallback = this.fallback.choose(context);
      console.error(
        `[jev] ${error.message}; falling back to ${fallback || "no action"}.`,
      );
      const selected = actions.find((action) => action.command === fallback) ||
        null;
      this.recordDecision(context, payload, selected, {
        source: "fallback",
        error: error.message,
      });
      return fallback;
    }
  }

  recordDecision(
    context: DecisionContext,
    payload: Data,
    selected: LegalAction | null,
    result: DecisionResult,
  ): void {
    this.recorder?.record(context.roomid, "decision", {
      turn: context.turn,
      state: payload.state,
      selected_action: selected
        ? { id: selected.id, command: selected.command }
        : null,
      result,
    });
  }
}
