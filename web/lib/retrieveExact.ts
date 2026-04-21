import catalog from "../data/catalog.json";

export type Citation = {
  id: string;
  source: "part_catalog" | "compatibility_database" | "repair_guide";
  label: string;
};

type CatalogShape = typeof catalog;

const PS_RE = /\bPS\d{5,}\b/gi;

function normalizeModelToken(s: string) {
  return s.trim().toUpperCase();
}

/** 4-P0: exact part number, exact model row, and guide rows matched by required substrings. */
export function retrieveExact(userMessage: string): {
  citations: Citation[];
  part?: CatalogShape["parts"][number];
  compatibility?: CatalogShape["compatibilities"][number];
  guide?: CatalogShape["repairGuides"][number];
} {
  const citations: Citation[] = [];
  const hay = userMessage;

  let part: CatalogShape["parts"][number] | undefined;
  for (const m of hay.matchAll(PS_RE)) {
    const n = m[0].toUpperCase();
    const hit = catalog.parts.find((p) => p.partNumber.toUpperCase() === n);
    if (hit) {
      part = hit;
      break;
    }
  }
  if (part) {
    citations.push({
      id: part.id,
      source: "part_catalog",
      label: "Part catalog",
    });
  }

  let compatibility: CatalogShape["compatibilities"][number] | undefined;
  const upper = hay.toUpperCase();
  for (const row of catalog.compatibilities) {
    if (upper.includes(normalizeModelToken(row.model))) {
      if (!part || row.partNumber.toUpperCase() === part.partNumber.toUpperCase()) {
        compatibility = row;
        break;
      }
    }
  }
  if (compatibility) {
    citations.push({
      id: compatibility.id,
      source: "compatibility_database",
      label: "Compatibility database",
    });
  }

  const lower = hay.toLowerCase();
  let guide: CatalogShape["repairGuides"][number] | undefined;
  for (const g of catalog.repairGuides) {
    const ok = g.matchIncludesAll.every((frag) => lower.includes(frag.toLowerCase()));
    if (ok) {
      guide = g;
      break;
    }
  }
  if (guide) {
    citations.push({
      id: guide.id,
      source: "repair_guide",
      label: "Repair guide",
    });
  }

  return { citations, part, compatibility, guide };
}
