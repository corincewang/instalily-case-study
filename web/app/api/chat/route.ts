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
import { runChatWithLlmTools } from "@/lib/llm/runChatAgent";
import type { Citation } from "@/lib/retrieveExact";

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

type ChatRequestBody = {
  message?: unknown;
  messages?: unknown;
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

  const useLlm = Boolean(process.env.OPENAI_API_KEY?.trim());

  if (useLlm) {
    try {
      const out = await runChatWithLlmTools(message);
      const blocks = buildBlocksFromRetrieval(out.retrieval, message);
      const suggested_actions = buildSuggestedActionsFromRetrieval(
        out.retrieval,
        message
      );
      // Deterministic reply overrides for empty-block responses. Order:
      //   (1) out-of-scope — "am I even in domain?" gates everything else,
      //       since intent classification is word-based and words like
      //       "replace" fire `install` intent even on "replace the belt on
      //       my dryer". Also the only defense against prompt injection.
      //   (2) clarify — query IS in-domain but missing a field.
      // The in-scope whitelist inside `detectOutOfScope` ensures queries that
      // mention our appliances (even vaguely) bypass (1) and reach (2).
      const oos =
        blocks.length === 0 ? buildOutOfScopeReplyFromRetrieval(message) : null;
      const clar =
        blocks.length === 0 && !oos
          ? buildClarifyReplyFromRetrieval(out.retrieval, message)
          : null;
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

  const { retrieval, tool_trace, normalization } =
    runToolsForUserMessage(message);
  const blocks = buildBlocksFromRetrieval(retrieval, message);
  // Deterministic reply override chain for empty-block responses:
  //   OOS (domain refusal) → clarify (in-domain, missing field) → default "no match".
  // OOS is first: intent classification is word-based, so "replace the belt on
  // my dryer" lights up `install` intent and would otherwise ask for a PS number
  // instead of refusing. The in-scope whitelist inside `detectOutOfScope` makes
  // sure real in-domain queries never get refused here.
  const oos =
    blocks.length === 0 ? buildOutOfScopeReplyFromRetrieval(message) : null;
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
