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
 *   2. Run retrieval via the OpenAI tool-calling loop (`OPENAI_API_KEY` required
 *      for catalog-backed turns; see small non-LLM shortcuts below).
 *   3. Build structured `blocks` from the retrieval (categories 1–4).
 *   4. Apply the deterministic reply-override chain: OOS (6) → clarify (7)
 *      → fallback "no match" text. Overrides only fire when no block was
 *      rendered — they are the "what do we say when we have nothing to show"
 *      policy.
 *   5. Filter citations to the block ids actually rendered, then return the
 *      full response envelope.
 */
import { NextResponse } from "next/server";

import {
  buildBlocksFromRetrieval,
  buildClarifyReplyFromRetrieval,
  buildOutOfScopeReplyFromRetrieval,
  buildSuggestedActionsFromRetrieval,
  conversationOnlyResponse,
  type ChatBlock,
} from "@/lib/buildChatBlocks";
import type { HistoryTurn } from "@/lib/llm/runChatAgent";
import { streamChatWithLlmTools } from "@/lib/llm/runChatAgent";
import { resolveCatalogContext } from "@/lib/loadCatalog";
import { MAX_CONVERSATION_SUMMARY_CHARS } from "@/lib/conversationMemory";
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

function firstPsFromContent(content: string): string | undefined {
  const m = [...content.matchAll(PS_TOKEN_RE)];
  return m.length > 0 ? m[0][0].toUpperCase() : undefined;
}

/**
 * OEM / supersession-style tokens that often appear in assistant card copy.
 * They must not steal the session "model" slot from a real appliance model the
 * user typed (e.g. WDT780SAEM1) when we scan newest-first across turns.
 */
function looksLikeOemOrSupersessionToken(tok: string): boolean {
  const u = tok.toUpperCase();
  if (/^WP[A-Z0-9]{4,}$/.test(u)) return true;
  if (/^AP\d{6,}$/.test(u)) return true;
  if (/^W\d{5}[A-Z0-9]*$/i.test(u) && u.length <= 12) return true;
  return false;
}

function firstModelTokenFromContent(content: string): string | undefined {
  const tokens = [...content.toUpperCase().matchAll(/\b([A-Z]{2,}\d{3,}[A-Z0-9]{2,})\b/g)].map(
    (x) => x[1]
  );
  const nonPs = tokens.filter((t) => !t.startsWith("PS"));
  const prefer = nonPs.find((t) => !looksLikeOemOrSupersessionToken(t));
  if (prefer) return prefer;
  return nonPs[0];
}

/**
 * Walk verbatim turns to find the most recently mentioned PS number and model token.
 * These become the `SessionContext` for `retrieveExact` carry-forward.
 *
 * - **User turns first (newest → oldest)** for both anchors so the assistant's
 *   latest card dump (full of OEM codes) does not overwrite the user's model.
 * - **Appliance model preferred over OEM-shaped tokens** within a single message.
 */
function extractContextFromTurns(turns: HistoryTurn[]): SessionContext {
  let partNumber: string | undefined;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role !== "user") continue;
    const p = firstPsFromContent(turns[i].content);
    if (p) {
      partNumber = p;
      break;
    }
  }
  if (!partNumber) {
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].role !== "assistant") continue;
      const p = firstPsFromContent(turns[i].content);
      if (p) {
        partNumber = p;
        break;
      }
    }
  }

  let model: string | undefined;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role !== "user") continue;
    const m = firstModelTokenFromContent(turns[i].content);
    if (m) {
      model = m;
      break;
    }
  }
  if (!model) {
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].role !== "assistant") continue;
      const m = firstModelTokenFromContent(turns[i].content);
      if (m) {
        model = m;
        break;
      }
    }
  }

  return { partNumber, model };
}

/**
 * Same anchors as {@link extractContextFromTurns}, but verbatim `history` wins;
 * optional `conversationSummary` fills missing PS/model from compressed older turns.
 */
function extractContext(history: HistoryTurn[], conversationSummary?: string): SessionContext {
  const ctx = extractContextFromTurns(history);
  const sum = conversationSummary?.trim();
  if (!sum) return ctx;

  let partNumber = ctx.partNumber;
  let model = ctx.model;
  if (!partNumber) {
    const p = firstPsFromContent(sum);
    if (p) partNumber = p;
  }
  if (!model) {
    const m = firstModelTokenFromContent(sum);
    if (m) model = m;
  }
  return { partNumber, model };
}

type ChatRequestBody = {
  message?: unknown;
  history?: unknown;
  conversation_summary?: unknown;
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
          {
            id: "co-find",
            label: "Look up a part",
            prompt:
              "I want to look up a refrigerator or dishwasher part. I have a PartSelect part number—what should I paste here?",
          },
          {
            id: "co-compat",
            label: "Check compatibility",
            prompt:
              "I need to check if a part fits my fridge or dishwasher. I have the part number and my appliance model number.",
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
  const conversationSummaryRaw =
    typeof body.conversation_summary === "string" ? body.conversation_summary.trim() : "";
  const conversationSummary = conversationSummaryRaw.slice(0, MAX_CONVERSATION_SUMMARY_CHARS);
  const context = extractContext(history, conversationSummary || undefined);

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
      pattern:
        /\bwhat(?:'s|\s+is)\s+(?:a|an|the|my)?\s*model\s*(?:number|#|code)?\b|\bwhat\s+does\s+(?:a|the|my)?\s*model\s*number\s+mean\b/i,
      reply:
        "A model number identifies your whole appliance (the specific fridge or dishwasher you own), not an individual part. " +
        "Manufacturers use a short code — often letters and digits like WDT780SAEM1 or WRS325SDHZ — so support and parts databases know exactly which machine you have. " +
        "You need it for compatibility checks: a PS part number is the part itself; the model number is the appliance it might fit. " +
        "Look for a sticker or metal tag: on refrigerators it's often on an inside wall, ceiling liner, or door frame; on dishwashers, open the door and check the door frame, tub edge, or behind the lower kick panel.",
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
            {
              id: "g-find",
              label: "Look up a part",
              prompt:
                "I want to look up a refrigerator or dishwasher part. I have a PartSelect part number—what should I paste here?",
            },
            {
              id: "g-compat",
              label: "Check compatibility",
              prompt:
                "I need to check if a part fits my fridge or dishwasher. I have the part number and my appliance model number.",
            },
          ],
          no_evidence: true,
          normalized_part_numbers: [],
          tool_trace: [],
          used_llm: false,
        });
      });
    }
  }

  const oos = buildOutOfScopeReplyFromRetrieval(message);
  if (oos) {
    return streamResponse(async (send) => {
      const words = oos.reply.split(" ");
      for (const word of words) {
        send({ type: "token", text: word + " " });
        await new Promise((r) => setTimeout(r, 12));
      }
      send({
        type: "done",
        blocks: [],
        citations: [],
        suggested_actions: oos.hints.map((h, i) => ({
          id: `oos-${i}`,
          label: h,
          prompt: h,
        })),
        no_evidence: true,
        normalized_part_numbers: [],
        tool_trace: [],
        used_llm: false,
      });
    });
  }

  if (!process.env.OPENAI_API_KEY?.trim()) {
    return NextResponse.json(
      {
        error: "openai_not_configured",
        message:
          "OPENAI_API_KEY is required for this chat agent. Add it to web/.env.local and restart the dev server.",
      },
      { status: 503 }
    );
  }

  return streamResponse(async (send) => {
    const catalogCtx = await resolveCatalogContext();
    const out = await streamChatWithLlmTools(
      message,
      history,
      context,
      (token) => send({ type: "token", text: token }),
      conversationSummary || undefined,
      catalogCtx
    );
    const blocks = await buildBlocksFromRetrieval(out.retrieval, message, catalogCtx);
    const clar =
      blocks.length === 0
        ? await buildClarifyReplyFromRetrieval(out.retrieval, message, catalogCtx)
        : null;

    if (clar) {
      send({ type: "replace", text: clar.reply });
    }

    send({
      type: "done",
      blocks,
      citations: alignCitationsToBlocks(out.citations, blocks),
      suggested_actions: await buildSuggestedActionsFromRetrieval(out.retrieval, message, catalogCtx),
      no_evidence: blocks.length === 0,
      normalized_part_numbers: out.normalized_part_numbers,
      tool_trace: out.tool_trace,
      used_llm: true,
    });
  });
}
