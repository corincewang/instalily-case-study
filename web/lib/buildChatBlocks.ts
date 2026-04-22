import { retrieveExact } from "./retrieveExact";

type Retrieval = ReturnType<typeof retrieveExact>;

/**
 * Two-card vocabulary, mapped to the case-study prompt:
 *   product  — "product information"
 *   support  — "assist with customer transactions" (install / compat / repair)
 * Each assistant turn emits AT MOST one product + one support card (usually one).
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
  if (/\b(compat|compatible|compatibility|fit|fits|work with|works with)\b/.test(m)) {
    return "compat";
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
  if (
    /\b(show me|show us|browse)\b/.test(m) ||
    /\blist\s+(all|me|the|every|our)?\s*(dishwasher|refrigerator|fridge)?\s*parts?\b/.test(m) ||
    /\bfind\s+(a|an|the|all|some|me|any)\b/.test(m) ||
    /\bparts?\s+(for|list|catalog)\b/.test(m) ||
    /\b(dishwasher|refrigerator|fridge)\s+parts?\b/.test(m)
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
      ? { label: "Compatible (demo data)", tone: "ok" }
      : { label: "Not compatible (demo data)", tone: "warn" },
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
  reason: "need_part" | "need_model" | "need_part_and_model" | "need_brand_topic" | "need_symptom";
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
      const hasPart = hasPartSignal(userMessage, r);
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
            "e.g. Is PS11752778 compatible with WDT780SAEM1?",
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
      return {
        reason: "need_brand_topic",
        title: "Need more detail to troubleshoot",
        subtitle: "For repair guides",
        question: needsBrand
          ? "Which brand of fridge or dishwasher, and what exactly is going wrong? I need the brand plus a specific symptom to pull the right repair guide."
          : "What exactly is going wrong? A more specific symptom (e.g. 'ice maker not working', 'won't drain') helps me pull the right repair guide.",
        hints: [
          "Example: Whirlpool refrigerator ice maker not working",
          "Example: KitchenAid dishwasher won't start",
        ],
      };
    }
    case "diagnose": {
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
  const intent = classifyIntent(userMessage);
  // `generic` and `search` deliberately never clarify — that keeps garbage input
  // and empty-browse paths honestly no_evidence instead of chatty.
  if (intent === "generic" || intent === "search") return null;
  // `detectClarification` already knows, per intent, which anchor is missing — so
  // we can ask about "model" even when `r.part` was found (e.g. "Is PS11752778 compatible?").
  const clar = detectClarification(userMessage, r, intent);
  if (!clar) return null;
  return {
    reply: clar.question,
    hints: clar.hints.map((h) => h.replace(/^Example:\s*/i, "")),
  };
}

export function buildBlocksFromRetrieval(
  r: Retrieval,
  userMessage = ""
): ChatBlock[] {
  const intent = classifyIntent(userMessage);
  const blocks: ChatBlock[] = [];

  switch (intent) {
    case "buy":
      if (r.part) blocks.push(buildProductBlock(r.part));
      break;
    case "oem":
      if (r.part) blocks.push(buildProductBlock(r.part));
      break;
    case "install":
      if (r.part) blocks.push(buildInstallSupportBlock(r.part));
      break;
    case "compat":
      if (r.compatibility) blocks.push(buildCompatSupportBlock(r.compatibility));
      break;
    case "repair":
      if (r.guide) blocks.push(buildRepairSupportBlock(r.guide));
      break;
    case "diagnose":
      if (r.candidates && r.candidates.length > 0) {
        blocks.push(buildCandidatesSupportBlock(r.candidates));
      }
      break;
    case "search":
      // ≥2 hits → multi-result list card; exactly 1 → fall through to a product card
      // (same UX as "Find a lower rack wheel" today); 0 → no block.
      if (r.searchResults && r.searchResults.length >= 2) {
        blocks.push(buildSearchSupportBlock(r.searchResults));
      } else if (r.part) {
        blocks.push(buildProductBlock(r.part));
      }
      break;
    case "generic":
    default:
      if (r.part) blocks.push(buildProductBlock(r.part));
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
        label: h.length > 28 ? `${h.slice(0, 28)}…` : h,
        prompt: h,
      });
    });
    return out.slice(0, 5);
  }
  const clar = buildClarifyReplyFromRetrieval(r, userMessage);
  if (clar) {
    clar.hints.forEach((h, i) => {
      push({
        id: `clarify-ex-${i}`,
        label: h.length > 28 ? `${h.slice(0, 28)}…` : h,
        prompt: h,
      });
    });
    return out.slice(0, 5);
  }

  const pn = r.part?.partNumber ?? r.compatibility?.partNumber;

  switch (intent) {
    case "buy":
      if (pn) {
        push({
          id: "check-fit",
          label: "Check fit",
          prompt: `Is ${pn} compatible with my model?`,
        });
        push({
          id: "install",
          label: "Install",
          prompt: `How do I install ${pn}?`,
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
      if (pn) {
        push({
          id: "check-fit",
          label: "Check fit",
          prompt: `Is ${pn} compatible with my model?`,
        });
        push({
          id: "price-stock",
          label: "Price & stock",
          prompt: `How much is ${pn} and is it in stock?`,
        });
      }
      break;
    case "compat":
      if (pn) {
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
        push({
          id: "related-parts",
          label: "Related parts",
          prompt: `What parts are needed to fix ${r.guide.brand} ${r.guide.appliance} ${r.guide.topic}?`,
        });
        push({
          id: "install-generic",
          label: "Installation help",
          prompt: `Installation help ${r.guide.brand} ${r.guide.appliance}`,
        });
      }
      break;
    case "diagnose":
      if (r.candidates && r.candidates.length > 0) {
        const top = r.candidates[0].part.partNumber;
        push({
          id: "troubleshoot",
          label: "Troubleshoot",
          prompt: `How do I troubleshoot before replacing ${top}?`,
        });
        push({
          id: "install-top",
          label: `Install ${top}`,
          prompt: `How do I install ${top}?`,
        });
      }
      break;
    case "search":
      if (r.searchResults && r.searchResults.length > 0) {
        const top = r.searchResults[0].part.partNumber;
        push({
          id: "price-stock-top",
          label: `Price & stock ${top}`,
          prompt: `How much is ${top} and is it in stock?`,
        });
        push({
          id: "check-fit-top",
          label: `Check fit ${top}`,
          prompt: `Is ${top} compatible with my model?`,
        });
        push({
          id: "install-top",
          label: `Install ${top}`,
          prompt: `How do I install ${top}?`,
        });
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
        push({
          id: "install",
          label: "Install",
          prompt: `How do I install ${pn}?`,
        });
      }
      break;
  }

  return out.slice(0, 5);
}
