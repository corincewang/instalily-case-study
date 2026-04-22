import catalog from "../../data/catalog.json";

export type LookupPartResult =
  | { ok: true; part: (typeof catalog.parts)[number] }
  | { ok: false; error: string };

/**
 * Tool: `lookup_part`
 * Fetch a single part's full record by PS number.
 * Returns identity, price, stock, install steps, and social proof data.
 */
export function lookupPartTool(input: {
  part_number: string;
}): LookupPartResult {
  const needle = input.part_number.trim().toUpperCase();
  const part = catalog.parts.find(
    (p) => p.partNumber.toUpperCase() === needle
  );
  if (!part) {
    return { ok: false, error: `No part found for ${needle}` };
  }
  return { ok: true, part };
}
