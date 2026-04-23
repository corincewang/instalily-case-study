import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import type { ToolTraceEntry } from "../agentTools";
import {
  CATALOG_SEARCH_TOOL_NAME,
  CHECK_COMPATIBILITY_TOOL_NAME,
  FETCH_PART_PAGE_TOOL_NAME,
  GET_INSTALL_GUIDE_TOOL_NAME,
  LOOKUP_PART_TOOL_NAME,
  NORMALIZE_PART_NUMBER_TOOL_NAME,
  SEARCH_BY_SYMPTOM_TOOL_NAME,
  SEMANTIC_SEARCH_TOOL_NAME,
} from "../agentTools";
import catalog from "../../data/catalog.json";
import { formatCatalogReplyFromRetrieval } from "../formatCatalogReply";
import type { Citation, SessionContext } from "../retrieveExact";
import { allowSessionCarryForRetrieval, retrieveExact } from "../retrieveExact";
import { fetchPartPageTool } from "../tools/fetchPartPage";
import { semanticSearchTool } from "../tools/semanticSearch";
import { executePartselectTool } from "../toolExecutor";
import { PARTSELECT_OPENAI_TOOLS } from "./openaiTools";
import { PARTSELECT_AGENT_SYSTEM } from "./systemPrompt";

type RetrievalResult = ReturnType<typeof retrieveExact>;

/**
 * Same gate as `retrieveExact`: only expose PS/model session to the LLM and
 * `catalog_search` when the current message continues a parts task. Otherwise
 * the system prompt's "use session when calling tools" line makes the model
 * call `check_compatibility` on vague follow-ups like "narrow it down".
 */
function gatedSessionContext(
  userMessage: string,
  context: SessionContext | undefined
): SessionContext | undefined {
  if (!context?.partNumber && !context?.model) return undefined;
  return allowSessionCarryForRetrieval(userMessage, userMessage.toLowerCase())
    ? context
    : undefined;
}

function pushCite(citations: Citation[], c: Citation) {
  if (!citations.some((x) => x.id === c.id)) citations.push(c);
}

/**
 * Convert specific-tool outputs in the trace into a `retrieveExact`-compatible
 * retrieval object using direct catalog lookups — no re-query of the full
 * retrieval pipeline.
 *
 * Priority: lookup_part → get_install_guide → check_compatibility →
 *           search_by_symptom. Returns null if no usable output was found.
 */
type CatalogPart = (typeof catalog.parts)[number];
type CatalogCompat = (typeof catalog.compatibilities)[number];

function buildRetrievalFromTrace(
  trace: ToolTraceEntry[]
): RetrievalResult | null {
  const citations: Citation[] = [];
  let part: CatalogPart | undefined;
  let compatibility: CatalogCompat | undefined;

  for (const entry of trace) {
    if (!entry.ok) continue;

    if (entry.name === LOOKUP_PART_TOOL_NAME) {
      const o = entry.output as { ok?: boolean; part?: CatalogPart };
      if (o?.ok && o.part) {
        part ??= o.part;
        pushCite(citations, { id: o.part.id, source: "part_catalog", label: "Part catalog" });
      }
    }

    if (entry.name === GET_INSTALL_GUIDE_TOOL_NAME) {
      const o = entry.output as { ok?: boolean; partNumber?: string };
      if (o?.ok && o.partNumber && !part) {
        part = (catalog.parts as CatalogPart[]).find(
          (p) => p.partNumber.toUpperCase() === o.partNumber!.toUpperCase()
        );
        if (part) pushCite(citations, { id: part.id, source: "part_catalog", label: "Part catalog" });
      }
    }

    if (entry.name === CHECK_COMPATIBILITY_TOOL_NAME) {
      const o = entry.output as { ok?: boolean; rowId?: string; partNumber?: string };
      if (o?.ok && o.rowId) {
        compatibility ??= (catalog.compatibilities as CatalogCompat[]).find((r) => r.id === o.rowId);
        if (compatibility) {
          pushCite(citations, {
            id: compatibility.id,
            source: "compatibility_database",
            label: "Compatibility database",
          });
        }
        if (o.partNumber && !part) {
          part = (catalog.parts as CatalogPart[]).find(
            (p) => p.partNumber.toUpperCase() === o.partNumber!.toUpperCase()
          );
          if (part) pushCite(citations, { id: part.id, source: "part_catalog", label: "Part catalog" });
        }
      }
    }

    // fetch_part_page: synthesize a catalog-compatible part from the live PartSelect data.
    if (entry.name === FETCH_PART_PAGE_TOOL_NAME) {
      const o = entry.output as {
        ok?: boolean;
        partNumber?: string;
        title?: string;
        price?: number;
        inStock?: boolean;
        description?: string;
        rating?: number;
        reviewCount?: number;
        source?: string;
      };
      if (o?.ok && o.partNumber && !part) {
        // Build a minimal catalog-part shape so the existing ProductBlock path can render it.
        // Fields not available from the live fetch are left undefined/omitted.
        const livePart = {
          id: `live-${o.partNumber}`,
          partNumber: o.partNumber,
          title: o.title ?? o.partNumber,
          applianceFamily: "refrigerator or dishwasher",
          keywords: [],
          symptoms: [],
          installSteps: o.description ?? "",
          price: o.price,
          currency: "USD" as const,
          inStock: o.inStock,
          rating: o.rating,
          reviewCount: o.reviewCount,
          // Signal to the UI that this came from a live fetch, not the local catalog
          _liveSource: true,
        } as unknown as CatalogPart;
        part = livePart;
        pushCite(citations, {
          id: livePart.id,
          source: "part_catalog",
          label: "PartSelect.com (live)",
        });
      }
    }

    // search_by_symptom is intentionally NOT handled here.
    // Symptom queries may also match a repairGuide (via matchIncludesAll in
    // retrieveExact) which search_by_symptom doesn't cover. If the LLM only
    // called search_by_symptom, buildRetrievalFromTrace returns null and we
    // fall through to the full retrieveExact(userMessage) below.
  }

  if (!part && !compatibility) return null;
  return { citations, part, compatibility };
}

/** A single turn in the conversation, as sent from the client. */
export type HistoryTurn = {
  role: "user" | "assistant";
  content: string;
};

export type LlmChatResult = {
  reply: string;
  citations: Citation[];
  normalized_part_numbers: string[];
  tool_trace: ToolTraceEntry[];
  used_llm: true;
  /** Last catalog retrieval; API route builds blocks from this (not sent as a top-level field). */
  retrieval: ReturnType<typeof retrieveExact>;
};

const MAX_TOOL_ROUNDS = 6;

/** Shared setup: parse args, build messages, run the tool loop. */
async function runToolLoop(
  userMessage: string,
  history: HistoryTurn[],
  context: SessionContext | undefined,
  openai: OpenAI,
  model: string,
  systemContent: string
): Promise<{
  messages: ChatCompletionMessageParam[];
  tool_trace: ToolTraceEntry[];
  normalized: Set<string>;
  lastRetrieval: ReturnType<typeof retrieveExact>;
}> {
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemContent },
    { role: "user", content: userMessage },
  ];

  const tool_trace: ToolTraceEntry[] = [];
  const normalized = new Set<string>();
  let lastRetrieval: ReturnType<typeof retrieveExact> | null = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const completion = await openai.chat.completions.create({
      model,
      messages,
      tools: PARTSELECT_OPENAI_TOOLS,
      tool_choice: "auto",
    });

    const choice = completion.choices[0]?.message;
    if (!choice) break;

    const toolCalls = choice.tool_calls ?? [];
    messages.push(choice);
    if (toolCalls.length === 0) break;

    for (const tc of toolCalls) {
      if (tc.type !== "function") continue;
      const name = tc.function.name;
      const argsJson = tc.function.arguments ?? "{}";

      let exec: ToolTraceEntry;
      if (name === FETCH_PART_PAGE_TOOL_NAME) {
        try {
          const args = JSON.parse(argsJson) as { part_number?: string };
          const result = await fetchPartPageTool({ part_number: args.part_number ?? "" });
          exec = { name: FETCH_PART_PAGE_TOOL_NAME, ok: result.ok, output: result };
        } catch {
          exec = { name: FETCH_PART_PAGE_TOOL_NAME, ok: false, output: { error: "fetch_failed" } };
        }
      } else if (name === SEMANTIC_SEARCH_TOOL_NAME) {
        try {
          const args = JSON.parse(argsJson) as { query?: string };
          const result = await semanticSearchTool({ query: args.query ?? "" });
          exec = { name: SEMANTIC_SEARCH_TOOL_NAME, ok: result.ok, output: result };
        } catch {
          exec = { name: SEMANTIC_SEARCH_TOOL_NAME, ok: false, output: { error: "semantic_search_failed" } };
        }
      } else {
        exec = executePartselectTool(name, argsJson, context);
      }

      tool_trace.push({ name: exec.name, ok: exec.ok, output: exec.output });

      if (exec.ok && exec.name === NORMALIZE_PART_NUMBER_TOOL_NAME && exec.output) {
        const o = exec.output as { part_numbers: string[] };
        o.part_numbers.forEach((p) => normalized.add(p));
      }
      if (exec.ok && exec.name === CATALOG_SEARCH_TOOL_NAME && exec.output) {
        lastRetrieval = exec.output as ReturnType<typeof retrieveExact>;
      }

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(exec.output ?? { error: "no_output" }),
      });
    }
  }

  if (!lastRetrieval) {
    lastRetrieval =
      buildRetrievalFromTrace(tool_trace) ?? retrieveExact(userMessage, context);
    tool_trace.push({ name: CATALOG_SEARCH_TOOL_NAME, ok: true, output: lastRetrieval });
  }

  return { messages, tool_trace, normalized, lastRetrieval };
}

function buildSystemContent(context?: SessionContext): string {
  const contextLines: string[] = [];
  if (context?.partNumber) contextLines.push(`part ${context.partNumber}`);
  if (context?.model) contextLines.push(`model ${context.model}`);
  const sessionNote =
    contextLines.length > 0
      ? `\n\n[Session context — resolved from prior turns: ${contextLines.join(", ")}. Prefer these anchors when the user's *current* message continues the same parts task (install, price/stock, fit, or lookup). Do not call check_compatibility with them on vague follow-ups (e.g. "yes", "narrow it down") unless the user clearly means that specific part and model.]`
      : "";
  return PARTSELECT_AGENT_SYSTEM + sessionNote;
}

function applyConsistencyGuard(
  replyText: string,
  retrieval: ReturnType<typeof retrieveExact>,
  userMessage: string
): string {
  const hasContent = !!(
    retrieval.guide ??
    retrieval.part ??
    retrieval.compatibility ??
    (retrieval.candidates && retrieval.candidates.length > 0)
  );
  const llmSaysMiss =
    /couldn.t\s+match|couldn.t\s+find|no\s+match|not\s+find|unable\s+to\s+find|nothing\s+in|didn.t\s+find|not\s+found\s+in|no\s+result/i.test(
      replyText
    );
  return hasContent && llmSaysMiss
    ? formatCatalogReplyFromRetrieval(retrieval, userMessage)
    : replyText;
}

export async function runChatWithLlmTools(
  userMessage: string,
  history: HistoryTurn[] = [],
  context?: SessionContext
): Promise<LlmChatResult> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const model = (process.env.OPENAI_MODEL ?? "gpt-4o-mini").trim();
  const openai = new OpenAI({ apiKey });
  const gated = gatedSessionContext(userMessage, context);
  const systemContent = buildSystemContent(gated);

  const { messages, tool_trace, normalized, lastRetrieval } = await runToolLoop(
    userMessage, history, gated, openai, model, systemContent
  );

  const lastMsg = messages[messages.length - 1]!;
  let replyText =
    lastMsg.role === "assistant" && typeof lastMsg.content === "string"
      ? lastMsg.content.trim()
      : "";

  if (!replyText) {
    const finalCompletion = await openai.chat.completions.create({ model, messages });
    const m = finalCompletion.choices[0]?.message;
    if (m) messages.push(m);
    replyText = typeof m?.content === "string" ? m.content.trim() : "";
  }

  if (!replyText) replyText = formatCatalogReplyFromRetrieval(lastRetrieval, userMessage);
  replyText = applyConsistencyGuard(replyText, lastRetrieval, userMessage);

  return {
    reply: replyText,
    citations: lastRetrieval.citations,
    normalized_part_numbers: Array.from(normalized),
    tool_trace,
    used_llm: true,
    retrieval: lastRetrieval,
  };
}

/**
 * Streaming variant: runs the tool loop (blocking), then streams the final
 * LLM reply token-by-token via `onToken`. Returns retrieval + metadata so the
 * caller can build blocks and send them after the stream completes.
 */
export async function streamChatWithLlmTools(
  userMessage: string,
  history: HistoryTurn[],
  context: SessionContext | undefined,
  onToken: (text: string) => void
): Promise<LlmChatResult> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const model = (process.env.OPENAI_MODEL ?? "gpt-4o-mini").trim();
  const openai = new OpenAI({ apiKey });
  const gated = gatedSessionContext(userMessage, context);
  const systemContent = buildSystemContent(gated);

  const { messages, tool_trace, normalized, lastRetrieval } = await runToolLoop(
    userMessage, history, gated, openai, model, systemContent
  );

  // If the tool loop already produced a text reply (rare), stream it and return.
  const lastMsg = messages[messages.length - 1]!;
  let replyText =
    lastMsg.role === "assistant" && typeof lastMsg.content === "string"
      ? lastMsg.content.trim()
      : "";

  if (replyText) {
    // Tool loop returned a text reply — emit it as a single token for consistency.
    onToken(replyText);
  } else {
    // Stream the final reply from OpenAI.
    const stream = await openai.chat.completions.create({
      model,
      messages,
      stream: true,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? "";
      if (delta) {
        replyText += delta;
        onToken(delta);
      }
    }
  }

  if (!replyText) replyText = formatCatalogReplyFromRetrieval(lastRetrieval, userMessage);
  replyText = applyConsistencyGuard(replyText, lastRetrieval, userMessage);

  // If the guard overrode the reply, the tokens already sent were wrong — that's
  // a rare edge case; we accept it and let the client reconcile via the `done` event.
  return {
    reply: replyText,
    citations: lastRetrieval.citations,
    normalized_part_numbers: Array.from(normalized),
    tool_trace,
    used_llm: true,
    retrieval: lastRetrieval,
  };
}
