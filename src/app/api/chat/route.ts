import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";

import { buildSystemPrompt } from "./prompt";
import {
  DEFAULT_HISTORY_TOKEN_BUDGET,
  trimHistoryByTokenBudget,
} from "./history";
import { TOOL_DEFINITIONS, executeTool } from "./tools";
import { compactToolResult } from "./tools/compact-result";
import type { ToolContext } from "./tools/types";

export const runtime = "nodejs";
// Cap the whole serverless function at 60s. Without this, hosts with longer
// default timeouts can let a hung Anthropic/Supabase/Voyage call sit forever
// while the UI shows "Thinking..." with no signal of failure.
export const maxDuration = 60;

type ChatRequestBody = {
  message?: string;
  question?: string; // alias accepted for compatibility with the existing UI
  conversation_id?: string | null;
};

type StoredMessage = {
  role: "user" | "assistant";
  content: Anthropic.MessageParam["content"];
};

type ToolCallTrace = {
  name: string;
  input: unknown;
};

type DocumentSource = {
  file_name: string;
  document_type: string | null;
  similarity: number;
};

const MAX_TOOL_ITERATIONS = 12;
const MAX_OUTPUT_TOKENS = 4096;
// Document sources are only surfaced beneath assistant messages when their
// vector-similarity score is at least this high. The model sometimes calls
// `search_documents` speculatively on questions that aren't really about
// internal docs (KPI queries, customer lookups, etc.) and gets back weak
// 0.14–0.20 matches. Showing those as "Källa: ..." citations is misleading,
// so we filter at extraction time. Tune this if legit doc questions return
// strong-but-lower scores.
const MIN_SOURCE_SIMILARITY = 0.4;

/**
 * Detect Anthropic's context-window-exceeded error. The SDK exposes status
 * codes via APIError; context overflow is a 400 with one of a handful of
 * message fragments. We match defensively because Anthropic's wording has
 * drifted over time ("prompt is too long" vs "context_length_exceeded" vs
 * "context window"). When in doubt, we'd rather show the friendly message
 * than the raw error.
 */
function isContextOverflowError(err: unknown): boolean {
  if (!(err instanceof Anthropic.APIError)) return false;
  if (err.status !== 400) return false;
  const message =
    err.message?.toLowerCase() ?? String(err).toLowerCase();
  return (
    message.includes("prompt is too long") ||
    message.includes("context length") ||
    message.includes("context window") ||
    message.includes("context_length_exceeded") ||
    message.includes("token limit") ||
    message.includes("maximum context")
  );
}

/**
 * Friendly Swedish-first fallback for context-overflow situations. The UI
 * locale is Swedish; English appears as a graceful fallback for non-Swedish
 * users. Worded as a suggestion (narrow by time/consultant/count) rather
 * than an apology so the user knows exactly what to try next.
 */
const CONTEXT_OVERFLOW_FALLBACK =
  "Den här frågan rör för mycket data åt gången — försök smala av med " +
  "tidsperiod (t.ex. en specifik månad eller år), en enskild konsult, " +
  "eller be om ett specifikt antal som \"top 5\" eller \"top 10\".\n\n" +
  "_(This query covers too much data at once — try narrowing by time " +
  "period, consultant, or ask for a specific number like \"top 5\".)_";
// Per-call ceiling for the Anthropic round-trip. If the API hangs we want a
// concrete error within ~30s rather than letting the loop sit until the
// function-level maxDuration kills the whole request.
const ANTHROPIC_CALL_TIMEOUT_MS = 30_000;

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function POST(request: Request) {
  try {
    return await handleChat(request);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error.";
    const stack = error instanceof Error ? error.stack : undefined;
    console.error("[/api/chat] Unhandled error:", error);
    return NextResponse.json(
      {
        error: message,
        stack: process.env.NODE_ENV === "production" ? undefined : stack,
      },
      { status: 500 },
    );
  }
}

async function handleChat(request: Request) {
  let body: ChatRequestBody;
  try {
    body = (await request.json()) as ChatRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const message = (body.message ?? body.question ?? "").trim();
  if (!message) {
    return NextResponse.json(
      { error: "`message` (or `question`) is required." },
      { status: 400 },
    );
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY is not configured." },
      { status: 500 },
    );
  }

  const supabase = await createClient();
  const {
    data: { user: authUser },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: profileData, error: profileError } = await supabase
    .from("profiles")
    .select("id, email, full_name, role, team_id")
    .eq("id", authUser.id)
    .maybeSingle();

  const profile = profileData as unknown as ToolContext["user"] | null;

  if (profileError || !profile) {
    return NextResponse.json(
      { error: profileError?.message ?? "Profile not found." },
      { status: 403 },
    );
  }

  const context: ToolContext = {
    supabase,
    user: profile,
  };

  // ---------------------------------------------------------------------------
  // Conversation history
  // ---------------------------------------------------------------------------

  const conversationId = body.conversation_id ?? null;
  let storedHistory: StoredMessage[] = [];

  if (conversationId) {
    const { data: convData, error: convError } = await supabase
      .from("conversations")
      .select("id, user_id, messages")
      .eq("id", conversationId)
      .maybeSingle();

    const conv = convData as unknown as {
      id: string;
      user_id: string;
      messages: unknown;
    } | null;

    if (convError || !conv) {
      return NextResponse.json(
        { error: "Conversation not found." },
        { status: 404 },
      );
    }
    if (conv.user_id !== profile.id) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    storedHistory = Array.isArray(conv.messages)
      ? (conv.messages as StoredMessage[])
      : [];
  }

  // Trim history with a token-budget walker that keeps whole turns
  // (never splits an assistant tool_use from its matching user tool_result,
  // which would otherwise crash the request with a 400 from Anthropic).
  const historyMessages: Anthropic.MessageParam[] = storedHistory.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  const { kept: trimmedHistory, stats: historyStats } =
    trimHistoryByTokenBudget(historyMessages, DEFAULT_HISTORY_TOKEN_BUDGET);

  if (historyStats.total_messages > 0) {
    console.log(
      `[/api/chat] history: kept ${historyStats.kept_messages}/${historyStats.total_messages} msgs ` +
        `(${historyStats.kept_turns} turn${historyStats.kept_turns === 1 ? "" : "s"}, ` +
        `~${historyStats.estimated_tokens} tokens, budget ${historyStats.budget_tokens})` +
        (historyStats.over_budget ? " [OVER BUDGET — latest turn alone]" : ""),
    );
  }

  const messages: Anthropic.MessageParam[] = [
    ...trimmedHistory,
    { role: "user", content: message },
  ];

  // ---------------------------------------------------------------------------
  // Tool-calling loop
  // ---------------------------------------------------------------------------

  const anthropic = new Anthropic({ apiKey });
  const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5";
  const system = buildSystemPrompt(context);

  // -------------------------------------------------------------------------
  // Prompt caching.
  //
  // The system prompt (~3K tokens) and the tool definitions (~10K tokens —
  // grows with the tool catalog; ~19 tools as of the SIE additions) are
  // identical across every iteration of the tool-calling loop, and
  // largely identical across different users within a 5-minute window.
  // Marking them as cacheable tells Anthropic to remember the rendered
  // preamble and serve it from cache on subsequent calls at ~10% of the
  // normal input-token cost and latency.
  //
  // Two breakpoints, longest match wins:
  //   1. cache_control on the LAST tool       → caches tools alone
  //      (matches even when the user/role in the system prompt differs).
  //   2. cache_control on the system block    → caches tools + system
  //      (matches when the same user fires multiple calls in 5 minutes —
  //       e.g. all iterations of one tool-heavy turn).
  // -------------------------------------------------------------------------
  const systemBlocks: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      text: system,
      cache_control: { type: "ephemeral" },
    },
  ];
  const cachedTools: Anthropic.Tool[] = TOOL_DEFINITIONS.map((tool, index) =>
    index === TOOL_DEFINITIONS.length - 1
      ? { ...tool, cache_control: { type: "ephemeral" } }
      : tool,
  );

  const toolTrace: ToolCallTrace[] = [];
  const collectedSources = new Map<string, DocumentSource>();

  let finalText: string | null = null;
  let lastResponse: Anthropic.Message | null = null;
  // Narration text Claude produces alongside tool_use blocks. Without
  // buffering this, anything Claude says before the final iteration is lost
  // if we hit the iteration cap.
  const narrationBuffer: string[] = [];

  const extractText = (response: Anthropic.Message): string =>
    response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

  // contextOverflowed signals the catch-block hit a context-window error.
  // We surface a friendly message rather than the raw APIError JSON — same
  // shape as the iteration-cap fallback below so the UI's rendering path
  // doesn't have to differentiate.
  let contextOverflowed = false;

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
    let response: Anthropic.Message;
    try {
      response = await withTimeout(
        anthropic.messages.create({
          model,
          max_tokens: MAX_OUTPUT_TOKENS,
          system: systemBlocks,
          tools: cachedTools,
          messages,
        }),
        ANTHROPIC_CALL_TIMEOUT_MS,
        `anthropic.messages.create (iter ${iteration + 1})`,
      );
    } catch (err) {
      if (isContextOverflowError(err)) {
        // Don't bubble — convert into a graceful answer. The user's question
        // was legitimate; it just hit a data-volume limit that the pre-
        // aggregated tools (get_top_customers, get_kpi_summary,
        // get_kpi_by_consultant) are designed to avoid. The fallback nudges
        // toward those rather than reporting "internal error".
        console.warn(
          `[/api/chat] context overflow on iter ${iteration + 1}:`,
          err instanceof Error ? err.message : String(err),
        );
        contextOverflowed = true;
        break;
      }
      throw err;
    }
    lastResponse = response;

    // Surface prompt-cache usage so we can verify caching is actually firing.
    // `cache_read_input_tokens` > 0 means we hit the cache; `cache_creation_input_tokens`
    // > 0 means we just wrote a new cache entry (the first call of a 5-min window).
    const usage = response.usage;
    if (
      usage &&
      ((usage.cache_read_input_tokens ?? 0) > 0 ||
        (usage.cache_creation_input_tokens ?? 0) > 0)
    ) {
      console.log(
        `[/api/chat] iter ${iteration + 1} cache: ` +
          `read=${usage.cache_read_input_tokens ?? 0}, ` +
          `write=${usage.cache_creation_input_tokens ?? 0}, ` +
          `input=${usage.input_tokens}, output=${usage.output_tokens}`,
      );
    }

    if (response.stop_reason === "tool_use") {
      // Buffer intermediate narration so we still have something to show if
      // the loop runs out of iterations.
      const narration = extractText(response);
      if (narration) narrationBuffer.push(narration);

      // Append the assistant's tool_use message to history verbatim.
      messages.push({ role: "assistant", content: response.content });

      const toolUseBlocks = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
      );

      // Run independent tool calls in parallel — Claude often emits 2–4
      // tool_use blocks in one assistant message (e.g. resolve_customer +
      // get_customer_overview), and serializing them was a major contributor
      // to the apparent "stuck loading" feel.
      for (const block of toolUseBlocks) {
        toolTrace.push({ name: block.name, input: block.input });
      }
      const settled = await Promise.all(
        toolUseBlocks.map(async (block) => {
          try {
            const result = await executeTool(block.name, block.input, context);
            return { block, result, errored: false };
          } catch (err) {
            const message =
              err instanceof Error ? err.message : "Unknown tool error.";
            console.error(
              `[/api/chat] tool ${block.name} threw:`,
              err,
            );
            return {
              block,
              result: { error: message } as unknown,
              errored: true,
            };
          }
        }),
      );

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const { block, result } of settled) {
        // Capture document sources from search_documents calls so the route
        // can surface them in the response (the UI renders these as
        // "Källa: ..." footers under each assistant message).
        if (
          block.name === "search_documents" &&
          result &&
          typeof result === "object" &&
          "sources" in result &&
          Array.isArray((result as { sources?: unknown }).sources)
        ) {
          for (const source of (result as { sources: DocumentSource[] })
            .sources) {
            if (!source?.file_name) continue;
            // Drop weak matches — see MIN_SOURCE_SIMILARITY comment. The
            // model sometimes calls search_documents speculatively, and
            // surfacing 0.14-similarity files as "Källa" footers misleads
            // the user into thinking the answer was grounded in those docs.
            if (
              typeof source.similarity !== "number" ||
              source.similarity < MIN_SOURCE_SIMILARITY
            ) {
              continue;
            }
            const key = source.file_name.trim().toLowerCase();
            const existing = collectedSources.get(key);
            if (!existing || source.similarity > existing.similarity) {
              collectedSources.set(key, source);
            }
          }
        }

        // Compact the result before sending it back to Claude. The full
        // `result` object stays available above for source-extraction etc.;
        // only the JSON that lands in `messages` (and therefore counts
        // toward input tokens on every subsequent iteration) is trimmed.
        const { compacted, stats } = compactToolResult(block.name, result);
        if (stats.trimmed_fields.length > 0) {
          console.log(
            `[/api/chat] compacted ${block.name}: ${stats.before} → ${stats.after} chars`,
            stats.trimmed_fields,
          );
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(compacted ?? null),
        });
      }

      messages.push({ role: "user", content: toolResults });
      continue;
    }

    // end_turn (or any non-tool stop_reason) → collect final text.
    finalText = extractText(response);
    break;
  }

  // Iteration cap, context overflow, or empty final text — return whatever
  // we've buffered with a clear note rather than a generic 500. The UI can
  // still render useful narration about what Claude managed to do before
  // stopping.
  if (finalText == null || finalText.length === 0) {
    if (contextOverflowed) {
      const buffered = narrationBuffer.join("\n\n").trim();
      finalText =
        buffered.length > 0
          ? `${buffered}\n\n${CONTEXT_OVERFLOW_FALLBACK}`
          : CONTEXT_OVERFLOW_FALLBACK;
    } else {
      const buffered = narrationBuffer.join("\n\n").trim();
      finalText =
        buffered.length > 0
          ? `${buffered}\n\n_(Stoppade här efter ${MAX_TOOL_ITERATIONS} verktygsanrop — fråga gärna mer specifikt så går det fortare.)_`
          : `Hann inte fram till ett färdigt svar inom ${MAX_TOOL_ITERATIONS} verktygsanrop. Försök gärna ställa frågan mer specifikt.`;
    }
  }

  // Persistence is owned by the client (DashboardAskQuestion stores its own
  // conversations rows), so this endpoint is read-only with respect to the
  // conversations table — it loads history when given conversation_id, but
  // never inserts or updates. `sources` mirrors the shape returned by
  // /api/questions/ask-documents so the UI's footer rendering Just Works.
  void lastResponse;

  const sources = Array.from(collectedSources.values()).sort(
    (a, b) => b.similarity - a.similarity,
  );

  return NextResponse.json({
    conversation_id: conversationId,
    answer: finalText,
    sources,
    tool_calls: toolTrace,
  });
}
