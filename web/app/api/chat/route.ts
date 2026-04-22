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
  conversationOnlyResponse,
  type ChatBlock,
} from "@/lib/buildChatBlocks";
import { formatCatalogReplyFromRetrieval } from "@/lib/formatCatalogReply";
import type { HistoryTurn } from "@/lib/llm/runChatAgent";
import { streamChatWithLlmTools } from "@/lib/llm/runChatAgent";
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

/** NDJSON streaming helpers */
const encoder = new TextEncoder();
function encodeEvent(obj: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(obj) + "\n");
}

function streamResponse(
  fn: (send: (obj: unknown) => void) => Promise<void>
): Response {
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encodeEvent(obj));
      try {
        await fn(send);
      } catch (e) {
        send({ type: "error", message: e instanceof Error ? e.message : "Unknown error" });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

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

  const convoOnly = conversationOnlyResponse(message);
  if (convoOnly) {
    return streamResponse(async (send) => {
      const words = convoOnly.reply.split(" ");
      for (const word of words) {
        send({ type: "token", text: word + " " });
        await new Promise((r) => setTimeout(r, 12));
      }
      send({
        type: "done",
        blocks: [],
        citations: [],
        suggested_actions: [
          { id: "co-find", label: "Find part by PS", prompt: "Find part PS11752778" },
          {
            id: "co-compat",
            label: "Check compatibility",
            prompt: "Is PS11752778 compatible with WRS325SDHZ?",
          },
          {
            id: "co-symptom",
            label: "Ice maker not working",
            prompt:
              "The ice maker on my Whirlpool fridge is not working. How can I fix it?",
          },
        ],
        no_evidence: true,
        normalized_part_numbers: [],
        tool_trace: [],
        used_llm: false,
      });
    });
  }

  const history = parseHistory(body.history);
  const context = extractContext(history);

  // Deterministic answers for common informational questions that don't need retrieval.
  const GLOSSARY: { pattern: RegExp; reply: string }[] = [
    {
      pattern: /\bwhat\s+is\s+a?\s*ps\s*(number|#|num)?\b/i,
      reply:
        "A PS number (PartSelect number) is a unique part identifier used on PartSelect.com. " +
        "It always starts with \"PS\" followed by 5–8 digits — for example, PS11752778. " +
        "You'll find it on the part's product page, your order history, or sometimes printed on the part itself. " +
        "Sharing a PS number is the fastest way to look up exact pricing, stock, compatibility, and installation steps.",
    },
    {
      pattern: /\bwhat\s+is\s+an?\s*(oem|oem\s+code|oem\s+number|oem\s+part)\b/i,
      reply:
        "An OEM code (Original Equipment Manufacturer part number) is the manufacturer's own identifier for a part — " +
        "for example, Whirlpool might use W10321304 or WPW10321304 for the same door shelf bin. " +
        "OEM numbers appear on the old part itself, in your appliance's tech sheet, or in the service manual. " +
        "You can search by OEM number on PartSelect and it will map to the correct PS number automatically.",
    },
    {
      pattern: /\b(speak|talk|connect|chat)\s+(to|with)\s+a?\s*(human|person|agent|representative|rep|someone)\b/i,
      reply:
        "I'm a virtual assistant — I can't connect you directly to a live agent from this chat window. " +
        "For order issues, returns, or anything I can't resolve, please reach PartSelect support at " +
        "1-888-738-4871 (Mon–Fri 8 AM–8 PM ET, Sat 9 AM–5 PM ET) or use the contact form at " +
        "partselect.com/Contact-Us. Is there anything else I can help you find in the meantime?",
    },
  ];
  for (const { pattern, reply } of GLOSSARY) {
    if (pattern.test(message)) {
      // Short glossary answers: stream the reply text word-by-word, then done.
      const words = reply.split(" ");
      return streamResponse(async (send) => {
        for (const word of words) {
          send({ type: "token", text: word + " " });
          await new Promise((r) => setTimeout(r, 12));
        }
        send({
          type: "done",
          blocks: [],
          citations: [],
          suggested_actions: [
            { id: "g-find", label: "Find a part by PS number", prompt: "Find part PS11752778" },
            { id: "g-compat", label: "Check compatibility", prompt: "Is PS11752778 compatible with WRS325SDHZ?" },
          ],
          no_evidence: true,
          normalized_part_numbers: [],
          tool_trace: [],
          used_llm: false,
        });
      });
    }
  }

  const useLlm = Boolean(process.env.OPENAI_API_KEY?.trim());
  const oos = buildOutOfScopeReplyFromRetrieval(message);

  if (useLlm) {
    return streamResponse(async (send) => {
      const out = await streamChatWithLlmTools(
        message,
        history,
        context,
        (token) => send({ type: "token", text: token })
      );
      const blocks = oos ? [] : buildBlocksFromRetrieval(out.retrieval, message);
      const clar =
        blocks.length === 0 && !oos
          ? buildClarifyReplyFromRetrieval(out.retrieval, message)
          : null;

      // If OOS or clarify overrides the reply, emit the override text as a
      // "replace" event so the client can swap out whatever was streamed.
      const overrideReply = oos ? oos.reply : clar ? clar.reply : null;
      if (overrideReply) {
        send({ type: "replace", text: overrideReply });
      }

      send({
        type: "done",
        blocks,
        citations: alignCitationsToBlocks(out.citations, blocks),
        suggested_actions: buildSuggestedActionsFromRetrieval(out.retrieval, message),
        no_evidence: blocks.length === 0,
        normalized_part_numbers: out.normalized_part_numbers,
        tool_trace: out.tool_trace,
        used_llm: true,
      });
    });
  }

  // ── Deterministic (no-LLM) path ──────────────────────────────────────────
  const { tool_trace, normalization, retrieval } = runToolsForUserMessage(message, context);
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

  // Stream the deterministic reply word-by-word for a consistent streaming UX.
  return streamResponse(async (send) => {
    const words = reply.split(" ");
    for (const word of words) {
      send({ type: "token", text: word + " " });
      await new Promise((r) => setTimeout(r, 12));
    }
    send({
      type: "done",
      blocks,
      citations,
      suggested_actions,
      no_evidence: blocks.length === 0,
      normalized_part_numbers: normalization.part_numbers,
      tool_trace,
      used_llm: false,
    });
  });
}
