/**
 * POST /api/chat — single entry point for the PartSelect chat agent.
 *
 * This agent covers **refrigerator & dishwasher parts only**. Every user turn
 * is routed through one of seven query categories; the category drives which
 * card (if any) is rendered, which chips are suggested, and what the reply
 * text says. Categories are detected by the lightweight intent classifier in
 * `buildChatBlocks.ts` and by the out-of-scope / clarify detectors.
 *
 *   1. Install by PS number        → `support(install)` card with steps
 *   2. Compatibility by model      → `support(compat)` card with verdict
 *   3. Symptom → repair guide      → `support(repair)` card with steps
 *      (3b) Symptom → candidate parts (reverse diagnosis)
 *                                  → `support(candidates)` card
 *   4. Part lookup / browse        → `support(candidates)` list or `product`
 *   5. — (reserved; order-support was removed as out of scope)
 *   6. Out-of-scope handling       → reply refusal + in-domain chips, no card
 *   7. Missing info / clarify      → reply question + example chips, no card
 *
 * Handler contract:
 *   1. Parse/validate the request body; reject malformed input with 400.
 *   2. Run retrieval (via LLM-driven tools when OPENAI_API_KEY is set,
 *      otherwise a deterministic fallback).
 *   3. Build structured `blocks` from the retrieval (categories 1–4).
 *   4. Apply the deterministic reply-override chain: OOS (6) → clarify (7)
 *      → fallback "no match" text. Overrides only fire when no block was
 *      rendered — they are the "what do we say when we have nothing to show"
 *      policy.
 *   5. Filter citations to the block ids actually rendered, then return the
 *      full response envelope.
 */
import { NextResponse } from "next/server";

import { runToolsForUserMessage } from "@/lib/agentTools";
import {
  buildBlocksFromRetrieval,
  buildClarifyReplyFromRetrieval,
  buildOutOfScopeReplyFromRetrieval,
  buildSuggestedActionsFromRetrieval,
  type ChatBlock,
} from "@/lib/buildChatBlocks";
import { formatCatalogReplyFromRetrieval } from "@/lib/formatCatalogReply";
import type { HistoryTurn } from "@/lib/llm/runChatAgent";
import { runChatWithLlmTools } from "@/lib/llm/runChatAgent";
import type { Citation, SessionContext } from "@/lib/retrieveExact";

/**
 * 2-P1: keep only citations whose id is actually rendered as a block (or as a row
 * inside a `candidates` support block — each candidate references a catalog part id).
 */
function alignCitationsToBlocks(
  citations: Citation[],
  blocks: ChatBlock[]
): Citation[] {
  const referencedIds = new Set<string>();
  for (const b of blocks) {
    referencedIds.add(b.id);
    if (b.type === "support" && b.kind === "candidates" && b.candidates) {
      for (const c of b.candidates) referencedIds.add(c.id);
    }
  }
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const c of citations) {
    if (!referencedIds.has(c.id) || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

/** A single prior turn from the client conversation history. */
type HistoryTurnRaw = { role?: unknown; content?: unknown };

/**
 * Parse the `history` array sent by the client.
 * We only trust turns with role "user" | "assistant" and a string content.
 * Any malformed entries are silently dropped so bad client state never 400s.
 */
function parseHistory(raw: unknown): HistoryTurn[] {
  if (!Array.isArray(raw)) return [];
  const out: HistoryTurn[] = [];
  for (const item of raw as HistoryTurnRaw[]) {
    if (
      (item.role === "user" || item.role === "assistant") &&
      typeof item.content === "string" &&
      item.content.trim().length > 0
    ) {
      out.push({ role: item.role, content: item.content.trim() });
    }
  }
  return out;
}

const PS_TOKEN_RE = /\bPS\d{5,}\b/gi;

/**
 * Walk the history backwards to find the most recently mentioned PS number and
 * model token. These become the `SessionContext` that lets retrieveExact carry
 * values forward without the user repeating themselves.
 *
 * Heuristic: look through assistant and user turns alike — the agent may have
 * confirmed a part number in its own reply.
 */
function extractContext(history: HistoryTurn[]): SessionContext {
  let partNumber: string | undefined;
  let model: string | undefined;

  // Scan newest-first so we pick up the most recent resolved values.
  for (let i = history.length - 1; i >= 0; i--) {
    const { content } = history[i];
    if (!partNumber) {
      const m = [...content.matchAll(PS_TOKEN_RE)];
      if (m.length > 0) partNumber = m[0][0].toUpperCase();
    }
    if (!model) {
      // Same regex as agentTools.ts extractModelToken — PS##### excluded.
      const tokens = [...content.toUpperCase().matchAll(/\b([A-Z]{2,}\d{3,}[A-Z0-9]{2,})\b/g)];
      const hit = tokens.find((m) => !m[1].startsWith("PS"));
      if (hit) model = hit[1];
    }
    if (partNumber && model) break;
  }

  return { partNumber, model };
}

type ChatRequestBody = {
  message?: unknown;
  history?: unknown;
};

export async function POST(request: Request) {
  let body: ChatRequestBody;
  try {
    body = (await request.json()) as ChatRequestBody;
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "Body must be JSON." },
      { status: 400 }
    );
  }

  const message =
    typeof body.message === "string" ? body.message.trim() : "";

  if (!message) {
    return NextResponse.json(
      {
        error: "invalid_body",
        message: "Field `message` (non-empty string) is required.",
      },
      { status: 400 }
    );
  }

  const history = parseHistory(body.history);
  const context = extractContext(history);

  const useLlm = Boolean(process.env.OPENAI_API_KEY?.trim());

  // OOS gate runs first on the raw message — before retrieval results influence
  // block building. If the message is out-of-scope, we force blocks to empty
  // regardless of what retrieval found (e.g. an accidental keyword overlap).
  // The in-scope whitelist inside `detectOutOfScope` ensures real in-domain
  // queries (mentioning our appliances) bypass this gate.
  const oos = buildOutOfScopeReplyFromRetrieval(message);

  if (useLlm) {
    try {
      const out = await runChatWithLlmTools(message, history, context);
      // If OOS, suppress all blocks — reply only.
      const blocks = oos ? [] : buildBlocksFromRetrieval(out.retrieval, message);
      const clar =
        blocks.length === 0 && !oos
          ? buildClarifyReplyFromRetrieval(out.retrieval, message)
          : null;
      const suggested_actions = buildSuggestedActionsFromRetrieval(
        out.retrieval,
        message
      );
      const citations = alignCitationsToBlocks(out.citations, blocks);
      return NextResponse.json({
        reply: oos ? oos.reply : clar ? clar.reply : out.reply,
        blocks,
        citations,
        suggested_actions,
        no_evidence: blocks.length === 0,
        normalized_part_numbers: out.normalized_part_numbers,
        tool_trace: out.tool_trace,
        used_llm: true,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "LLM error";
      return NextResponse.json(
        { error: "llm_failed", message: msg },
        { status: 502 }
      );
    }
  }

  // Deterministic (no-LLM) path.
  const { tool_trace, normalization, retrieval } = runToolsForUserMessage(message, context);
  // If OOS, suppress all blocks.
  const blocks = oos ? [] : buildBlocksFromRetrieval(retrieval, message);
  const clar =
    blocks.length === 0 && !oos ? buildClarifyReplyFromRetrieval(retrieval, message) : null;
  const reply = formatCatalogReplyFromRetrieval(
    retrieval,
    message,
    oos?.reply ?? clar?.reply
  );
  const suggested_actions = buildSuggestedActionsFromRetrieval(retrieval, message);
  const citations = alignCitationsToBlocks(retrieval.citations, blocks);

  return NextResponse.json({
    reply,
    blocks,
    citations,
    suggested_actions,
    no_evidence: blocks.length === 0,
    normalized_part_numbers: normalization.part_numbers,
    tool_trace,
    used_llm: false,
  });
}
