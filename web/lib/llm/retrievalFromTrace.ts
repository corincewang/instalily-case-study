import type { ToolTraceEntry } from "../agentTools";
import {
  FETCH_PART_PAGE_TOOL_NAME,
  GET_INSTALL_GUIDE_TOOL_NAME,
  LOOKUP_PART_TOOL_NAME,
  CHECK_COMPATIBILITY_TOOL_NAME,
} from "../agentTools";
import type { CatalogContext } from "../loadCatalog";
import type { CatalogShape } from "../catalogTypes";
import * as catalogDb from "../catalogDb";
import { prisma } from "../prisma";
import type { Citation, RetrievalResult } from "../retrieveExact";

type CatalogPart = CatalogShape["parts"][number];
type CatalogCompat = CatalogShape["compatibilities"][number];

function pushCite(citations: Citation[], c: Citation) {
  if (!citations.some((x) => x.id === c.id)) citations.push(c);
}

/**
 * Convert specific-tool outputs in the trace into a `retrieveExact`-compatible
 * retrieval object using direct catalog lookups — no re-query of the full
 * retrieval pipeline.
 */
export async function buildRetrievalFromTrace(
  trace: ToolTraceEntry[],
  catalogCtx: CatalogContext
): Promise<RetrievalResult | null> {
  const citations: Citation[] = [];
  let part: CatalogPart | undefined;
  let compatibility: CatalogCompat | undefined;

  for (const entry of trace) {
    if (!entry.ok) continue;

    if (entry.name === LOOKUP_PART_TOOL_NAME) {
      const o = entry.output as { ok?: boolean; part?: CatalogPart };
      if (o?.ok && o.part) {
        part ??= o.part;
        pushCite(citations, { id: o.part.id, source: "part_catalog", label: "Part catalog" });
      }
    }

    if (entry.name === GET_INSTALL_GUIDE_TOOL_NAME) {
      const o = entry.output as { ok?: boolean; partNumber?: string };
      if (o?.ok && o.partNumber && !part) {
        if (catalogCtx.mode === "memory") {
          part = catalogCtx.catalog.parts.find(
            (p) => p.partNumber.toUpperCase() === o.partNumber!.toUpperCase()
          );
        } else {
          part = (await catalogDb.lookupPartByPs(o.partNumber)) ?? undefined;
        }
        if (part) pushCite(citations, { id: part.id, source: "part_catalog", label: "Part catalog" });
      }
    }

    if (entry.name === CHECK_COMPATIBILITY_TOOL_NAME) {
      const o = entry.output as { ok?: boolean; rowId?: string; partNumber?: string };
      if (o?.ok && o.rowId) {
        if (!compatibility) {
          if (catalogCtx.mode === "memory") {
            compatibility = catalogCtx.catalog.compatibilities.find((r) => r.id === o.rowId);
          } else {
            const row = await prisma.catalogCompatibility.findUnique({ where: { id: o.rowId } });
            compatibility = row ? (row.data as CatalogCompat) : undefined;
          }
        }
        if (compatibility) {
          pushCite(citations, {
            id: compatibility.id,
            source: "compatibility_database",
            label: "Compatibility database",
          });
        }
        if (o.partNumber && !part) {
          if (catalogCtx.mode === "memory") {
            part = catalogCtx.catalog.parts.find(
              (p) => p.partNumber.toUpperCase() === o.partNumber!.toUpperCase()
            );
          } else {
            part = (await catalogDb.lookupPartByPs(o.partNumber)) ?? undefined;
          }
          if (part) pushCite(citations, { id: part.id, source: "part_catalog", label: "Part catalog" });
        }
      }
    }

    if (entry.name === FETCH_PART_PAGE_TOOL_NAME) {
      const o = entry.output as {
        ok?: boolean;
        partNumber?: string;
        title?: string;
        price?: number;
        inStock?: boolean;
        description?: string;
        rating?: number;
        reviewCount?: number;
      };
      if (o?.ok && o.partNumber && !part) {
        const livePart = {
          id: `live-${o.partNumber}`,
          partNumber: o.partNumber,
          title: o.title ?? o.partNumber,
          applianceFamily: "refrigerator or dishwasher",
          keywords: [],
          symptoms: [],
          installSteps: o.description ?? "",
          price: o.price,
          currency: "USD" as const,
          inStock: o.inStock,
          rating: o.rating,
          reviewCount: o.reviewCount,
          _liveSource: true,
        } as unknown as CatalogPart;
        part = livePart;
        pushCite(citations, {
          id: livePart.id,
          source: "part_catalog",
          label: "PartSelect.com (live)",
        });
      }
    }
  }

  if (!part && !compatibility) return null;
  return { citations, part, compatibility };
}
