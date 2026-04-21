const PS_RE = /\bPS\d{5,}\b/gi;

export type NormalizePartNumberResult = {
  /** Uppercase `PS…`, unique, first-seen order. */
  part_numbers: string[];
};

/**
 * Tool: `normalize_part_number` — extract PartSelect-style PS numbers from free text.
 * (LLM 以后可单独调此工具；当前由编排器在检索前固定调用。)
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
  return { part_numbers };
}
