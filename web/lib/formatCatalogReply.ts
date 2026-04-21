import { retrieveExact } from "./retrieveExact";

type Retrieval = ReturnType<typeof retrieveExact>;

/**
 * Fallback reply when the LLM returns no final text.
 * Short prose only; cards carry catalog layout; chips carry next steps.
 */
export function formatCatalogReplyFromRetrieval(
  retrieval: Retrieval,
  userPreview: string
): string {
  const { part, compatibility, guide } = retrieval;
  if (!part && !compatibility && !guide) {
    return (
      "I couldn’t match that to our sample catalog. Double-check the part or model number, or try a different wording. " +
      `(You wrote: ${userPreview.slice(0, 160)}${userPreview.length > 160 ? "…" : ""})`
    );
  }

  if (compatibility && !part && !guide) {
    const ok = compatibility.compatible ? "compatible" : "not compatible";
    return (
      `In this demo data, **${compatibility.partNumber}** is **${ok}** with model **${compatibility.model}**. ` +
      "Details stay in the compatibility card below; use the chips for your next step."
    );
  }

  if (part && !compatibility && !guide) {
    return (
      `**${part.partNumber}** matches our sample listing for what you asked. ` +
      "Specs and install text are in the part card below; chips suggest logical next steps."
    );
  }

  if (guide && !part && !compatibility) {
    return (
      `There’s a sample repair note that may apply to **${guide.brand} ${guide.appliance}** (${guide.topic}). ` +
      "Steps are in the repair card below; chips suggest follow-ups."
    );
  }

  if (part && compatibility && !guide) {
    return (
      `We matched **${part.partNumber}** and a compatibility note for model **${compatibility.model}**. ` +
      "Details are in the cards below; use the chips for your next step."
    );
  }

  return (
    "Your question lines up with more than one catalog row in this demo (part, compatibility, and/or repair). " +
    "See the cards below for each layer; use the chips for what you want to do next."
  );
}
