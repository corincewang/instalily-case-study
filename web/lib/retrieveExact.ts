import catalog from "../data/catalog.json";

export type Citation = {
  id: string;
  source: "part_catalog" | "compatibility_database" | "repair_guide";
  label: string;
};

type CatalogShape = typeof catalog;

const PS_RE = /\bPS\d{5,}\b/gi;
const PS_IN_MESSAGE_RE = /\bPS\d{5,}\b/i;

/**
 * Non–part-number appliance model tokens in the *current* message (e.g. WRS325SDHZ).
 * PS numbers are excluded — those are resolved via the PS loop above.
 */
export function modelTokenInCurrentMessage(hay: string): boolean {
  const upper = hay.toUpperCase();
  for (const m of upper.matchAll(/\b([A-Z]{2,}\d{3,}[A-Z0-9]{2,})\b/g)) {
    if (!/^PS\d/i.test(m[1])) return true;
  }
  return false;
}

/** Model tags that have a compatibility row for this PS in the local catalog (demo subset). */
export function documentedCompatModelsForPartNumber(partNumber: string): string[] {
  const u = partNumber.toUpperCase();
  return (catalog.compatibilities as Array<{ partNumber: string; model: string }>)
    .filter((r) => r.partNumber.toUpperCase() === u)
    .map((r) => r.model);
}

/**
 * When false, do not merge `context.partNumber` / `context.model` into this turn's retrieval.
 * Prevents a new symptom question from inheriting a PS/model from an unrelated prior turn.
 */
export function allowSessionCarryForRetrieval(hay: string, lower: string): boolean {
  if (PS_IN_MESSAGE_RE.test(hay)) return true;
  if (modelTokenInCurrentMessage(hay)) return true;
  if (
    /\b(compat|compatible|compatibility|fit|fits|work with|works with)\b/.test(lower)
  ) {
    return true;
  }
  if (
    /\b(install|installation|installing|how do i (put|fit|install)|steps to|instruction|replace|replacement)\b/.test(
      lower
    )
  ) {
    return true;
  }
  if (
    /\b(price|cost|how much|in stock|out of stock|stock|ship|shipping|rating|review|reviews)\b/.test(
      lower
    )
  ) {
    return true;
  }
  if (
    /\b(which part|what parts?|parts? (do i need|needed|for|to replace))\b/.test(lower)
  ) {
    return true;
  }
  if (/\b(oem|manufacturer|replaces|supersed)\b/.test(lower)) return true;
  return false;
}

/**
 * The user is asking how to use this chat (what to paste / type), not requesting a
 * catalog browse. Such lines often still say "refrigerator or dishwasher part" for
 * scope — without this guard, {@link retrieveExact} keyword browse matches the
 * appliance word and surfaces arbitrary "top 3" parts.
 */
export function isProceduralPartsChatHelpMessage(userMessage: string): boolean {
  const m = userMessage.toLowerCase();
  if (/\bwhat should i (paste|type|send|enter|put)\b/.test(m)) return true;
  if (/\bwhat (do|should) i (paste|send|type|enter|put)\b/.test(m)) return true;
  if (/\bhow (do|should) i (paste|send|share|tell you|format|write)\b/.test(m)) return true;
  if (/\bwhere (do|should) i (paste|put|enter|type)\b/.test(m)) return true;
  if (/have a partselect part number.*what should i paste/i.test(userMessage)) return true;
  return false;
}

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

export type CandidatePart = {
  part: CatalogShape["parts"][number];
  matchedPhrases: string[];
};

export type SearchHit = {
  part: CatalogShape["parts"][number];
  /** Single phrase (keyword or appliance label) that justified the hit — echoed in the UI. */
  matchedPhrase: string;
};

/**
 * Session context carried forward from previous turns.
 * When the current message resolves a part or model on its own, those values
 * win. The context fields are only used as a fallback when the current message
 * would otherwise leave `part` or a model search empty.
 */
export type SessionContext = {
  /** PS number resolved in a prior turn (e.g. after a clarify exchange). */
  partNumber?: string;
  /** Model token resolved in a prior turn. */
  model?: string;
};

/**
 * Hybrid retrieval:
 * 1) exact PS number in message                                       (4-P0)
 * 2) OEM / manufacturer part number substring                         (category 5)
 * 3) supersession: old number listed in a part's `replaces[]`         (category 5)
 * 4) model compatibility (substring + collapsed spacing)              (4-P1)
 * 5) strict repair guide phrases (`matchIncludesAll`)
 * 6) part keyword match on catalog `keywords`                         (4-P1)
 * 7) flexible symptom / phrase groups (`matchFlexible`)               (4-P1)
 * 8) symptom → candidate parts (ranked by phrase-hit count)           (category 6)
 * 9) appliance / keyword browse (multi-result search)                 (category 4 browse)
 *
 * If a compatibility row hits but no PS was in the message, the linked part row is filled in.
 *
 * `context` carries resolved values from prior turns so a clarify→answer pair
 * works without the user repeating themselves. Session fields are merged only when
 * {@link allowSessionCarryForRetrieval} is true for this message (compat/install/price
 * language, PS/model in the current text, etc.) — not on unrelated symptom turns.
 */
export function retrieveExact(
  userMessage: string,
  context?: SessionContext
): {
  citations: Citation[];
  part?: CatalogShape["parts"][number];
  compatibility?: CatalogShape["compatibilities"][number];
  guide?: CatalogShape["repairGuides"][number];
  candidates?: CandidatePart[];
  searchResults?: SearchHit[];
} {
  const citations: Citation[] = [];
  const hay = userMessage;
  const upper = hay.toUpperCase();
  const lower = hay.toLowerCase();
  const collapsedHay = collapseModelToken(hay);
  const allowCarry = allowSessionCarryForRetrieval(hay, lower);

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

  // Category 5: OEM / manufacturer part number match.
  // Cheap and safe since OEM codes are ≥ 5 distinctive chars — substring is enough.
  if (!part) {
    for (const p of catalog.parts) {
      const oem = (p as { manufacturerPartNumber?: string }).manufacturerPartNumber;
      if (!oem || oem.length < 5) continue;
      if (upper.includes(oem.toUpperCase())) {
        part = p;
        pushCitation(citations, {
          id: p.id,
          source: "part_catalog",
          label: `Part catalog (OEM ${oem})`,
        });
        break;
      }
    }
  }

  // Category 5: supersession — user references an older number this part now replaces.
  // PartSelect pages explicitly publish "This part replaces these: X, Y, Z", so real users
  // will paste those in. Each `replaces[]` entry becomes an alternate retrieval key.
  if (!part) {
    for (const p of catalog.parts) {
      const replaces = (p as { replaces?: string[] }).replaces;
      if (!Array.isArray(replaces) || replaces.length === 0) continue;
      const hitOld = replaces.find(
        (old) =>
          typeof old === "string" && old.length >= 5 && upper.includes(old.toUpperCase())
      );
      if (hitOld) {
        part = p;
        pushCitation(citations, {
          id: p.id,
          source: "part_catalog",
          label: `Part catalog (supersedes ${hitOld})`,
        });
        break;
      }
    }
  }

  // Session context carry-forward (Step 1 / Step 3):
  // If the current message didn't resolve a part on its own but a prior turn did,
  // seed `part` from the context so the user doesn't have to repeat themselves.
  // Example: "How do I install it?" after agent already knows the PS number.
  if (!part && context?.partNumber && allowCarry) {
    const carried = catalog.parts.find(
      (p) => p.partNumber.toUpperCase() === context.partNumber!.toUpperCase()
    );
    if (carried) {
      part = carried;
      pushCitation(citations, {
        id: carried.id,
        source: "part_catalog",
        label: "Part catalog (session context)",
      });
    }
  }

  // Augment compat matching with the session model only when this turn clearly
  // continues a compat / install / commerce thread (or already names a model/PS).
  const contextModelToken = allowCarry ? (context?.model ?? "") : "";
  const augUpper = contextModelToken
    ? `${upper} ${contextModelToken.toUpperCase()}`
    : upper;
  const augCollapsed = contextModelToken
    ? `${collapsedHay} ${collapseModelToken(contextModelToken)}`
    : collapsedHay;

  let compatibility: CatalogShape["compatibilities"][number] | undefined;
  for (const row of catalog.compatibilities) {
    const modelUpper = normalizeModelToken(row.model);
    const modelCollapsed = collapseModelToken(row.model);
    const modelMatches =
      augUpper.includes(modelUpper) || augCollapsed.includes(modelCollapsed);
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
  // Do not pin a single `part` row on bare appliance-family tokens ("dishwasher" appears in
  // many keyword lists) — that spuriously sets session-facing `part` and surfaces unrelated
  // "Price & stock" chips on vague symptom lines like "why my dishwasher don't work".
  const BARE_APPLIANCE_KEYWORD = new Set([
    "dishwasher",
    "dishwashers",
    "refrigerator",
    "refrigerators",
    "fridge",
    "fridges",
  ]);
  if (!part) {
    for (const p of catalog.parts) {
      const keywords =
        "keywords" in p && Array.isArray((p as { keywords?: string[] }).keywords)
          ? (p as { keywords: string[] }).keywords
          : [];
      const hit = keywords.find((k) => {
        if (typeof k !== "string" || k.length < 3) return false;
        const kl = k.toLowerCase();
        if (BARE_APPLIANCE_KEYWORD.has(kl)) return false;
        return lower.includes(kl);
      });
      if (hit) {
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

  // Category 6: symptom → candidate parts (reverse diagnosis).
  // Ranks every part by how many of its `symptoms[]` phrases appear in the user message,
  // then keeps the top 3. Always computed when symptom phrases hit; downstream layer
  // (buildBlocksFromRetrieval) decides whether to render as a "candidates" block.
  const scored: CandidatePart[] = [];
  for (const p of catalog.parts) {
    const syms = (p as { symptoms?: string[] }).symptoms;
    if (!Array.isArray(syms) || syms.length === 0) continue;
    const matched = syms.filter(
      (s) => typeof s === "string" && s.length > 0 && lower.includes(s.toLowerCase())
    );
    if (matched.length > 0) {
      scored.push({ part: p, matchedPhrases: matched });
    }
  }
  scored.sort((a, b) => b.matchedPhrases.length - a.matchedPhrases.length);
  const candidates = scored.slice(0, 3);
  for (const c of candidates) {
    pushCitation(citations, {
      id: c.part.id,
      source: "part_catalog",
      label: `Part catalog (symptom: "${c.matchedPhrases[0]}")`,
    });
  }

  // Category 4 (browse): appliance + keyword search.
  // Scores every part on (a) appliance-family mention in the query and (b) any catalog
  // keyword substring hit. Keeps Top 3. This is the raw material for a multi-result browse
  // card; downstream only renders it when intent === "search".
  let searchResults: SearchHit[] = [];
  if (!isProceduralPartsChatHelpMessage(hay)) {
    const applianceSignals: Array<{ token: string; canonical: string }> = [
      { token: "dishwasher", canonical: "dishwasher" },
      { token: "refrigerator", canonical: "refrigerator" },
      { token: "fridge", canonical: "refrigerator" },
    ];
    const queryAppliance = applianceSignals.find((a) => lower.includes(a.token))?.canonical;

    const searchScored: Array<{ part: CatalogShape["parts"][number]; score: number; phrase: string }> = [];
    for (const p of catalog.parts) {
      let score = 0;
      let phrase = "";
      if (queryAppliance && p.applianceFamily.toLowerCase() === queryAppliance) {
        score += 1;
        phrase = p.applianceFamily;
      }
      const keywords =
        "keywords" in p && Array.isArray((p as { keywords?: string[] }).keywords)
          ? (p as { keywords: string[] }).keywords
          : [];
      for (const k of keywords) {
        if (typeof k !== "string" || k.length < 3) continue;
        if (lower.includes(k.toLowerCase())) {
          score += 2;
          phrase = k;
          break;
        }
      }
      if (score > 0) searchScored.push({ part: p, score, phrase });
    }
    searchScored.sort((a, b) => b.score - a.score);
    searchResults = searchScored
      .slice(0, 3)
      .map((s) => ({ part: s.part, matchedPhrase: s.phrase }));
    for (const s of searchResults) {
      pushCitation(citations, {
        id: s.part.id,
        source: "part_catalog",
        label: `Part catalog (search match: "${s.matchedPhrase}")`,
      });
    }
  }

  // A compatibility verdict answers a different question than a symptom repair guide.
  // LLM `catalog_search` queries often echo extra tokens and could attach an unrelated guide.
  // Only strip `guide` when THIS turn reads like a fit check.
  if (compatibility && guide) {
    const userLooksCompat = /\b(compat|compatible|compatibility|fit|fits|work with|works with)\b/i.test(
      hay
    );
    if (userLooksCompat) {
      guide = undefined;
      for (let i = citations.length - 1; i >= 0; i--) {
        if (citations[i].source === "repair_guide") citations.splice(i, 1);
      }
    }
  }

  return {
    citations,
    part,
    compatibility,
    guide,
    candidates: candidates.length > 0 ? candidates : undefined,
    searchResults: searchResults.length > 0 ? searchResults : undefined,
  };
}
