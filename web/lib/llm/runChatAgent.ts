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
} from "../agentTools";
import catalog from "../../data/catalog.json";
import { formatCatalogReplyFromRetrieval } from "../formatCatalogReply";
import type { Citation, SessionContext } from "../retrieveExact";
import { retrieveExact } from "../retrieveExact";
import { fetchPartPageTool } from "../tools/fetchPartPage";
import { executePartselectTool } from "../toolExecutor";
import { PARTSELECT_OPENAI_TOOLS } from "./openaiTools";
import { PARTSELECT_AGENT_SYSTEM } from "./systemPrompt";

type RetrievalResult = ReturnType<typeof retrieveExact>;

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

export async function runChatWithLlmTools(
  userMessage: string,
  history: HistoryTurn[] = [],
  context?: SessionContext
): Promise<LlmChatResult> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const model = (process.env.OPENAI_MODEL ?? "gpt-5.4-mini").trim();
  const openai = new OpenAI({ apiKey });

  // Instead of replaying full history turns (expensive: O(tokens × turns)),
  // we inject a single compact session-context line into the system prompt.
  // This gives the LLM the resolved part/model without inflating the context window.
  // The resolved values come from `extractContext` in the route, which scans history
  // deterministically — the LLM never needs to re-read those turns itself.
  const contextLines: string[] = [];
  if (context?.partNumber) contextLines.push(`part ${context.partNumber}`);
  if (context?.model) contextLines.push(`model ${context.model}`);
  const sessionNote =
    contextLines.length > 0
      ? `\n\n[Session context — resolved from prior turns: ${contextLines.join(", ")}. Do not ask the user to repeat this information; use it directly when calling tools.]`
      : "";

  const systemContent = PARTSELECT_AGENT_SYSTEM + sessionNote;

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
    if (!choice) {
      break;
    }

    const toolCalls = choice.tool_calls ?? [];
    messages.push(choice);

    if (toolCalls.length === 0) {
      break;
    }

    for (const tc of toolCalls) {
      if (tc.type !== "function") continue;
      const name = tc.function.name;
      const argsJson = tc.function.arguments ?? "{}";

      // fetch_part_page is async (network call) — handle separately.
      let exec: ToolTraceEntry;
      if (name === FETCH_PART_PAGE_TOOL_NAME) {
        try {
          const args = JSON.parse(argsJson) as { part_number?: string };
          const result = await fetchPartPageTool({ part_number: args.part_number ?? "" });
          exec = { name: FETCH_PART_PAGE_TOOL_NAME, ok: result.ok, output: result };
        } catch {
          exec = { name: FETCH_PART_PAGE_TOOL_NAME, ok: false, output: { error: "fetch_failed" } };
        }
      } else {
        exec = executePartselectTool(name, argsJson, context);
      }

      tool_trace.push({
        name: exec.name,
        ok: exec.ok,
        output: exec.output,
      });

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
    // The LLM called a specific tool but never called catalog_search.
    // Build the retrieval object directly from the tool outputs — no re-query.
    lastRetrieval =
      buildRetrievalFromTrace(tool_trace) ??
      // Ultimate fallback: user message had no useful tool output at all.
      retrieveExact(userMessage, context);
    tool_trace.push({
      name: CATALOG_SEARCH_TOOL_NAME,
      ok: true,
      output: lastRetrieval,
    });
  }

  const lastMsg = messages[messages.length - 1]!;
  let replyText = "";
  if (lastMsg.role === "assistant" && typeof lastMsg.content === "string") {
    replyText = lastMsg.content.trim();
  }

  if (!replyText) {
    const finalCompletion = await openai.chat.completions.create({
      model,
      messages,
    });
    const m = finalCompletion.choices[0]?.message;
    if (m) {
      messages.push(m);
    }
    replyText = typeof m?.content === "string" ? m.content.trim() : "";
  }

  if (!replyText) {
    replyText = formatCatalogReplyFromRetrieval(lastRetrieval, userMessage);
  }

  // Consistency guard: if the LLM said "no match / couldn't find" but retrieval
  // actually found content (guide, part, candidates), the LLM was working from
  // stale/incomplete tool output. Override with the deterministic reply so the
  // text and the cards always agree.
  const hasContent = !!(
    lastRetrieval.guide ??
    lastRetrieval.part ??
    lastRetrieval.compatibility ??
    (lastRetrieval.candidates && lastRetrieval.candidates.length > 0)
  );
  const llmSaysMiss = /couldn.t\s+match|couldn.t\s+find|no\s+match|not\s+find|unable\s+to\s+find|nothing\s+in|didn.t\s+find|not\s+found\s+in|no\s+result/i.test(replyText);
  if (hasContent && llmSaysMiss) {
    replyText = formatCatalogReplyFromRetrieval(lastRetrieval, userMessage);
  }

  return {
    reply: replyText,
    citations: lastRetrieval.citations,
    normalized_part_numbers: Array.from(normalized),
    tool_trace,
    used_llm: true,
    retrieval: lastRetrieval,
  };
}
