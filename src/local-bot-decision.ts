import { generateLegalActions } from "./local-bot-actions.ts";
import type { DecisionContext } from "./types.ts";

/** First legal action fallback. */

export class DecisionModel {
  choose(context: DecisionContext): string | null {
    return generateLegalActions(context.request)[0]?.command || null;
  }
}
