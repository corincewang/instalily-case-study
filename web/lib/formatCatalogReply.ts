import { retrieveExact } from "./retrieveExact";

type Retrieval = ReturnType<typeof retrieveExact>;

/** Deterministic copy when the LLM returns no final text (fallback). */
export function formatCatalogReplyFromRetrieval(
  retrieval: Retrieval,
  userPreview: string
): string {
  const { part, compatibility, guide } = retrieval;
  if (!part && !compatibility && !guide) {
    return (
      "No catalog match (exact part #, model substring, repair-guide rules, or keyword fallbacks). " +
      `Your message: ${userPreview.slice(0, 200)}`
    );
  }
  const chunks: string[] = [];
  if (part) {
    chunks.push(
      `**${part.title} (${part.partNumber})**\n\nInstallation (from part catalog):\n${part.installSteps}`
    );
  }
  if (compatibility) {
    chunks.push(
      `**Compatibility** — model **${compatibility.model}** with **${compatibility.partNumber}**: ` +
        `${compatibility.compatible ? "Compatible (sample data)." : "Not compatible (sample data)."}\n` +
        compatibility.note
    );
  }
  if (guide) {
    chunks.push(
      `**${guide.brand} ${guide.appliance} — ${guide.topic}** (repair guide)\n\n` +
        guide.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")
    );
  }
  return chunks.join("\n\n---\n\n");
}
