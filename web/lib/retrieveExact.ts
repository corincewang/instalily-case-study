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

/** Collapse spaces / punctuation so typed model numbers still match the catalog row (4-P1). */
function collapseModelToken(s: string) {
  return s.replace(/[\s._\-]/g, "").toUpperCase();
}

function pushCitation(citations: Citation[], c: Citation) {
  if (!citations.some((x) => x.id === c.id)) {
    citations.push(c);
  }
}

/**
 * 4-P1 hybrid retrieval (after 4-P0 exact PS hit):
 * 1) model compatibility (substring + collapsed spacing)
 * 2) strict repair guide phrases (`matchIncludesAll`)
 * 3) part keyword match on catalog `keywords`
 * 4) flexible symptom / phrase groups (`matchFlexible`)
 *
 * If a compatibility row hits but no PS was in the message, the linked part row is filled in.
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
  const collapsedHay = collapseModelToken(hay);

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
    const modelUpper = normalizeModelToken(row.model);
    const modelCollapsed = collapseModelToken(row.model);
    const modelMatches =
      upper.includes(modelUpper) || collapsedHay.includes(modelCollapsed);
    if (modelMatches) {
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

  if (compatibility && !part) {
    const linked = catalog.parts.find(
      (p) =>
        p.partNumber.toUpperCase() === compatibility!.partNumber.toUpperCase()
    );
    if (linked) {
      part = linked;
      pushCitation(citations, {
        id: linked.id,
        source: "part_catalog",
        label: "Part catalog (from compatibility row)",
      });
    }
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
