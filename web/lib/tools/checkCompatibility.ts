import type { CatalogShape } from "../catalogTypes";
import { collapseModelTokenDb } from "../catalogDb";
import type { CatalogContext } from "../loadCatalog";
import { prisma } from "../prisma";

export type CheckCompatibilityResult =
  | {
      ok: true;
      compatible: boolean;
      model: string;
      partNumber: string;
      note: string;
      rowId: string;
    }
  | { ok: false; error: string };

/**
 * Tool: `check_compatibility`
 * Look up whether a specific part fits a specific appliance model.
 * Both `part_number` and `model` are required — the LLM must collect both
 * before calling this tool.
 */
export async function checkCompatibilityTool(
  input: {
    part_number: string;
    model: string;
  },
  catalogCtx: CatalogContext
): Promise<CheckCompatibilityResult> {
  const partUpper = input.part_number.trim().toUpperCase();
  const modelUpper = input.model.trim().toUpperCase().replace(/[\s._-]/g, "");

  if (!partUpper) return { ok: false, error: "part_number is required" };
  if (!modelUpper) return { ok: false, error: "model is required" };

  if (catalogCtx.mode === "memory") {
    const row = catalogCtx.catalog.compatibilities.find((r) => {
      const rowModel = r.model.toUpperCase().replace(/[\s._-]/g, "");
      const rowPart = r.partNumber.toUpperCase();
      return rowModel === modelUpper && rowPart === partUpper;
    });
    if (!row) {
      return {
        ok: false,
        error: `No compatibility record found for part ${partUpper} with model ${input.model.trim()}. The catalog may not have this combination — advise the user to verify on partselect.com.`,
      };
    }
    return {
      ok: true,
      compatible: row.compatible,
      model: row.model,
      partNumber: row.partNumber,
      note: row.note,
      rowId: row.id,
    };
  }

  const row = await prisma.catalogCompatibility.findFirst({
    where: {
      partNumber: partUpper,
      modelNormalized: collapseModelTokenDb(input.model),
    },
  });

  if (!row) {
    return {
      ok: false,
      error: `No compatibility record found for part ${partUpper} with model ${input.model.trim()}. The catalog may not have this combination — advise the user to verify on partselect.com.`,
    };
  }

  const compat = row.data as CatalogShape["compatibilities"][number];
  return {
    ok: true,
    compatible: compat.compatible,
    model: compat.model,
    partNumber: compat.partNumber,
    note: compat.note,
    rowId: compat.id,
  };
}
