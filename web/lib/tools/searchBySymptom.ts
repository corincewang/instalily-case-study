import catalog from "../../data/catalog.json";

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

/**
 * Tool: `search_by_symptom`
 * Reverse-diagnose which parts are most likely responsible for a described
 * symptom. Returns up to 3 candidates ranked by how many of their symptom
 * phrases appear in the query.
 *
 * Use this when the user describes a problem (e.g. "ice maker not working",
 * "door won't close") rather than naming a specific part.
 */
export function searchBySymptomTool(input: {
  symptom: string;
}): SearchBySymptomResult {
  const q = input.symptom.trim();
  if (!q) return { ok: false, error: "symptom is required" };

  const lower = q.toLowerCase();
  const scored: SymptomCandidate[] = [];

  for (const p of catalog.parts) {
    const syms = (p as unknown as { symptoms?: unknown }).symptoms;
    if (!Array.isArray(syms)) continue;
    const matched = (syms as unknown[]).filter(
      (s): s is string =>
        typeof s === "string" && s.length > 0 && lower.includes(s.toLowerCase())
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
    return {
      ok: false,
      error: `No parts matched the symptom "${q}". Try a more specific description like "ice maker not working" or "door won't latch".`,
    };
  }

  scored.sort((a, b) => b.score - a.score);
  return { ok: true, candidates: scored.slice(0, 3) };
}
