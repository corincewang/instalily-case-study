import { retrieveExact } from "./retrieveExact";

type Retrieval = ReturnType<typeof retrieveExact>;

/** Server-built UI block: grounded in catalog only (5-P0). */
export type ProductBlock = {
  type: "product";
  id: string;
  partNumber: string;
  title: string;
  applianceFamily: string;
  installSummary: string;
};

export type CompatibilityBlock = {
  type: "compatibility";
  id: string;
  model: string;
  partNumber: string;
  compatible: boolean;
  note: string;
};

export type RepairGuideBlock = {
  type: "repair_guide";
  id: string;
  brand: string;
  appliance: string;
  topic: string;
  steps: string[];
};

export type ChatBlock = ProductBlock | CompatibilityBlock | RepairGuideBlock;

export type SuggestedAction = {
  id: string;
  label: string;
  /** Prefills the chat input when the user taps the chip. */
  prompt: string;
};

function truncate(s: string, max: number) {
  const t = s.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

export function buildBlocksFromRetrieval(r: Retrieval): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  if (r.part) {
    blocks.push({
      type: "product",
      id: r.part.id,
      partNumber: r.part.partNumber,
      title: r.part.title,
      applianceFamily: r.part.applianceFamily,
      installSummary: truncate(r.part.installSteps, 240),
    });
  }
  if (r.compatibility) {
    blocks.push({
      type: "compatibility",
      id: r.compatibility.id,
      model: r.compatibility.model,
      partNumber: r.compatibility.partNumber,
      compatible: r.compatibility.compatible,
      note: truncate(r.compatibility.note, 280),
    });
  }
  if (r.guide) {
    blocks.push({
      type: "repair_guide",
      id: r.guide.id,
      brand: r.guide.brand,
      appliance: r.guide.appliance,
      topic: r.guide.topic,
      steps: r.guide.steps.slice(0, 8),
    });
  }
  return blocks;
}

/** Rule-based follow-ups derived from retrieval (5-P0). */
export function buildSuggestedActionsFromRetrieval(
  r: Retrieval
): SuggestedAction[] {
  const out: SuggestedAction[] = [];
  const seen = new Set<string>();

  const push = (a: SuggestedAction) => {
    if (seen.has(a.id)) return;
    seen.add(a.id);
    out.push(a);
  };

  if (r.part) {
    const pn = r.part.partNumber;
    push({
      id: "check-fit",
      label: "Check fit",
      prompt: `Compatibility ${pn}`,
    });
    push({
      id: "install",
      label: "Install",
      prompt: `Install ${pn}`,
    });
    push({
      id: "order",
      label: "Order help",
      prompt: `Order support ${pn}`,
    });
  }
  if (r.compatibility) {
    push({
      id: "install-part",
      label: "Install",
      prompt: `Install ${r.compatibility.partNumber}`,
    });
    push({
      id: "order-compat",
      label: "Order help",
      prompt: `Order support ${r.compatibility.partNumber}`,
    });
  }
  if (r.guide) {
    push({
      id: "related-parts",
      label: "Related parts",
      prompt: `Parts for ${r.guide.brand} ${r.guide.appliance} ${r.guide.topic}`,
    });
    push({
      id: "install-generic",
      label: "Install help",
      prompt: `Installation help ${r.guide.brand} ${r.guide.appliance}`,
    });
  }

  return out.slice(0, 5);
}
