import { isVaguePartsShoppingOpener } from "./buildChatBlocks";
import type { CatalogContext } from "./loadCatalog";
import {
  documentedCompatModelsForPart,
  type RetrievalResult,
} from "./retrieveExact";

type Retrieval = RetrievalResult;
type Part = NonNullable<Retrieval["part"]>;
type Candidate = NonNullable<Retrieval["candidates"]>[number];

/**
 * User supplied a model (often as a follow-up) but the demo catalog has no PS↔model row.
 * Keeps the story honest: we are data-limited, not "forgetting" the model.
 */
export async function formatMissingCompatPairReply(
  partNumber: string,
  catalogCtx: CatalogContext
): Promise<string> {
  const docs = await documentedCompatModelsForPart(partNumber, catalogCtx);
  const docLine =
    docs.length > 0
      ? ` In this demo file, **${partNumber}** only has documented fit rows for: ${docs.map((m) => `**${m}**`).join(", ")}.`
      : "";
  return (
    `I have the model you sent, but **this local catalog does not include a compatibility row** for **${partNumber}** with that model, so there is no catalog-backed yes/no here.` +
    docLine +
    " Please confirm fit on PartSelect before ordering."
  );
}

function priceSnippet(part: Part): string {
  const p = part as unknown as Record<string, unknown>;
  if (typeof p.price !== "number") return "";
  const currency = typeof p.currency === "string" ? p.currency : "USD";
  const price = currency === "USD" ? `$${(p.price as number).toFixed(2)}` : `${(p.price as number).toFixed(2)} ${currency}`;
  const stock = typeof p.inStock === "boolean" ? (p.inStock ? "in stock" : "out of stock") : null;
  return stock ? ` (${price}, ${stock})` : ` (${price})`;
}

/**
 * Build a reasoning-first reply from retrieval data.
 * Used in the deterministic (no-LLM) path; mirrors what the LLM should say
 * when the API key is present. Cards carry the structured data — this text
 * carries interpretation and prioritization.
 */
export function formatCatalogReplyFromRetrieval(
  retrieval: Retrieval,
  userPreview: string,
  clarifyQuestion?: string
): string {
  const { part, compatibility, guide, candidates } = retrieval;

  // Clarify / vague opener wins over a spurious `part` from tool noise (e.g. LLM catalog_search).
  if (clarifyQuestion?.trim()) {
    if (isVaguePartsShoppingOpener(userPreview) || (!part && !compatibility && !guide)) {
      return clarifyQuestion;
    }
  }

  // Complete miss
  if (!part && !compatibility && !guide && (!candidates || candidates.length === 0)) {
    return (
      "I wasn't able to find anything for that — double-check the part or model number, " +
      `or try different wording. (You asked: ${userPreview.slice(0, 120)}${userPreview.length > 120 ? "…" : ""})`
    );
  }

  // Compatibility only
  if (compatibility && !part && !guide) {
    const verdict = compatibility.compatible ? "compatible" : "not compatible";
    const reason = (compatibility as unknown as Record<string, unknown>).note as string | undefined;
    const base = `**${compatibility.partNumber}** is **${verdict}** with the appliance on the compatibility card below.`;
    return reason ? `${base} ${reason}` : base;
  }

  // Part only (price/stock/details lookup)
  if (part && !compatibility && !guide) {
    return (
      `Here's **${(part as unknown as Record<string, unknown>).partNumber as string}**${priceSnippet(part)}.` +
      " Full specs and installation info are in the card below."
    );
  }

  // Repair guide only — reason about the symptom
  if (guide && !part && !compatibility) {
    const likelyParts = (guide as unknown as Record<string, unknown>).likelyParts as string[] | undefined;
    const hasCandidates = candidates && candidates.length > 0;

    let reply =
      `For **${(guide as unknown as Record<string, unknown>).brand as string} ${(guide as unknown as Record<string, unknown>).appliance as string}** — ${(guide as unknown as Record<string, unknown>).topic as string} — ` +
      "start with the steps in the repair guide card before ordering parts.";

    if (hasCandidates && candidates!.length >= 2) {
      const top = candidates![0] as Candidate;
      const second = candidates![1] as Candidate;
      const topPN = (top.part as unknown as Record<string, unknown>).partNumber as string;
      const secondPN = (second.part as unknown as Record<string, unknown>).partNumber as string;
      reply +=
        ` If the basic checks don't resolve it, **${topPN}** is the most common part to replace first —` +
        ` though **${secondPN}** is worth ruling out if the symptom points to a supply issue.`;
    } else if (likelyParts && likelyParts.length > 0) {
      reply += ` The most commonly replaced part for this issue is **${likelyParts[0]}**.`;
    }

    return reply;
  }

  // Candidates only (reverse diagnosis without a full guide)
  if (!guide && candidates && candidates.length > 0 && !part && !compatibility) {
    const top = candidates[0] as Candidate;
    const topPN = (top.part as unknown as Record<string, unknown>).partNumber as string;
    const topTitle = (top.part as unknown as Record<string, unknown>).title as string;

    if (candidates.length === 1) {
      return `Based on that symptom, **${topPN}** (${topTitle}) is the most likely part to replace — details in the card below.`;
    }

    const second = candidates[1] as Candidate;
    const secondPN = (second.part as unknown as Record<string, unknown>).partNumber as string;
    const secondTitle = (second.part as unknown as Record<string, unknown>).title as string;
    return (
      `Based on that symptom, **${topPN}** (${topTitle}) is the most likely culprit.` +
      ` **${secondPN}** (${secondTitle}) is worth checking too if the first replacement doesn't resolve it.` +
      " See the cards below for details."
    );
  }

  // Part + compatibility (e.g. user asked about compat and we resolved both)
  if (part && compatibility) {
    const verdict = compatibility.compatible ? "fits" : "does not fit";
    const pn = (part as unknown as Record<string, unknown>).partNumber as string;
    return `**${pn}**${priceSnippet(part)} **${verdict}** the appliance shown on the compatibility card. Details are in the cards below.`;
  }

  // Fallback
  return "Here's what I found — see the cards below for details.";
}
