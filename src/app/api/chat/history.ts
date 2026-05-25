import type Anthropic from "@anthropic-ai/sdk";

/**
 * Conversation-history trimmer.
 *
 * Previously the route trimmed history with `slice(-HISTORY_TURNS * 2)`.
 * Two problems with that approach:
 *
 *   1. It counts messages, not tokens. A single past turn that did five
 *      tool calls is eleven messages, so "the last 20 messages" can be just
 *      2-3 real conversational turns — or, worse, half of one turn.
 *
 *   2. It can split an assistant `tool_use` block from its matching user
 *      `tool_result` block. Anthropic rejects such requests with a 400:
 *      "messages.N.role: tool_use_id ... was not matched by tool_result".
 *
 * This trimmer fixes both. It walks the history backwards, groups messages
 * into *turns* (each turn starts at a real user-text message and includes
 * every assistant tool_use + user tool_result that followed), and keeps
 * whole turns from most-recent backwards until a token budget is reached.
 * Turn boundaries are never crossed, so tool_use/tool_result pairs always
 * stay together.
 */

type Message = Anthropic.MessageParam;

/** Default budget: ~40K input tokens for prior history. The full request
 * also carries the system prompt (~1.3K), tool definitions (~3K), and any
 * tool round-trips happening on the current turn (typically <50K after
 * step (b)'s caps). 40K leaves comfortable headroom under the 200K ceiling.
 */
export const DEFAULT_HISTORY_TOKEN_BUDGET = 40_000;

/** Cheap conservative estimator. The real ratio varies by content type
 * (English prose ≈ 4 chars/token, JSON ≈ 3.5, code can be denser), but for
 * a budget check this is plenty accurate and avoids an extra API call.
 */
const CHARS_PER_TOKEN = 4;

export type TrimStats = {
  total_messages: number;
  kept_messages: number;
  kept_turns: number;
  estimated_tokens: number;
  budget_tokens: number;
  /** True when we kept the most-recent turn even though it alone exceeded
   *  the budget. Useful as a signal that the budget is too tight or that
   *  per-call results need more aggressive compaction. */
  over_budget: boolean;
};

export type TrimResult = {
  kept: Message[];
  stats: TrimStats;
};

/**
 * Trim conversation history to fit under a token budget WITHOUT splitting
 * a tool_use block from its matching tool_result.
 */
export function trimHistoryByTokenBudget(
  history: Message[],
  budgetTokens: number = DEFAULT_HISTORY_TOKEN_BUDGET,
): TrimResult {
  const baseStats: TrimStats = {
    total_messages: history.length,
    kept_messages: 0,
    kept_turns: 0,
    estimated_tokens: 0,
    budget_tokens: budgetTokens,
    over_budget: false,
  };

  if (history.length === 0) {
    return { kept: [], stats: baseStats };
  }

  // -------------------------------------------------------------------------
  // 1. Group messages into turns.
  //
  // We walk backwards so the first "anchor" we find is the most recent real
  // user message, and we can stop once the budget runs out without building
  // the full grouping up-front.
  //
  // currentTurn accumulates messages we haven't yet anchored to a user-text
  // message. When we hit a user-text message, that closes a turn and we
  // prepend it to `turns`.
  // -------------------------------------------------------------------------
  const turns: Message[][] = [];
  let currentTurn: Message[] = [];

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const msg = history[i];
    currentTurn.unshift(msg);

    if (isRealUserMessage(msg)) {
      turns.unshift(currentTurn);
      currentTurn = [];
    }
  }

  // -------------------------------------------------------------------------
  // 2. Orphan suffix at the front.
  //
  // If `currentTurn` is non-empty after the loop, it means the history
  // starts with tool_result / assistant messages that have no anchoring
  // user-text message before them. Keeping these would cause an API error
  // (orphan tool_result, missing matching tool_use). Drop them — they can't
  // be replayed safely.
  // -------------------------------------------------------------------------
  // (No need to do anything; we simply don't include them in `turns`.)

  if (turns.length === 0) {
    // History had no user-text anchor at all — nothing safe to keep.
    return { kept: [], stats: baseStats };
  }

  // -------------------------------------------------------------------------
  // 3. Accumulate whole turns from the most recent backwards until the
  //    budget would be exceeded. Always keep at least the most recent turn,
  //    even if it alone exceeds the budget — that's better than dropping
  //    history we just decided to load.
  // -------------------------------------------------------------------------
  const kept: Message[][] = [];
  let estimatedTokens = 0;
  let overBudget = false;

  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    const turnTokens = estimateTurnTokens(turn);

    if (kept.length === 0) {
      // Always include the most-recent turn.
      kept.unshift(turn);
      estimatedTokens += turnTokens;
      if (turnTokens > budgetTokens) overBudget = true;
      continue;
    }

    if (estimatedTokens + turnTokens > budgetTokens) {
      break;
    }

    kept.unshift(turn);
    estimatedTokens += turnTokens;
  }

  const flat = kept.flat();
  return {
    kept: flat,
    stats: {
      total_messages: history.length,
      kept_messages: flat.length,
      kept_turns: kept.length,
      estimated_tokens: estimatedTokens,
      budget_tokens: budgetTokens,
      over_budget: overBudget,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A "real user message" is the kind of message a human actually types — the
 * thing that opens a conversational turn. User-role messages that contain
 * tool_result blocks are NOT turn boundaries; they're follow-ups to the
 * preceding assistant tool_use.
 *
 * In this codebase user messages are stored either as a plain string (the
 * normal case — see route.ts where new user input is pushed verbatim) or as
 * an array consisting entirely of text blocks (defensive case).
 */
export function isRealUserMessage(msg: Message): boolean {
  if (msg.role !== "user") return false;
  if (typeof msg.content === "string") return true;
  if (!Array.isArray(msg.content)) return false;
  if (msg.content.length === 0) return false;
  return msg.content.every((block) => block.type === "text");
}

function estimateTurnTokens(messages: Message[]): number {
  let chars = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      chars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      try {
        chars += JSON.stringify(msg.content).length;
      } catch {
        // Unstringifiable content — assume worst-case so it tends to get
        // dropped first.
        chars += 5_000;
      }
    }
    // Small structural overhead per message (role + framing). Anthropic's
    // own tokenizer adds a handful of tokens per message; this approximates
    // that without being noticeably wrong.
    chars += 4;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}
