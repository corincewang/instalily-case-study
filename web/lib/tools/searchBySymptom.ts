import * as catalogDb from "../catalogDb";
import type { CatalogShape } from "../catalogTypes";
import type { CatalogContext } from "../loadCatalog";

export type SymptomCandidate = {
  partNumber: string;
  title: string;
  applianceFamily: string;
  price?: number;
  matchedSymptoms: string[];
  score: number;
};

export type SearchBySymptomResult =
  | { ok: true; candidates: SymptomCandidate[] }
  | { ok: false; error: string };

function symptomMatchesQuery(symptomPhrase: string, queryText: string): boolean {
  if (queryText.includes(symptomPhrase)) return true;
  const symWords = symptomPhrase.split(/\s+/).filter((w) => w.length > 1);
  const qLower = queryText.toLowerCase();
  return symWords.every((w) => qLower.includes(w));
}

function scoreSymptomPool(
  pool: CatalogShape["parts"],
  queryText: string
): SymptomCandidate[] {
  const lower = queryText.toLowerCase();
  const scored: SymptomCandidate[] = [];
  for (const p of pool) {
    const syms = (p as unknown as { symptoms?: unknown }).symptoms;
    if (!Array.isArray(syms)) continue;
    const matched = (syms as unknown[]).filter(
      (s): s is string =>
        typeof s === "string" && s.length > 0 && symptomMatchesQuery(s.toLowerCase(), lower)
    );
    if (matched.length === 0) continue;
    scored.push({
      partNumber: p.partNumber,
      title: p.title,
      applianceFamily: p.applianceFamily,
      price: (p as unknown as { price?: number }).price,
      matchedSymptoms: matched,
      score: matched.length,
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, catalogDb.SYMPTOM_TOP_K);
}

/**
 * Tool: `search_by_symptom`
 * Reverse-diagnose which parts are most likely responsible for a described
 * symptom. Returns up to 3 candidates ranked by how many of their symptom
 * phrases appear in the query.
 */
export async function searchBySymptomTool(
  input: {
    symptom: string;
  },
  catalogCtx: CatalogContext
): Promise<SearchBySymptomResult> {
  const q = input.symptom.trim();
  if (!q) return { ok: false, error: "symptom is required" };

  const lower = q.toLowerCase();

  if (catalogCtx.mode === "memory") {
    const scored: SymptomCandidate[] = [];
    for (const p of catalogCtx.catalog.parts) {
      const syms = (p as unknown as { symptoms?: unknown }).symptoms;
      if (!Array.isArray(syms)) continue;
      const matched = (syms as unknown[]).filter(
        (s): s is string =>
          typeof s === "string" && s.length > 0 && symptomMatchesQuery(s.toLowerCase(), lower)
      );
      if (matched.length === 0) continue;
      scored.push({
        partNumber: p.partNumber,
        title: p.title,
        applianceFamily: p.applianceFamily,
        price: (p as unknown as { price?: number }).price,
        matchedSymptoms: matched,
        score: matched.length,
      });
    }
    if (scored.length === 0) {
      return { ok: false, error: `No catalog parts matched the symptom "${q}".` };
    }
    scored.sort((a, b) => b.score - a.score);
    return { ok: true, candidates: scored.slice(0, catalogDb.SYMPTOM_TOP_K) };
  }

  const pool = await catalogDb.fulltextSearchParts(lower, catalogDb.FTS_PREFETCH_LIMIT);
  const ranked = scoreSymptomPool(pool, q);
  if (ranked.length === 0) {
    return { ok: false, error: `No catalog parts matched the symptom "${q}".` };
  }
  return { ok: true, candidates: ranked };
}
