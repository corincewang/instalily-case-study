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

function pushCitation(citations: Citation[], c: Citation) {
  if (!citations.some((x) => x.id === c.id)) {
    citations.push(c);
  }
}

/**
 * Exact match first (4-P0), then keyword / relaxed guide rules (4-P1).
 * Compatibility stays model substring exact only.
 */
export function retrieveExact(userMessage: string): {
  citations: Citation[];
  part?: CatalogShape["parts"][number];
  compatibility?: CatalogShape["compatibilities"][number];
  guide?: CatalogShape["repairGuides"][number];
} {
  const citations: Citation[] = [];
  const hay = userMessage;
  const upper = hay.toUpperCase();
  const lower = hay.toLowerCase();

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
    pushCitation(citations, {
      id: part.id,
      source: "part_catalog",
      label: "Part catalog",
    });
  }

  let compatibility: CatalogShape["compatibilities"][number] | undefined;
  for (const row of catalog.compatibilities) {
    if (upper.includes(normalizeModelToken(row.model))) {
      if (!part || row.partNumber.toUpperCase() === part.partNumber.toUpperCase()) {
        compatibility = row;
        break;
      }
    }
  }
  if (compatibility) {
    pushCitation(citations, {
      id: compatibility.id,
      source: "compatibility_database",
      label: "Compatibility database",
    });
  }

  let guide: CatalogShape["repairGuides"][number] | undefined;
  for (const g of catalog.repairGuides) {
    const ok = g.matchIncludesAll.every((frag) =>
      lower.includes(frag.toLowerCase())
    );
    if (ok) {
      guide = g;
      break;
    }
  }
  if (guide) {
    pushCitation(citations, {
      id: guide.id,
      source: "repair_guide",
      label: "Repair guide",
    });
  }

  // 4-P1: fill missing part via catalog keywords (substring).
  if (!part) {
    for (const p of catalog.parts) {
      const keywords =
        "keywords" in p && Array.isArray((p as { keywords?: string[] }).keywords)
          ? (p as { keywords: string[] }).keywords
          : [];
      if (keywords.some((k) => lower.includes(String(k).toLowerCase()))) {
        part = p;
        pushCitation(citations, {
          id: p.id,
          source: "part_catalog",
          label: "Part catalog (keyword match)",
        });
        break;
      }
    }
  }

  // 4-P1: fill missing guide via matchFlexible (AND across OR-groups).
  if (!guide) {
    for (const g of catalog.repairGuides) {
      const flex = (g as { matchFlexible?: string[][] }).matchFlexible;
      if (!flex || flex.length < 2) continue;
      const flexOk = flex.every((group) =>
        group.some((term) => lower.includes(term.toLowerCase()))
      );
      if (flexOk) {
        guide = g;
        pushCitation(citations, {
          id: g.id,
          source: "repair_guide",
          label: "Repair guide (keyword match)",
        });
        break;
      }
    }
  }

  return { citations, part, compatibility, guide };
}
