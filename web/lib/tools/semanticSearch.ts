import { semanticSearch } from "../vectorSearch";

export type SemanticSearchArgs = { query: string };

export type SemanticSearchResult = {
  ok: true;
  results: {
    partNumber: string;
    kind: string;
    excerpt: string;
    score: number;
  }[];
};

/**
 * Semantic search over embedded repairStories, FAQ, and install snippets.
 * Returns top-4 most relevant passages for the LLM to cite in its reply.
 */
export async function semanticSearchTool(
  args: SemanticSearchArgs
): Promise<SemanticSearchResult | { ok: false; error: string }> {
  const { query } = args;
  if (!query?.trim()) return { ok: false, error: "query_required" };

  const hits = await semanticSearch(query.trim(), 4);
  if (hits.length === 0) return { ok: true, results: [] };

  return {
    ok: true,
    results: hits.map((h) => ({
      partNumber: h.partNumber,
      kind:       h.kind,
      // Trim to keep token count low — LLM gets the gist, not the full chunk
      excerpt:    h.text.slice(0, 400),
      score:      Math.round(h.score * 100) / 100,
    })),
  };
}
