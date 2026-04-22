/** Canonical PS##### (5+ digits). */
const PS_RE = /\bPS\d{5,}\b/gi;
/** PS followed by 1–4 digits (optionally with `#` or whitespace) — flagged as likely typo (3-P1). */
const PS_MALFORMED_RE = /\bPS#?\s*\d{1,4}\b/gi;

export type NormalizePartNumberResult = {
  /** Uppercase `PS…` with 5+ digits, unique, first-seen order. */
  part_numbers: string[];
  /** PS-shaped tokens that failed the 5-digit rule; kept so the model can ask the user to re-enter. */
  invalid_ps_tokens: string[];
};

/**
 * Tool: `normalize_part_number` — extract PartSelect-style PS numbers from free text,
 * and surface PS-shaped typos so the agent can ask a clarifying question instead of guessing.
 */
export function normalizePartNumberTool(input: {
  text: string;
}): NormalizePartNumberResult {
  const seen = new Set<string>();
  const part_numbers: string[] = [];
  for (const m of input.text.matchAll(PS_RE)) {
    const n = m[0].toUpperCase();
    if (!seen.has(n)) {
      seen.add(n);
      part_numbers.push(n);
    }
  }

  const invalidSeen = new Set<string>();
  const invalid_ps_tokens: string[] = [];
  for (const m of input.text.matchAll(PS_MALFORMED_RE)) {
    const raw = m[0].replace(/#/g, "").replace(/\s+/g, "").toUpperCase();
    if (!/^PS\d{1,4}$/.test(raw)) continue;
    if (seen.has(raw) || invalidSeen.has(raw)) continue;
    invalidSeen.add(raw);
    invalid_ps_tokens.push(raw);
  }

  return { part_numbers, invalid_ps_tokens };
}
