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
/**
 * Check whether every content word in `symptomPhrase` appears in `queryText`.
 * This handles filler words like "is", "my", "the" that users naturally include
 * but symptom phrases omit — e.g. "ice maker is not working" matches "ice maker not working".
 */
function symptomMatchesQuery(symptomPhrase: string, queryText: string): boolean {
  // Exact substring first (fast path)
  if (queryText.includes(symptomPhrase)) return true;
  // Word-level: every word in the symptom appears somewhere in the query
  const symWords = symptomPhrase.split(/\s+/).filter((w) => w.length > 1);
  const qLower = queryText.toLowerCase();
  return symWords.every((w) => qLower.includes(w));
}

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
  return { ok: true, candidates: scored.slice(0, 3) };
}
