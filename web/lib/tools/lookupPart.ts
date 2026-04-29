import type { CatalogShape } from "../catalogTypes";
import * as catalogDb from "../catalogDb";
import type { CatalogContext } from "../loadCatalog";

export type LookupPartResult =
  | { ok: true; part: CatalogShape["parts"][number] }
  | { ok: false; error: string };

/**
 * Tool: `lookup_part`
 * Fetch a single part's full record by PS number.
 * Returns identity, price, stock, install steps, and social proof data.
 */
export async function lookupPartTool(
  input: {
    part_number: string;
  },
  catalogCtx: CatalogContext
): Promise<LookupPartResult> {
  const needle = input.part_number.trim().toUpperCase();
  if (!needle) return { ok: false, error: "part_number is required" };

  if (catalogCtx.mode === "memory") {
    const part = catalogCtx.catalog.parts.find((p) => p.partNumber.toUpperCase() === needle);
    if (!part) return { ok: false, error: `No part found for ${needle}` };
    return { ok: true, part };
  }

  const part = await catalogDb.lookupPartByPs(needle);
  if (!part) return { ok: false, error: `No part found for ${needle}` };
  return { ok: true, part };
}
