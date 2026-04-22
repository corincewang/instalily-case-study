import { retrieveExact } from "./retrieveExact";

type Retrieval = ReturnType<typeof retrieveExact>;

/**
 * Two-card vocabulary:
 *   product  — catalog-backed part row (commerce metadata)
 *   support  — install / compat / repair / candidates structured cards
 * Each assistant turn usually emits one primary card (sometimes product + support).
 */

export type ProductBlock = {
  type: "product";
  id: string;
  partNumber: string;
  title: string;
  applianceFamily: string;
  /** Commerce metadata (category 4). All optional so rows without these fields still render. */
  price?: number;
  currency?: string;
  inStock?: boolean;
  shipEta?: string;
  /** Social proof. */
  rating?: number;
  reviewCount?: number;
  /** Identity metadata (category 5) — OEM cross-reference and supersession chain. */
  manufacturer?: string;
  manufacturerPartNumber?: string;
  replaces?: string[];
};

export type CandidateEntry = {
  /** Catalog part id, used for citation alignment on the API boundary. */
  id: string;
  partNumber: string;
  title: string;
  applianceFamily: string;
  /** Why this part was suggested — echoed from the symptom phrase that matched. */
  reason?: string;
  price?: number;
  currency?: string;
  inStock?: boolean;
};

/**
 * Aggregated "human element" for an install card: majority difficulty / time
 * and the union of tools across all customer stories. `tools: []` is the
 * signal for "no tools required" (not just missing data).
 */
export type InstallExperience = {
  difficulty?: string;
  timeLabel?: string;
  tools: string[];
  sampleCount: number;
};

/** Top-helpful customer story surfaced on install / repair cards. */
export type CustomerStory = {
  id: string;
  title: string;
  body: string;
  author?: string;
  location?: string;
  helpfulYes?: number;
  helpfulTotal?: number;
};

export type SupportBlock = {
  type: "support";
  kind: "install" | "compat" | "repair" | "candidates";
  id: string;
  title: string;
  subtitle?: string;
  /** Install-only: the PS part number, used by the UI to fetch a video. */
  partNumber?: string;
  verdict?: { label: string; tone: "ok" | "warn" };
  note?: string;
  steps?: string[];
  candidates?: CandidateEntry[];
  /** Install-only: aggregated difficulty / time / tools from customer stories. */
  experience?: InstallExperience;
  /** Top-2 customer stories sorted by helpful-vote count, for install cards. */
  stories?: CustomerStory[];
};

export type ChatBlock = ProductBlock | SupportBlock;

export type SuggestedAction = {
  id: string;
  label: string;
  prompt: string;
};

export type ChatIntent =
  | "buy"
  | "install"
  | "compat"
  | "repair"
  | "diagnose"
  | "oem"
  | "search"
  | "generic";

/**
 * Lightweight intent classifier. Pure heuristic — used to pick which card to show.
 * Never used to gate data access (retrieval is intent-agnostic).
 * Priority order matters: task-ish intents beat commerce intents when both words appear.
 */
export function classifyIntent(userMessage: string): ChatIntent {
  const m = userMessage.toLowerCase();
  // OEM / supersession lookup intent. Checked before `install` because "replacement" /
  // "replaces" are ambiguous on their own; the stronger phrases ("old part", "supersedes",
  // "oem", "what's the ps for …") should pull us here instead of into install-step rendering.
  if (
    /\b(oem|manufacturer|manufacturer'?s|replaces|supersed(e|es|ed|ing)|old (part|number)|what(?:'s| is) the ps)\b/.test(
      m
    )
  ) {
    return "oem";
  }
  // Compatibility / fit — before `diagnose` so "… part for my model …" is not stolen by
  // the `parts? … for` diagnose pattern, and so "compatible … dishwasher …" wins over
  // symptom-style "parts for …" phrasing.
  if (/\b(compat|compatible|compatibility|fit|fits|work with|works with)\b/.test(m)) {
    return "compat";
  }
  // Reverse diagnosis intent: "what parts do I need for X", "which part(s) to replace"…
  // Checked before `install` (shares "replace" family) and before `repair` (shares symptom words).
  if (
    /\b(what parts?|which parts?|candidate parts?|parts? (do i need|to replace|needed|for)|diagnose)\b/.test(
      m
    )
  ) {
    return "diagnose";
  }
  if (
    /\b(install|installation|installing|replace|replacement|how do i (put|fit|install)|steps to|instruction)\b/.test(
      m
    )
  ) {
    return "install";
  }
  if (
    /\b(not working|won'?t|doesn'?t|broken|leak|leaking|fix|repair|troubleshoot|no ice|stopped|makes noise|grinding|clogged)\b/.test(
      m
    )
  ) {
    return "repair";
  }
  if (
    /\b(price|cost|how much|in stock|out of stock|stock|ship|shipping|rating|review|reviews)\b/.test(
      m
    )
  ) {
    return "buy";
  }
  // Category 4 browse: "show me X parts", "list dishwasher parts", "find a wheel".
  // Placed after the task intents above so "how do I install" / "is it compatible" win.
  // Exclude bare "find a part" / "I want to find a part" — no catalog anchor yet (→ generic).
  if (
    !isVaguePartsShoppingOpener(userMessage) &&
    (/\b(show me|show us|browse)\b/.test(m) ||
      /\blist\s+(all|me|the|every|our)?\s*(dishwasher|refrigerator|fridge)?\s*parts?\b/.test(m) ||
      /\bfind\s+(a|an|the|all|some|me|any)\b/.test(m) ||
      /\bparts?\s+(for|list|catalog)\b/.test(m) ||
      /\b(dishwasher|refrigerator|fridge)\s+parts?\b/.test(m))
  ) {
    return "search";
  }
  return "generic";
}

function truncate(s: string, max: number) {
  const t = s.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

/** Catalog stores install text as a single "1) ... 2) ... 3) ..." string. Turn it into a list. */
function parseInstallSteps(raw: string): string[] {
  return raw
    .split(/\n+/)
    .map((line) => line.trim().replace(/^\d+[).]\s*/, ""))
    .filter((line) => line.length > 0);
}

type CatalogPart = Retrieval["part"];

function pickNumber(part: CatalogPart, key: string): number | undefined {
  const v = (part as unknown as Record<string, unknown>)?.[key];
  return typeof v === "number" ? v : undefined;
}
function pickString(part: CatalogPart, key: string): string | undefined {
  const v = (part as unknown as Record<string, unknown>)?.[key];
  return typeof v === "string" ? v : undefined;
}
function pickBool(part: CatalogPart, key: string): boolean | undefined {
  const v = (part as unknown as Record<string, unknown>)?.[key];
  return typeof v === "boolean" ? v : undefined;
}

function pickStringArray(part: CatalogPart, key: string): string[] | undefined {
  const v = (part as unknown as Record<string, unknown>)?.[key];
  if (!Array.isArray(v)) return undefined;
  const arr = v.filter((x): x is string => typeof x === "string");
  return arr.length > 0 ? arr : undefined;
}

function buildProductBlock(part: NonNullable<Retrieval["part"]>): ProductBlock {
  return {
    type: "product",
    id: part.id,
    partNumber: part.partNumber,
    title: part.title,
    applianceFamily: part.applianceFamily,
    price: pickNumber(part, "price"),
    currency: pickString(part, "currency"),
    inStock: pickBool(part, "inStock"),
    shipEta: pickString(part, "shipEta"),
    rating: pickNumber(part, "rating"),
    reviewCount: pickNumber(part, "reviewCount"),
    manufacturer: pickString(part, "manufacturer"),
    manufacturerPartNumber: pickString(part, "manufacturerPartNumber"),
    replaces: pickStringArray(part, "replaces"),
  };
}

type RepairStoryRaw = {
  id?: string;
  title?: string;
  body?: string;
  author?: string;
  location?: string;
  difficulty?: string;
  timeLabel?: string;
  toolsUsed?: string[];
  helpfulYes?: number;
  helpfulTotal?: number;
};

function getRepairStories(part: CatalogPart): RepairStoryRaw[] {
  const v = (part as unknown as Record<string, unknown>)?.repairStories;
  if (!Array.isArray(v)) return [];
  return v.filter((s): s is RepairStoryRaw => typeof s === "object" && s !== null);
}

/** Majority label across a list; ties broken by first-seen order. */
function mode(values: Array<string | undefined>): string | undefined {
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const v of values) {
    if (typeof v !== "string" || v.length === 0) continue;
    if (!counts.has(v)) order.push(v);
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let bestKey: string | undefined;
  let bestCount = 0;
  for (const k of order) {
    const c = counts.get(k) ?? 0;
    if (c > bestCount) {
      bestKey = k;
      bestCount = c;
    }
  }
  return bestKey;
}

/**
 * Reduce a part's `repairStories[]` into a single "Most customers report: …"
 * badge-row for the install card. Returns undefined if no stories exist, so
 * the UI can fall back to plain steps-only rendering on sparse data.
 */
export function aggregateInstallSignal(
  part: NonNullable<Retrieval["part"]>
): InstallExperience | undefined {
  const stories = getRepairStories(part);
  if (stories.length === 0) return undefined;
  const difficulty = mode(stories.map((s) => s.difficulty));
  const timeLabel = mode(stories.map((s) => s.timeLabel));
  const tools = Array.from(
    new Set(
      stories.flatMap((s) =>
        Array.isArray(s.toolsUsed)
          ? s.toolsUsed.filter((t): t is string => typeof t === "string" && t.length > 0)
          : []
      )
    )
  );
  return { difficulty, timeLabel, tools, sampleCount: stories.length };
}

function pickTopStories(
  part: NonNullable<Retrieval["part"]>,
  max = 2
): CustomerStory[] | undefined {
  const stories = getRepairStories(part);
  if (stories.length === 0) return undefined;
  const ranked = stories
    .filter((s): s is RepairStoryRaw & { id: string; title: string; body: string } =>
      typeof s.id === "string" && typeof s.title === "string" && typeof s.body === "string"
    )
    .slice()
    .sort((a, b) => (b.helpfulYes ?? 0) - (a.helpfulYes ?? 0))
    .slice(0, max)
    .map<CustomerStory>((s) => ({
      id: s.id,
      title: s.title,
      body: s.body,
      author: s.author,
      location: s.location,
      helpfulYes: s.helpfulYes,
      helpfulTotal: s.helpfulTotal,
    }));
  return ranked.length > 0 ? ranked : undefined;
}

function buildInstallSupportBlock(
  part: NonNullable<Retrieval["part"]>
): SupportBlock {
  return {
    type: "support",
    kind: "install",
    id: part.id,
    title: `Install ${part.partNumber}`,
    subtitle: `${part.title} · ${part.applianceFamily}`,
    partNumber: part.partNumber,
    steps: parseInstallSteps(part.installSteps),
    experience: aggregateInstallSignal(part),
    stories: pickTopStories(part, 2),
  };
}

function buildCompatSupportBlock(
  compat: NonNullable<Retrieval["compatibility"]>
): SupportBlock {
  return {
    type: "support",
    kind: "compat",
    id: compat.id,
    title: "Compatibility check",
    subtitle: `Model ${compat.model} · Part ${compat.partNumber}`,
    verdict: compat.compatible
      ? { label: "Compatible", tone: "ok" }
      : { label: "Not compatible", tone: "warn" },
    note: truncate(compat.note, 280),
  };
}

function buildRepairSupportBlock(
  guide: NonNullable<Retrieval["guide"]>
): SupportBlock {
  return {
    type: "support",
    kind: "repair",
    id: guide.id,
    title: `${guide.brand} ${guide.appliance} — ${guide.topic}`,
    subtitle: "Repair guide",
    steps: guide.steps.slice(0, 8),
  };
}

function buildCandidatesSupportBlock(
  candidates: NonNullable<Retrieval["candidates"]>
): SupportBlock {
  const entries: CandidateEntry[] = candidates.map((c) => ({
    id: c.part.id,
    partNumber: c.part.partNumber,
    title: c.part.title,
    applianceFamily: c.part.applianceFamily,
    reason: c.matchedPhrases[0],
    price: pickNumber(c.part, "price"),
    currency: pickString(c.part, "currency"),
    inStock: pickBool(c.part, "inStock"),
  }));
  return {
    type: "support",
    kind: "candidates",
    id: "support-candidates",
    title: "Candidate parts to check",
    subtitle: `${entries.length} likely match${entries.length === 1 ? "" : "es"} from the catalog`,
    candidates: entries,
  };
}

/**
 * Category 4 (browse): same visual shape as candidates (a list of parts in a support card),
 * but the "reason" comes from the keyword / appliance hit instead of a symptom phrase, and
 * the titling reflects a lookup/browse flow rather than a diagnosis.
 */
function buildSearchSupportBlock(
  searchResults: NonNullable<Retrieval["searchResults"]>
): SupportBlock {
  const entries: CandidateEntry[] = searchResults.map((s) => ({
    id: s.part.id,
    partNumber: s.part.partNumber,
    title: s.part.title,
    applianceFamily: s.part.applianceFamily,
    reason: s.matchedPhrase,
    price: pickNumber(s.part, "price"),
    currency: pickString(s.part, "currency"),
    inStock: pickBool(s.part, "inStock"),
  }));
  return {
    type: "support",
    kind: "candidates",
    id: "support-search",
    title: "Matching parts",
    subtitle: `${entries.length} hit${entries.length === 1 ? "" : "s"} in the catalog`,
    candidates: entries,
  };
}

/**
 * Category 7 (missing info / clarify).
 *
 * We detect when:
 *   (a) the query is clearly in-scope (compat / install / buy / oem / repair / diagnose),
 *   (b) retrieval did NOT produce the anchor the intent needs, and
 *   (c) the query itself is missing the discriminator (model, part number, brand, symptom).
 *
 * In that case we emit a `clarify` support block with the question we need answered,
 * plus short hint examples the user can copy-paste.
 *
 * Intentionally NOT triggered for `generic` (so queries like "PS99" stay no_evidence,
 * which the out-of-scope / garbage-input golden case depends on) and not triggered for
 * `search` (browse queries with no hits are already semantically "no results").
 */
type Clarification = {
  reason: "need_part" | "need_model" | "need_part_and_model" | "need_brand_topic" | "need_symptom" | "need_part_name";
  title: string;
  subtitle: string;
  question: string;
  hints: string[];
};

const MODEL_TOKEN_RE = /\b[A-Z]{3,}\d{2,}[A-Z0-9]*\b/;
const PS_TOKEN_RE = /\bPS\d{5,}\b/i;
/** Catches malformed PS tokens like "PS99". Distinct from a missing part number. */
const PS_MALFORMED_RE = /\bPS\d{1,4}\b/i;
const OEM_TOKEN_RE = /\b(?:W|AP|WP)\d{5,}[A-Z0-9]*\b/i;
const KNOWN_BRANDS = [
  "whirlpool",
  "kitchenaid",
  "maytag",
  "ge",
  "samsung",
  "lg",
  "frigidaire",
  "bosch",
  "amana",
];

function hasPartSignal(userMessage: string, r: Retrieval): boolean {
  if (r.part) return true;
  return PS_TOKEN_RE.test(userMessage) || OEM_TOKEN_RE.test(userMessage);
}

/**
 * For compatibility UX only: session `r.part` may come from welcome text / prior turns.
 * "This/that part" + model must not reuse that PS until the user types a PS/OEM or a
 * non-deictic description that actually resolved `r.part` from *this* message.
 */
function userAnchoredCompatPart(userMessage: string, r: Retrieval): boolean {
  if (PS_TOKEN_RE.test(userMessage) || OEM_TOKEN_RE.test(userMessage)) return true;
  if (/\b(this|that)\s+part\b/i.test(userMessage)) return false;
  if (/\bis\s+it\s+compatible\b/i.test(userMessage)) return false;
  return hasPartSignal(userMessage, r);
}

function hasModelSignal(userMessage: string, r: Retrieval): boolean {
  if (r.compatibility) return true;
  // Strip any PS# first so "PS11752778" doesn't masquerade as a model.
  const cleaned = userMessage.replace(PS_TOKEN_RE, " ").replace(OEM_TOKEN_RE, " ");
  return MODEL_TOKEN_RE.test(cleaned);
}

function hasBrandSignal(userMessage: string): boolean {
  const m = userMessage.toLowerCase();
  return KNOWN_BRANDS.some((b) => m.includes(b));
}

const MODELISH_RE = /\b([A-Z]{2,}\d{3,}[A-Z0-9]{2,})\b/gi;

/**
 * True when the user has only opened the conversation ("find a part") and has not
 * given a PS number, model, appliance, symptom, brand, or a specific part description.
 * Prevents a stray retrieval / LLM tool hit from rendering an arbitrary product card.
 */
export function isVaguePartsShoppingOpener(userMessage: string): boolean {
  const t = userMessage.trim();
  if (t.length === 0) return true;
  if (/\bPS\d{5,}\b/i.test(t)) return false;
  for (const m of t.toUpperCase().matchAll(MODELISH_RE)) {
    if (!m[1].startsWith("PS")) return false;
  }
  const low = t.toLowerCase();
  if (
    /\b(refrigerators?|fridges?|dishwashers?|ice\s*makers?|water\s*dispensers?|water\s*filters?)\b/.test(
      low
    ) ||
    KNOWN_BRANDS.some((b) => low.includes(b))
  ) {
    return false;
  }

  if (/\bfind\s+(a|an|the|some|any)\s+parts?\s*[.?!…]*\s*$/i.test(low)) return true;
  if (/\bfind\s+(me|us)\s+(a|an|the|some)\s+parts?\s*[.?!…]*\s*$/i.test(low)) return true;
  if (/\b(?:want|need)\s+to\s+find\s+(a|an|the|some)\s+parts?\s*[.?!…]*\s*$/i.test(low)) return true;
  if (/^(?:i\s+)?(?:want|need)\s+to\s+find\s+(a|an|the|some)\s+parts?\s*[.?!…]*\s*$/i.test(low)) return true;
  if (/\blooking\s+for\s+(a|an|the|some)\s+parts?\s*[.?!…]*\s*$/i.test(low)) return true;
  if (/^help\s+me\s+find\s+(?:a\s+)?parts?\s*[.?!…]*\s*$/i.test(low)) return true;
  return false;
}

/**
 * Pure greeting / thanks / ack with no PS#, model token, appliance, or part keywords.
 * Used to (1) drop session context for retrieval and (2) skip structured cards.
 */
export function conversationOnlyResponse(userMessage: string): { reply: string } | null {
  const t = userMessage.trim();
  if (t.length < 1 || t.length > 160) return null;
  if (/\bPS\d{5,}\b/i.test(t)) return null;
  for (const m of t.toUpperCase().matchAll(MODELISH_RE)) {
    if (!m[1].startsWith("PS")) return null;
  }
  const low = t.toLowerCase();
  if (
    /\b(refrigerat|fridge|dishwasher|ice\s*maker|water\s*dispenser|install|compat|part\s*number|symptom|leak|broken|fix|repair|partselect)\b/.test(
      low
    ) ||
    KNOWN_BRANDS.some((b) => low.includes(b))
  ) {
    return null;
  }

  if (/^good\s+morning\b[\s!.…]*$/i.test(low)) {
    return {
      reply:
        "Good morning! How can I help with your refrigerator or dishwasher today?",
    };
  }
  if (/^good\s+afternoon\b[\s!.…]*$/i.test(low)) {
    return { reply: "Good afternoon! What can I look up for your fridge or dishwasher?" };
  }
  if (/^good\s+evening\b[\s!.…]*$/i.test(low) || /^good\s+night\b[\s!.…]*$/i.test(low)) {
    return {
      reply:
        "Good evening! Share a model number, a PS part number, or describe what's going wrong and I'll help.",
    };
  }
  if (/^(?:hi|hello|hey|gm)\b[\s!.…]*$/i.test(low)) {
    return {
      reply:
        "Hi! Tell me a PS part number, your appliance model, or what's broken — I'll help you find the right refrigerator or dishwasher part.",
    };
  }
  if (/^(?:thanks?|thank\s+you|thx|ty)\b[\s!.…]*$/i.test(low)) {
    return { reply: "You're welcome — happy to help if anything else comes up." };
  }
  if (/^(?:bye|goodbye)\b[\s!.…]*$/i.test(low)) {
    return { reply: "Take care — reach out anytime you need a part." };
  }
  if (
    /^(?:ok+|okay|yes|no|sure|yep|nope|got\s+it|sounds\s+good|cheers|appreciate\s+it)\b[\s!.…]*$/i.test(
      low
    )
  ) {
    return {
      reply:
        "Sounds good — let me know when you're ready to look up a part or check a model.",
    };
  }
  return null;
}

export function isConversationOnlyTurn(userMessage: string): boolean {
  return conversationOnlyResponse(userMessage) !== null;
}

/** Enough symptom + appliance wording that asking for "more detail" would read wrong. */
function hasStrongRepairSymptom(userMessage: string): boolean {
  const m = userMessage.toLowerCase();
  if (/\b(ice\s*maker|icemaker|ice-maker)\b/.test(m)) return true;
  if (/\b(no ice|not making ice)\b/.test(m)) return true;
  if (/\bwater\s+dispenser\b/.test(m)) return true;
  return (
    /\b(dishwasher|fridge|refrigerator)\b/.test(m) &&
    /\b(not working|won'?t|wont|doesn'?t|broken|leak|leaking|start|drain|fix|repair|stopped)\b/.test(
      m
    )
  );
}

export function detectClarification(
  userMessage: string,
  r: Retrieval,
  intent: ChatIntent
): Clarification | null {
  // Escape hatch: the user typed a PS-like token that's too short to be real
  // (e.g. "PS99"). This is a data-validity issue, not missing info — let the
  // honest "no match found" path handle it so citations stay empty.
  if (PS_MALFORMED_RE.test(userMessage) && !r.part) {
    return null;
  }
  switch (intent) {
    case "compat": {
      const hasPart = userAnchoredCompatPart(userMessage, r);
      const hasModel = hasModelSignal(userMessage, r);
      if (hasPart && hasModel) return null; // retrieval couldn't match — that's a different failure, not a clarify.
      if (!hasPart && !hasModel) {
        return {
          reason: "need_part_and_model",
          title: "Need a part number and a model",
          subtitle: "For compatibility checks",
          question:
            "Which part and which appliance model are you checking? Share the PS number from the part and the model label from your fridge / dishwasher.",
          hints: [
            "Example: Is PS11752778 compatible with WDT780SAEM1?",
            "You can find the model tag behind the kickplate or on the door frame.",
          ],
        };
      }
      if (hasPart && !hasModel) {
        return {
          reason: "need_model",
          title: "Which model?",
          subtitle: "For compatibility checks",
          question:
            "What's your appliance model number? I need it to check whether this part fits your fridge or dishwasher.",
          hints: [
            "Example: Is this compatible with WDT780SAEM1?",
            "The model tag is usually inside the door or behind the kickplate.",
          ],
        };
      }
      // !hasPart && hasModel
      return {
        reason: "need_part",
        title: "Which part?",
        subtitle: "For compatibility checks",
        question:
          "Which part are you checking? Paste the PS number (starts with PS) or an OEM manufacturer part number.",
        hints: ["Example: Is PS11752778 compatible with my model?"],
      };
    }
    case "install":
    case "buy":
    case "oem": {
      if (hasPartSignal(userMessage, r)) return null;
      return {
        reason: "need_part",
        title: "Which part?",
        subtitle:
          intent === "install"
            ? "For install instructions"
            : intent === "buy"
              ? "For price & stock"
              : "For OEM / manufacturer lookup",
        question:
          intent === "install"
            ? "Which part would you like to install? Share the PS number or the name (e.g. 'lower rack wheel')."
            : intent === "buy"
              ? "Which part's price would you like? Share the PS number or describe the part."
              : "Which OEM code are you looking up? Paste the manufacturer number (e.g. W10195416).",
        hints: [
          "Example: How do I install PS11752778?",
          "Example: What's the PS number for OEM W10195416?",
        ],
      };
    }
    case "repair": {
      if (r.guide) return null;
      const needsBrand = !hasBrandSignal(userMessage);
      // Brand + clear symptom but no guide row — don't gaslight with "be more specific".
      if (!needsBrand && hasStrongRepairSymptom(userMessage)) return null;
      return {
        reason: "need_brand_topic",
        title: "Need more detail to troubleshoot",
        subtitle: "For repair guides",
        question: needsBrand
          ? "Which brand of fridge or dishwasher, and what exactly is going wrong? I need the brand plus a specific symptom to pull the right repair guide."
          : "I couldn't match a repair guide to those exact words in the catalog. Try a short symptom phrase (e.g. ice maker not making ice, water dispenser dead, dishwasher won't start) or tap an example below.",
        hints: [
          "Example: Whirlpool refrigerator ice maker not working",
          "Example: Whirlpool dishwasher won't start",
        ],
      };
    }
    case "diagnose": {
      // If we already matched a repair guide or a compatibility row, don't stack a
      // "describe your symptom" clarify — that produces misleading chips (e.g. fridge
      // ice/dispenser examples) next to a dishwasher repair card.
      if (r.guide || r.compatibility) return null;
      if (r.candidates && r.candidates.length > 0) return null;
      return {
        reason: "need_symptom",
        title: "Describe the symptom",
        subtitle: "For candidate parts",
        question:
          "What's the symptom exactly? E.g. 'no ice', 'water dispenser not working', 'dishwasher won't start'. The more specific, the better I can pick the right parts.",
        hints: [
          "Example: What parts do I need for no ice and water dispenser not working?",
          "Example: Which parts to replace for dishwasher won't start?",
        ],
      };
    }
    case "search": {
      // If retrieval already found something (keyword / appliance hit), no need to clarify.
      if (r.part || (r.searchResults && r.searchResults.length > 0)) return null;
      return {
        reason: "need_part_name",
        title: "Which part?",
        subtitle: "For part lookup",
        question:
          "Which part are you looking for? You can share a PS number, an OEM code, a part name, or describe what's broken.",
        hints: [
          "Example: Find part PS11752778",
          "Example: Show me refrigerator door bin parts",
          "Example: I need a dishwasher door latch",
          "Example: What is a PS number?",
          "Example: What is an OEM code?",
        ],
      };
    }
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* Category 6 — out-of-scope detection.                                 */
/*                                                                      */
/* Scope is the hard edge of this agent: refrigerator + dishwasher parts*/
/* only. Anything else gets a polite refusal that redirects into the    */
/* domain. Like clarify, this is *dialog*, not structured catalog data, */
/* so it renders as reply + chips — no card.                            */
/*                                                                      */
/* Two-stage filter, rule-first (LLM is unreliable on jailbreak prompts)*/
/*   (a) White-list: any in-domain signal word → never treat as OOS.    */
/*   (b) Black-list: a curated set of unambiguously-OOS tokens / phrases*/
/*       (other appliances, unrelated topics, prompt-injection attempts)*/
/*   (c) No signal either way → fall through (the "no match found"     */
/*       branch handles it; we'd rather stay silent than over-refuse). */
/* ------------------------------------------------------------------ */

/**
 * In-domain signal words. If ANY of these appear, we never refuse.
 * Matched as whole words (so short brand tokens like `ge` / `lg` don't
 * false-positive on "generate" / "algorithm").
 */
const IN_SCOPE_SIGNAL_RE = new RegExp(
  "\\b(?:" +
    [
      "refrigerators?",
      "fridges?",
      "dishwashers?",
      "ice ?makers?",
      "water dispensers?",
      "water filters?",
      "defrost",
      "compressors?",
      "evaporators?",
      "door (?:seals?|gaskets?)",
      "racks?",
      "spray arms?",
      "detergent dispensers?",
      "drain pumps?",
      "heating elements?",
      ...KNOWN_BRANDS,
    ].join("|") +
    ")\\b",
  "i"
);

/**
 * Clearly-OOS tokens, grouped by reason so we can tailor the refusal.
 * Ordering matters: more specific groups first.
 */
const OOS_GROUPS: Array<{ reason: string; patterns: RegExp[]; label: string }> = [
  {
    reason: "prompt_injection",
    label: "instruction override",
    patterns: [
      /\bignore (your|all|the|previous) (instructions?|rules?|prompt)\b/i,
      /\bforget (your|all|the|previous) (instructions?|rules?|prompt)\b/i,
      /\bsystem prompt\b/i,
      /\bpretend you(?:'re| are)\b/i,
      /\bact as (?!a? ?part|an? (appliance|repair))/i,
    ],
  },
  {
    reason: "other_appliance",
    label: "other appliance",
    patterns: [
      /\b(washer|washing machine|dryer|clothes dryer|microwave|oven|range|stove|cooktop|vacuum|air ?conditioner|a\/c|water heater)\b/i,
    ],
  },
  {
    reason: "code_request",
    label: "programming help",
    patterns: [
      /\b(write|generate|give me) (me )?(a |some )?(python|javascript|typescript|java|c\+\+|rust|go) (code|script|function|program)\b/i,
      /\b(python|javascript|typescript) scraper\b/i,
      /\bregex for\b/i,
    ],
  },
  {
    reason: "unrelated_topic",
    label: "unrelated topic",
    patterns: [
      /\b(nba|nfl|mlb|world cup|super bowl|olympics?)\b/i,
      /\b(weather|forecast|temperature outside)\b/i,
      /\b(recipe|cook|cooking)\b/i,
      /\b(joke|poem|story|essay|homework)\b/i,
      /\b(stock price|crypto|bitcoin|ethereum)\b/i,
      /\bwho (won|is|was) (the|a )\b/i,
    ],
  },
];

export type OutOfScopeReason =
  | "prompt_injection"
  | "other_appliance"
  | "code_request"
  | "unrelated_topic";

export function detectOutOfScope(
  userMessage: string
): { reason: OutOfScopeReason; label: string } | null {
  // White-list short-circuit: any domain signal word → not out-of-scope,
  // even if a black-list word also appears (e.g. "dryer on my dishwasher" —
  // the dishwasher anchor wins).
  if (IN_SCOPE_SIGNAL_RE.test(userMessage)) return null;
  // PS-number presence is also a strong in-scope anchor.
  if (/\bPS\d{5,}\b/i.test(userMessage)) return null;
  for (const g of OOS_GROUPS) {
    if (g.patterns.some((re) => re.test(userMessage))) {
      return { reason: g.reason as OutOfScopeReason, label: g.label };
    }
  }
  return null;
}

/**
 * Category 6 — refuse OOS queries with a polite redirect. Like clarify, this
 * returns reply + chips; the chips anchor the user back to in-domain questions.
 * Runs AFTER clarify in the route (clarify is more specific — "I can tell you're
 * asking about compat but need the model" beats "I only do fridge/dishwasher parts").
 */
export function buildOutOfScopeReplyFromRetrieval(
  userMessage: string
): { reply: string; hints: string[]; reason: OutOfScopeReason } | null {
  const oos = detectOutOfScope(userMessage);
  if (!oos) return null;

  // Tailor the opening sentence by reason. Tail is shared: redirect + examples.
  const opener =
    oos.reason === "prompt_injection"
      ? "I can't change my role — I'm a PartSelect assistant for refrigerator and dishwasher parts."
      : oos.reason === "other_appliance"
        ? "That's outside my scope — I only cover refrigerator and dishwasher parts, not other appliances."
        : oos.reason === "code_request"
          ? "I can't help with general programming — I'm focused on refrigerator and dishwasher parts."
          : "That's outside my scope — I only help with refrigerator and dishwasher parts.";

  const reply = `${opener} If you have a part number, model number, or a symptom for either appliance, I can help with that.`;

  return {
    reply,
    hints: [
      "How do I install PS11752778?",
      "Is PS11752778 compatible with WDT780SAEM1?",
      "My Whirlpool fridge ice maker isn't working",
    ],
    reason: oos.reason,
  };
}

/**
 * Category 7 — clarify is a conversational artifact, not structured catalog data.
 * It surfaces as the assistant's reply text plus example-prompt chips, never as a card.
 * Returns `null` when the current query doesn't need clarification.
 */
export function buildClarifyReplyFromRetrieval(
  r: Retrieval,
  userMessage: string
): { reply: string; hints: string[] } | null {
  if (isConversationOnlyTurn(userMessage)) return null;
  if (isVaguePartsShoppingOpener(userMessage)) {
    return {
      reply:
        "Sure — tell me the refrigerator or dishwasher model number, or the part number if you have it, and I'll help find the right part.",
      hints: [
        "Find part PS11752778",
        "Is PS11752778 compatible with WDT780SAEM1?",
        "The ice maker on my Whirlpool fridge is not working",
      ],
    };
  }
  const intent = classifyIntent(userMessage);
  // `generic` never clarifies — keeps garbage input as honest no_evidence.
  if (intent === "generic") return null;
  // `detectClarification` already knows, per intent, which anchor is missing — so
  // we can ask about "model" even when `r.part` was found (e.g. "Is PS11752778 compatible?").
  const clar = detectClarification(userMessage, r, intent);
  if (!clar) return null;

  // Split hints: "Example: ..." entries become clickable chips; plain informational
  // tips get appended to the reply text so they read naturally instead of as buttons.
  const exampleHints: string[] = [];
  const tipHints: string[] = [];
  for (const h of clar.hints) {
    if (/^Example:\s*/i.test(h)) {
      exampleHints.push(h.replace(/^Example:\s*/i, ""));
    } else {
      tipHints.push(h);
    }
  }

  const reply =
    tipHints.length > 0
      ? `${clar.question}\n\n${tipHints.join(" ")}`
      : clar.question;

  return { reply, hints: exampleHints };
}

export function buildBlocksFromRetrieval(
  r: Retrieval,
  userMessage = ""
): ChatBlock[] {
  if (isConversationOnlyTurn(userMessage)) return [];

  const intent = classifyIntent(userMessage);
  const vagueOpener = isVaguePartsShoppingOpener(userMessage);
  const blocks: ChatBlock[] = [];

  switch (intent) {
    case "buy":
      if (!vagueOpener && r.part) blocks.push(buildProductBlock(r.part));
      break;
    case "oem":
      if (!vagueOpener && r.part) blocks.push(buildProductBlock(r.part));
      break;
    case "install":
      if (r.part) blocks.push(buildInstallSupportBlock(r.part));
      break;
    case "compat":
      if (r.compatibility && !detectClarification(userMessage, r, "compat")) {
        blocks.push(buildCompatSupportBlock(r.compatibility));
      }
      break;
    case "repair":
    case "diagnose":
      // Always show the repair guide first if one matched, then candidate parts.
      // This gives users the consistent flow: "try these steps → if you need a part, here are the candidates."
      if (r.guide) blocks.push(buildRepairSupportBlock(r.guide));
      if (r.candidates && r.candidates.length > 0) {
        blocks.push(buildCandidatesSupportBlock(r.candidates));
      }
      break;
    case "search":
      // ≥2 hits → multi-result list card; exactly 1 → fall through to a product card
      // (same UX as "Find a lower rack wheel" today); 0 → no block.
      if (!vagueOpener) {
        if (r.searchResults && r.searchResults.length >= 2) {
          blocks.push(buildSearchSupportBlock(r.searchResults));
        } else if (r.part) {
          blocks.push(buildProductBlock(r.part));
        }
      }
      break;
    case "generic":
    default:
      // If retrieval resolved a compatibility row (e.g. the user replied with
      // just a model number after a clarify turn that already knew the part),
      // show the compat card — it's the most specific answer we have.
      // Otherwise fall back to a product card if a part is known.
      if (r.compatibility && !detectClarification(userMessage, r, "compat")) {
        blocks.push(buildCompatSupportBlock(r.compatibility));
      } else if (!vagueOpener && r.part) {
        blocks.push(buildProductBlock(r.part));
      }
      break;
  }

  // Category 7 (missing-info / clarify) is NOT emitted as a block here — a clarifying
  // question is dialog, not structured catalog content. The route layer pulls the
  // question text via `buildClarifyReplyFromRetrieval` and surfaces it as the reply
  // plus example-prompt chips.
  return blocks;
}

/** Chips describe the next useful pivot, given which card we just showed. */
export function buildSuggestedActionsFromRetrieval(
  r: Retrieval,
  userMessage = ""
): SuggestedAction[] {
  const intent = classifyIntent(userMessage);
  const out: SuggestedAction[] = [];
  const seen = new Set<string>();
  const push = (a: SuggestedAction) => {
    if (seen.has(a.id)) return;
    seen.add(a.id);
    out.push(a);
  };

  // Override chips follow the same priority as the route-level reply override:
  // OOS first (domain gate), then clarify (in-domain missing field).
  const oos = buildOutOfScopeReplyFromRetrieval(userMessage);
  if (oos) {
    oos.hints.forEach((h, i) => {
      push({
        id: `oos-ex-${i}`,
        label: h,
        prompt: h,
      });
    });
    return out.slice(0, 5);
  }

  if (isConversationOnlyTurn(userMessage)) {
    push({ id: "co-find", label: "Find part by PS", prompt: "Find part PS11752778" });
    push({
      id: "co-compat",
      label: "Check compatibility",
      prompt: "Is PS11752778 compatible with WRS325SDHZ?",
    });
    push({
      id: "co-symptom",
      label: "Ice maker not working",
      prompt: "The ice maker on my Whirlpool fridge is not working. How can I fix it?",
    });
    return out.slice(0, 6);
  }

  const clar = buildClarifyReplyFromRetrieval(r, userMessage);
  if (clar) {
    clar.hints.forEach((h, i) => {
      push({
        id: `clarify-ex-${i}`,
        label: h,
        prompt: h,
      });
    });
    return out.slice(0, 6);
  }

  const pn = r.part?.partNumber ?? r.compatibility?.partNumber;

  switch (intent) {
    case "buy":
      // User asked price / stock — only suggest the natural pre-purchase check.
      if (pn) {
        push({
          id: "check-fit",
          label: "Check fit",
          prompt: `Is ${pn} compatible with my model?`,
        });
      }
      break;
    case "oem":
      if (pn) {
        push({
          id: "price-stock",
          label: "Price & stock",
          prompt: `How much is ${pn} and is it in stock?`,
        });
        push({
          id: "check-fit",
          label: "Check fit",
          prompt: `Is ${pn} compatible with my model?`,
        });
      }
      break;
    case "install":
      // User already asked for install — avoid unrelated shopping pivots (check fit / price)
      // that read like upsell rather than a natural continuation of the install answer.
      break;
    case "compat":
      // Incompatible PS↔model: no chips (no symptom yet; install/price would mislead).
      if (r.compatibility && pn && r.compatibility.compatible) {
        push({
          id: "install",
          label: "Install",
          prompt: `How do I install ${pn}?`,
        });
        push({
          id: "price-stock",
          label: "Price & stock",
          prompt: `How much is ${pn} and is it in stock?`,
        });
      }
      break;
    case "repair":
      if (r.guide) {
        const c = r.candidates;
        if (c && c.length > 0) {
          for (const row of c) {
            const ps = row.part.partNumber;
            push({
              id: `price-stock-${ps}`,
              label: `Price & stock (${ps})`,
              prompt: `How much is ${ps} and is it in stock?`,
            });
          }
          if (c.length === 1) {
            const only = c[0].part.partNumber;
            push({
              id: `check-fit-${only}`,
              label: `Check fit (${only})`,
              prompt: `Is ${only} compatible with my model?`,
            });
          }
        } else {
          push({
            id: "related-parts",
            label: "Related parts",
            prompt: `What parts are needed to fix ${r.guide.brand} ${r.guide.appliance} ${r.guide.topic}?`,
          });
        }
      }
      break;
    case "diagnose":
      if (r.candidates && r.candidates.length > 0) {
        for (const row of r.candidates) {
          const ps = row.part.partNumber;
          push({
            id: `price-stock-${ps}`,
            label: `Price & stock (${ps})`,
            prompt: `How much is ${ps} and is it in stock?`,
          });
        }
        if (r.candidates.length === 1) {
          const only = r.candidates[0].part.partNumber;
          push({
            id: `check-fit-${only}`,
            label: `Check fit (${only})`,
            prompt: `Is ${only} compatible with my model?`,
          });
        }
      }
      break;
    case "search":
      if (r.searchResults && r.searchResults.length > 0) {
        for (const hit of r.searchResults) {
          const ps = hit.part.partNumber;
          push({
            id: `price-stock-${ps}`,
            label: `Price & stock (${ps})`,
            prompt: `How much is ${ps} and is it in stock?`,
          });
        }
        if (r.searchResults.length === 1) {
          const only = r.searchResults[0].part.partNumber;
          push({
            id: `check-fit-${only}`,
            label: `Check fit (${only})`,
            prompt: `Is ${only} compatible with my model?`,
          });
        }
      } else if (pn) {
        push({
          id: "price-stock",
          label: "Price & stock",
          prompt: `How much is ${pn} and is it in stock?`,
        });
        push({
          id: "check-fit",
          label: "Check fit",
          prompt: `Is ${pn} compatible with my model?`,
        });
      }
      break;
    case "generic":
    default:
      if (pn) {
        push({
          id: "price-stock",
          label: "Price & stock",
          prompt: `How much is ${pn} and is it in stock?`,
        });
        push({
          id: "check-fit",
          label: "Check fit",
          prompt: `Is ${pn} compatible with my model?`,
        });
      }
      break;
  }

  // Cap chip count; allow one row per catalog hit (up to 3) plus optional single check-fit.
  return out.slice(0, 6);
}
