import catalog from "../../data/catalog.json";

type Part = (typeof catalog.parts)[number];
type RepairStoryRaw = Record<string, unknown>;

function getStories(part: Part): RepairStoryRaw[] {
  const v = (part as unknown as Record<string, unknown>).repairStories;
  return Array.isArray(v) ? (v as RepairStoryRaw[]) : [];
}

function mode(values: (string | undefined)[]): string | undefined {
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const v of values) {
    if (typeof v !== "string" || !v) continue;
    if (!counts.has(v)) order.push(v);
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestN = 0;
  for (const k of order) {
    const n = counts.get(k) ?? 0;
    if (n > bestN) { best = k; bestN = n; }
  }
  return best;
}

export type InstallGuideResult =
  | {
      ok: true;
      partNumber: string;
      title: string;
      steps: string[];
      experience: {
        difficulty?: string;
        timeLabel?: string;
        tools: string[];
        sampleCount: number;
      };
    }
  | { ok: false; error: string };

/**
 * Tool: `get_install_guide`
 * Return step-by-step install instructions for a part, enriched with
 * aggregated customer-experience signals (difficulty, time, tools).
 */
export function getInstallGuideTool(input: {
  part_number: string;
}): InstallGuideResult {
  const needle = input.part_number.trim().toUpperCase();
  const part = catalog.parts.find(
    (p) => p.partNumber.toUpperCase() === needle
  );
  if (!part) {
    return { ok: false, error: `No part found for ${needle}` };
  }

  const raw = part.installSteps ?? "";
  const steps = raw
    .split(/\n+/)
    .map((l) => l.trim().replace(/^\d+[).]\s*/, ""))
    .filter((l) => l.length > 0);

  if (steps.length === 0) {
    return { ok: false, error: `No install steps recorded for ${needle}` };
  }

  const stories = getStories(part);
  const difficulty = mode(stories.map((s) => s.difficulty as string | undefined));
  const timeLabel = mode(stories.map((s) => s.timeLabel as string | undefined));
  const tools = Array.from(
    new Set(
      stories.flatMap((s) => {
        const t = s.toolsUsed;
        return Array.isArray(t)
          ? (t as unknown[]).filter((x): x is string => typeof x === "string")
          : [];
      })
    )
  );

  return {
    ok: true,
    partNumber: part.partNumber,
    title: part.title,
    steps,
    experience: { difficulty, timeLabel, tools, sampleCount: stories.length },
  };
}
