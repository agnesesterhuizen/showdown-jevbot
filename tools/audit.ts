#!/usr/bin/env -S deno run --allow-env --allow-net --allow-read --allow-write

import type { Data } from "../src/types.ts";

const DEFAULT_MODEL = "deepseek-flash";
const REQUEST_TIMEOUT_MS = Number(Deno.env.get("AUDIT_TIMEOUT_MS")) || 600_000;
const REASONING_EFFORT = Deno.env.get("AUDIT_REASONING_EFFORT") || "high";
const REVIEW_CONCURRENCY = 5;

type AuditOptions = {
  runDirectory?: string;
  latest: boolean;
  model: string;
};

class MissingFinalAnswerError extends Error {}
class InvalidAuditJsonError extends Error {}

function valueAfter(args: string[], flag: string): string | undefined {
  const inline = args.find((argument) => argument.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

export function parseAuditOptions(args: string[]): AuditOptions {
  const runDirectory = valueAfter(args, "--run");
  const latest = args.includes("--latest");
  if (runDirectory && latest) {
    throw new Error("Use either --run PATH or --latest, not both.");
  }
  if (!runDirectory && !latest) {
    throw new Error("--run PATH or --latest is required.");
  }
  return {
    runDirectory: runDirectory?.replace(/[\\/]+$/, ""),
    latest,
    model: valueAfter(args, "--model") || Deno.env.get("AUDIT_MODEL") ||
      DEFAULT_MODEL,
  };
}

/** Find the most recently created standard ladder-run directory. */
export async function latestRunDirectory(
  root = "logs/jevbot",
): Promise<string> {
  const runs = [];
  for await (const entry of Deno.readDir(root)) {
    if (!entry.isDirectory || !entry.name.startsWith("run-")) continue;
    const path = `${root}/${entry.name}`;
    try {
      await Deno.stat(`${path}/run.json`);
      runs.push(path);
    } catch {
      // Ignore incomplete or unrelated directories.
    }
  }
  runs.sort();
  const latest = runs.at(-1);
  if (!latest) throw new Error(`No completed runs found in ${root}.`);
  return latest;
}

function actionSummary(action: Data, team: Data[] = []): string {
  const details = [];
  const damage = action.baseline_damage?.estimated_damage_percent_range;
  if (damage) details.push(`damage ${damage[0]}-${damage[1]}%`);
  const accuracy = action.accuracy === true ? null : Number(action.accuracy);
  if (accuracy !== null && Number.isFinite(accuracy) && accuracy < 100) {
    details.push(`${accuracy}% accuracy`);
  }
  if (action.type_matchup && action.type_matchup !== "Neutral") {
    details.push(action.type_matchup);
  }
  if (action.speed_comparison?.speed_order) {
    details.push(action.speed_comparison.speed_order);
  }
  if (action.entry_hazard_hp_loss_percent > 0) {
    details.push(`entry hazards ${action.entry_hazard_hp_loss_percent}%`);
  }
  const incoming = action.incoming_damage?.revealed_move_damage_estimates || [];
  if (incoming.length) {
    details.push(`revealed incoming: ${
      incoming.map((entry: Data) => {
        const range = entry.estimated_damage_percent_range;
        return range ? `${entry.move} ${range[0]}-${range[1]}%` : entry.move;
      }).join(", ")
    }`);
  }
  const observed = action.incoming_damage?.observed_revealed_move_damage || [];
  if (observed.length) {
    details.push(`observed incoming: ${
      observed.map((entry: Data) => {
        const range = entry.observed_damage_percent_range;
        const ko = entry.could_ko_current_active ? "; similar roll can KO" : "";
        return range
          ? `${entry.move} ${range[0]}-${range[1]}%${ko}`
          : entry.move;
      }).join(", ")
    }`);
  }
  const switchSlot = /^switch_(\d+)$/.exec(String(action.id || ""))?.[1];
  const switchTarget = switchSlot
    ? team.find((pokemon) => String(pokemon.slot) === switchSlot)?.details
    : undefined;
  return `${action.id}: ${action.action}${
    switchTarget ? ` (${switchTarget})` : ""
  }${details.length ? ` (${details.join("; ")})` : ""}`;
}

function compactDecision(record: Data): string {
  const state = record.state || {};
  const own = state.own_side?.active || {};
  const foe = state.opponent_side?.active || {};
  const selected = record.selected_action?.id || "none";
  const result = record.result || {};
  const answer = result.answer || {};
  const actions = state.legal_actions || [];
  const selectedAction = actions.find((action: Data) => action.id === selected);
  const topChoices = Object.entries(answer.probabilities || {})
    .sort(([, left], [, right]) => Number(right) - Number(left))
    .slice(0, 3).map(([id, probability]) => `${id}=${probability}`).join(", ");
  const conditions = (state.own_side?.conditions || []).map((condition: Data) =>
    condition.name || condition.id
  );
  const tactics = state.current_active_request?.tactics || {};
  const team = state.own_side?.team || [];
  const lines = [
    `### Turn ${record.turn}: ${own.details || own.ident || "unknown"} (${
      own.condition || "?"
    }) vs ${foe.details || foe.ident || "unknown"} (${foe.condition || "?"})`,
    `Selected: ${
      selectedAction ? actionSummary(selectedAction, team) : selected
    }; source=${result.source || "unknown"}; confidence=${
      answer.confidence ?? "n/a"
    }${topChoices ? `; top probabilities: ${topChoices}` : ""}.`,
    `Own side conditions: ${conditions.join(", ") || "none"}.`,
  ];
  if (tactics.tactical_warnings?.length) {
    lines.push(`Warnings: ${tactics.tactical_warnings.join(" | ")}.`);
  }
  if (tactics.team_hazard_urgency) {
    lines.push(tactics.team_hazard_urgency.summary);
  }
  if (result.tactical_override) {
    lines.push(`Safety override: ${JSON.stringify(result.tactical_override)}.`);
  }
  lines.push(
    "Legal actions:",
    ...actions.map((action: Data) => actionSummary(action, team)),
  );
  return lines.join("\n");
}

/** Convert a verbose battle recording into a focused LLM audit packet. */
export function compactBattleLog(path: string, entries: Data[]): string {
  const start = entries.find((entry) => entry.type === "battle_start") || {};
  const end = entries.find((entry) => entry.type === "battle_end") || {};
  const transcript = entries.filter((entry) =>
    entry.type === "public_event" && entry.display
  ).map((entry) => entry.display).join("\n");
  const decisions = entries.filter((entry) => entry.type === "decision")
    .map(compactDecision).join("\n\n");
  return [
    `# Battle audit packet: ${path.split("/").pop()}`,
    `Format: ${start.format || "unknown"}; bot: ${
      start.bot_name || "unknown"
    }; winner: ${end.tie ? "tie" : end.winner || "unknown"}.`,
    "",
    "## Battle transcript",
    transcript || "No display transcript was recorded.",
    "",
    "## Decisions and information available at the time",
    decisions || "No decisions were recorded.",
  ].join("\n");
}

async function runBattleLogs(runDirectory: string): Promise<string[]> {
  const directory = `${runDirectory}/logs`;
  const found = [];
  for await (const entry of Deno.readDir(directory)) {
    if (
      entry.isFile && entry.name.startsWith("battle-") &&
      entry.name.endsWith(".jsonl")
    ) {
      const path = `${directory}/${entry.name}`;
      found.push({
        path,
        modified: (await Deno.stat(path)).mtime?.getTime() || 0,
      });
    }
  }
  found.sort((left, right) => left.modified - right.modified);
  return found.map((entry) => entry.path);
}

async function readLog(path: string): Promise<Data[]> {
  return (await Deno.readTextFile(path)).split("\n").filter(Boolean).map((
    line,
  ) => JSON.parse(line));
}

async function readRunManifest(runDirectory: string): Promise<Data> {
  try {
    const manifest = JSON.parse(
      await Deno.readTextFile(`${runDirectory}/run.json`),
    );
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      throw new Error("run.json must contain an object.");
    }
    return manifest as Data;
  } catch (error) {
    throw new Error(
      `Could not read ${runDirectory}/run.json: ${error.message}`,
    );
  }
}

async function ask(
  apiKey: string,
  model: string,
  prompt: string,
  requestLabel: string,
  reasoningEffort = REASONING_EFFORT,
): Promise<{ text: string; usage: Data }> {
  console.log(
    `[audit] ${requestLabel}: sending ${
      Math.ceil(new TextEncoder().encode(prompt).length / 1024)
    } KiB; waiting up to ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s.`,
  );
  let response: Response;
  let body: Data;
  const started = Date.now();
  const progress = setInterval(() => {
    console.log(
      `[audit] ${requestLabel}: DeepSeek is still reasoning (${
        Math.round((Date.now() - started) / 1000)
      }s elapsed).`,
    );
  }, 15_000);
  try {
    response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        reasoning_effort: reasoningEffort,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    body = await response.json();
  } catch (error) {
    if (error.name === "TimeoutError") {
      throw new Error(
        `DeepSeek audit request timed out after ${REQUEST_TIMEOUT_MS}ms. Rerun it or increase AUDIT_TIMEOUT_MS.`,
      );
    }
    throw error;
  } finally {
    clearInterval(progress);
  }
  if (!response.ok) {
    throw new Error(
      body.error?.message || `DeepSeek returned HTTP ${response.status}`,
    );
  }
  const choice = body.choices?.[0] || {};
  const message = choice.message || {};
  const content = message.content;
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
    ? content.map((part) => part.text || "").join("")
    : "";
  if (text.trim()) return { text, usage: body.usage || {} };
  throw new MissingFinalAnswerError(
    `DeepSeek returned no final audit answer (finish=${
      choice.finish_reason || "unknown"
    }); intermediate reasoning was discarded.`,
  );
}

function parseJsonObject(text: string, label: string): Data {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected an object");
    }
    return parsed as Data;
  } catch (error) {
    throw new InvalidAuditJsonError(
      `DeepSeek returned invalid ${label} JSON: ${error.message}`,
    );
  }
}

async function askForJson(
  apiKey: string,
  model: string,
  prompt: string,
  label: string,
  requestLabel: string,
): Promise<{ data: Data; usage: Data; reasoningEffort: string }> {
  const efforts = [...new Set([REASONING_EFFORT, "low"])];
  let lastError: unknown;
  for (const [index, effort] of efforts.entries()) {
    try {
      const response = await ask(apiKey, model, prompt, requestLabel, effort);
      return {
        data: parseJsonObject(response.text, label),
        usage: response.usage,
        reasoningEffort: effort,
      };
    } catch (error) {
      lastError = error;
      if (
        index < efforts.length - 1 &&
        (error instanceof MissingFinalAnswerError ||
          error instanceof InvalidAuditJsonError)
      ) {
        console.warn(
          `[audit] ${requestLabel}: ${label} did not produce a usable final answer: ${error.message} Retrying with low reasoning.`,
        );
        continue;
      }
      break;
    }
  }
  throw lastError;
}

export function reviewPrompt(packet: string): string {
  return [
    "You are auditing one Gen 9 Pokémon Showdown Random Battle played by an automated bot.",
    "Reason privately. Return only one valid JSON object; do not include analysis, markdown, or a code fence.",
    "Judge only from information available at the turn; do not use unrevealed facts or hindsight.",
    "Be precise about type matchups, speed, damage, hazards, setup, status, Protect-family odds, and Tera.",
    "Call a move a guaranteed KO only when its minimum listed damage reaches current HP and it has 100% accuracy. For an inaccurate move, say 'KO if it hits' or give its hit chance instead.",
    "An opponent Terastallization shown after the bot selected its action that turn was not knowable in advance. Do not call that action a mistake for failing to predict it.",
    "Identify at most 8 important moments. Label each Clear mistake, Reasonable risk, or Unavoidable.",
    "For each Clear mistake, name the best legal alternative and likely impact.",
    "The packet header's bot and winner are authoritative; do not infer a different result.",
    'Use exactly this JSON shape: {"verdict":"one concise paragraph","moments":[{"turn":"T12","assessment":"Clear mistake|Reasonable risk|Unavoidable","finding":"what happened and why","better_action":"best legal alternative or null","impact":"likely impact"}],"patterns":["repeatable issue or empty if none"]}.',
    "",
    packet,
  ].join("\n");
}

function synthesisPrompt(
  reports: { path: string; outcome: string; review: Data }[],
): string {
  return [
    "Synthesize these Gen 9 Random Battle audit reports into a concise engineering review.",
    "Reason privately. Return only one valid JSON object; do not include analysis, markdown, or a code fence.",
    "Distinguish repeatable decision problems from normal variance. Cite battle filenames and turns.",
    "Keep the same evidence standard as the battle reviews: do not promote an accuracy-dependent KO to guaranteed, and do not treat a same-turn opponent Terastallization as advance knowledge.",
    "Do not invent incidents absent from the reports or recommend a broad rewrite for isolated errors.",
    "The recorded outcomes are authoritative. State the exact aggregate record they imply.",
    'Use exactly this JSON shape: {"overall_verdict":"concise paragraph including the exact record","ranked_fixes":[{"fix":"specific change","evidence":["battle.jsonl T12"]}],"working_well":["item"],"monitor":["item"]}.',
    "",
    ...reports.map((report) =>
      `# ${
        report.path.split("/").pop()
      }\nRecorded outcome: ${report.outcome}\nReview: ${
        JSON.stringify(report.review)
      }`
    ),
  ].join("\n\n");
}

function reviewPath(directory: string, battlePath: string): string {
  const filename = battlePath.split("/").pop()?.replace(/\.jsonl$/i, ".json") ||
    "battle-review.json";
  return `${directory}/${filename}`;
}

async function writeReview(
  directory: string,
  battlePath: string,
  model: string,
  outcome: string,
  review: Data,
  usage: Data,
  reasoningEffort: string,
): Promise<string> {
  const path = reviewPath(directory, battlePath);
  await Deno.mkdir(directory, { recursive: true });
  await Deno.writeTextFile(
    path,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        source_log: battlePath,
        recorded_outcome: outcome,
        model,
        reasoning_effort: reasoningEffort,
        usage,
        review,
      },
      null,
      2,
    ) + "\n",
  );
  return path;
}

async function readReview(
  path: string,
): Promise<{ path: string; outcome: string; review: Data }> {
  const review = JSON.parse(await Deno.readTextFile(path));
  return {
    path: review.source_log,
    outcome: review.recorded_outcome || "unknown",
    review: review.review,
  };
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown, fallback = "Not supplied."): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function renderReview(review: Data): string[] {
  const moments = list(review.moments);
  return [
    string(review.verdict),
    "",
    "**Important moments**",
    ...(moments.length
      ? moments.map((moment) => {
        const entry = moment as Data;
        const alternative = entry.better_action === null
          ? "No better legal alternative identified."
          : string(entry.better_action);
        return `- **${string(entry.turn, "Unknown turn")} — ${
          string(entry.assessment, "Unclassified")
        }**: ${string(entry.finding)} Alternative: ${alternative} Impact: ${
          string(entry.impact)
        }`;
      })
      : ["- No decisive moments identified."]),
    "",
    "**Patterns**",
    ...(list(review.patterns).length
      ? list(review.patterns).map((pattern) => `- ${string(pattern)}`)
      : ["- None identified."]),
  ];
}

function renderSynthesis(synthesis: Data): string[] {
  const fixes = list(synthesis.ranked_fixes);
  return [
    "## Overall verdict",
    string(synthesis.overall_verdict),
    "",
    "## Ranked fixes",
    ...(fixes.length
      ? fixes.map((fix, index) => {
        const entry = fix as Data;
        const evidence = list(entry.evidence).map((item) => string(item));
        return `${index + 1}. **${string(entry.fix)}**${
          evidence.length ? ` — ${evidence.join("; ")}` : ""
        }`;
      })
      : ["1. No repeatable issue identified."]),
    "",
    "## Things working well",
    ...(list(synthesis.working_well).length
      ? list(synthesis.working_well).map((item) => `- ${string(item)}`)
      : ["- None identified."]),
    "",
    "## Monitor over next 20 games",
    ...(list(synthesis.monitor).length
      ? list(synthesis.monitor).map((item) => `- ${string(item)}`)
      : ["- None identified."]),
  ];
}

function recordedOutcome(entries: Data[]): string {
  const start = entries.find((entry) => entry.type === "battle_start") || {};
  const end = entries.find((entry) => entry.type === "battle_end") || {};
  if (end.tie) return "tie";
  if (!end.winner || !start.bot_name) return "unknown";
  return end.winner === start.bot_name ? "bot win" : "bot loss";
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const failures: { index: number; error: unknown }[] = [];
  let nextIndex = 0;
  const runWorker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        failures.push({ index, error });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, runWorker),
  );
  if (failures.length) {
    throw new Error(
      `${failures.length} battle review${
        failures.length === 1 ? "" : "s"
      } failed: ${
        failures.map(({ index, error }) =>
          `${index + 1}: ${
            error instanceof Error ? error.message : String(error)
          }`
        ).join(" | ")
      }`,
    );
  }
  return results;
}

async function main(): Promise<void> {
  const options = parseAuditOptions(Deno.args);
  const apiKey = Deno.env.get("DEEPSEEK_API_KEY");
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is required for an audit.");
  const runDirectory = options.runDirectory || await latestRunDirectory();
  if (options.latest) console.log(`[audit] Using latest run: ${runDirectory}`);
  const run = await readRunManifest(runDirectory);
  const paths = await runBattleLogs(runDirectory);
  if (!paths.length) {
    throw new Error(
      `No battle JSONL logs found in ${runDirectory}/logs.`,
    );
  }
  console.log(
    `[audit] Reviewing run ${
      run.run_id || options.runDirectory
    }: ${paths.length} battle${
      paths.length === 1 ? "" : "s"
    } with ${options.model} (reasoning=${REASONING_EFFORT}).`,
  );
  const destination = `${runDirectory}/audit.md`;
  const reviewsDirectory = `${runDirectory}/audit`;
  const completedReviews = await mapWithConcurrency(
    paths,
    REVIEW_CONCURRENCY,
    async (path, index) => {
      const name = path.split("/").pop() || path;
      const requestLabel = `review ${index + 1}/${paths.length} (${name})`;
      console.log(`[audit] ${requestLabel}`);
      const entries = await readLog(path);
      const packet = compactBattleLog(path, entries);
      const response = await askForJson(
        apiKey,
        options.model,
        reviewPrompt(packet),
        "battle review",
        requestLabel,
      );
      const saved = await writeReview(
        reviewsDirectory,
        path,
        options.model,
        recordedOutcome(entries),
        response.data,
        response.usage,
        response.reasoningEffort,
      );
      console.log(`[audit] ${requestLabel}: saved ${saved}`);
      return {
        saved,
        inputTokens: Number(response.usage.prompt_tokens) || 0,
        outputTokens: Number(response.usage.completion_tokens) || 0,
      };
    },
  );
  const reviewFiles = completedReviews.map((review) => review.saved);
  let inputTokens = completedReviews.reduce(
    (total, review) => total + review.inputTokens,
    0,
  );
  let outputTokens = completedReviews.reduce(
    (total, review) => total + review.outputTokens,
    0,
  );
  const reports = await Promise.all(reviewFiles.map(readReview));
  console.log("[audit] Synthesizing the battle reviews.");
  const synthesis = await askForJson(
    apiKey,
    options.model,
    synthesisPrompt(reports),
    "cross-battle synthesis",
    "synthesis",
  );
  inputTokens += Number(synthesis.usage.prompt_tokens) || 0;
  outputTokens += Number(synthesis.usage.completion_tokens) || 0;
  const report = [
    "# JevBot battle audit",
    "",
    `Model: ${options.model}`,
    `Battles reviewed: ${paths.length}`,
    `DeepSeek token usage: ${inputTokens} input / ${outputTokens} output`,
    "",
    "## Cross-battle synthesis",
    ...renderSynthesis(synthesis.data),
    "",
    "## Per-battle reviews",
    ...reports.flatMap((
      entry,
    ) => [
      `### ${entry.path.split("/").pop()} (${entry.outcome})`,
      ...renderReview(entry.review),
      "",
    ]),
  ].join("\n");
  await Deno.mkdir(destination.split("/").slice(0, -1).join("/") || ".", {
    recursive: true,
  });
  await Deno.writeTextFile(destination, report);
  await Deno.writeTextFile(
    `${reviewsDirectory}/synthesis.json`,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        run_id: run.run_id || options.runDirectory,
        model: options.model,
        reasoning_effort: REASONING_EFFORT,
        usage: synthesis.usage,
        review_files: reviewFiles,
        synthesis: synthesis.data,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `[audit] Wrote ${destination} (${inputTokens} input / ${outputTokens} output tokens).`,
  );
}

if (import.meta.main) await main();
