import type { CatalogShape } from "./catalogTypes";
import { prisma } from "./prisma";

/** Prefetch bound for FULLTEXT + in-memory rescoring (symptom/browse). Tunable for ~100k rows. */
export const FTS_PREFETCH_LIMIT = 48;

/** Top-K parts surfaced to the model / UI for symptom reverse-diagnosis. */
export const SYMPTOM_TOP_K = 3;

/** Top-K for appliance/keyword browse cards. */
export const SEARCH_TOP_K = 3;

export type PartRow = CatalogShape["parts"][number];

function jsonPart(row: { data: unknown }): PartRow {
  return row.data as PartRow;
}

export function buildSearchDocument(part: PartRow): string {
  const keywords = Array.isArray(part.keywords) ? (part.keywords as string[]).join(" ") : "";
  const symptoms = Array.isArray((part as { symptoms?: string[] }).symptoms)
    ? ((part as { symptoms?: string[] }).symptoms ?? []).join(" ")
    : "";
  const mpn = (part as { manufacturerPartNumber?: string }).manufacturerPartNumber ?? "";
  return [part.title, part.partNumber, mpn, part.applianceFamily ?? "", keywords, symptoms]
    .filter(Boolean)
    .join("\n");
}

/** Align with retrieveExact / seed: collapse spacing and punctuation for model matching. */
export function collapseModelTokenDb(s: string): string {
  return s.replace(/[\s._\-]/g, "").toUpperCase();
}

const FTS_STOP = new Set([
  "the",
  "and",
  "for",
  "not",
  "are",
  "but",
  "you",
  "all",
  "can",
  "her",
  "was",
  "one",
  "our",
  "out",
  "day",
  "get",
  "has",
  "him",
  "his",
  "how",
  "its",
  "may",
  "new",
  "now",
  "old",
  "see",
  "two",
  "who",
  "way",
  "did",
]);

/**
 * Build a safe InnoDB BOOLEAN MODE query (+token* …). Returns null if nothing usable.
 */
export function booleanModeQueryFromText(lower: string): string | null {
  const tokens = lower.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    if (FTS_STOP.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(`+${t}*`);
    if (out.length >= 24) break;
  }
  return out.length > 0 ? out.join(" ") : null;
}

export async function lookupPartByPs(partNumber: string): Promise<PartRow | null> {
  const needle = partNumber.trim().toUpperCase();
  if (!needle) return null;
  const row = await prisma.catalogPart.findUnique({
    where: { partNumber: needle },
  });
  return row ? jsonPart(row) : null;
}

/** Indexed OEM lookup — equality on denormalized manufacturerPartNumber. */
export async function lookupPartByManufacturerCodes(codes: string[]): Promise<PartRow | null> {
  const uniq = [...new Set(codes.map((c) => c.trim().toUpperCase()).filter((c) => c.length >= 5))];
  if (uniq.length === 0) return null;
  const batchSize = 60;
  for (let i = 0; i < uniq.length; i += batchSize) {
    const chunk = uniq.slice(i, i + batchSize);
    const rows = await prisma.catalogPart.findMany({
      where: { manufacturerPartNumber: { in: chunk } },
      take: 2,
    });
    if (rows.length > 0) return jsonPart(rows[0]!);
  }
  return null;
}

/** Extract alphanumeric OEM-like tokens from the user message (length ≥ 5). */
export function extractManufacturerLikeTokens(upper: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of upper.matchAll(/\b[A-Z0-9]{5,}\b/g)) {
    const t = m[0];
    if (/^PS\d+/i.test(t)) continue;
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

export async function lookupPartBySupersededNumbers(
  oldNumbers: string[]
): Promise<{ part: PartRow; matchedNormalized: string } | null> {
  const norms = [
    ...new Set(oldNumbers.map((s) => collapseModelTokenDb(s)).filter((s) => s.length >= 5)),
  ];
  if (norms.length === 0) return null;

  const rows = await prisma.catalogPartReplace.findMany({
    where: { oldNumberNormalized: { in: norms } },
    include: { part: true },
    take: 5,
  });
  if (rows.length === 0) return null;
  const row = rows[0]!;
  return { part: jsonPart(row.part), matchedNormalized: row.oldNumberNormalized };
}

export async function documentedModelsForPart(partNumber: string): Promise<string[]> {
  const pn = partNumber.trim().toUpperCase();
  const rows = await prisma.catalogCompatibility.findMany({
    where: { partNumber: pn },
    select: { data: true },
  });
  const models: string[] = [];
  for (const r of rows) {
    const m = (r.data as { model?: string }).model;
    if (typeof m === "string" && m.trim()) models.push(m);
  }
  return models;
}

/** Extract collapsed model candidates from free text (appliance model tokens). */
export function extractCollapsedModelCandidates(hay: string): string[] {
  const set = new Set<string>();
  for (const m of hay.matchAll(/\b([A-Z]{2,}\d{3,}[A-Z0-9]{2,})\b/gi)) {
    const col = collapseModelTokenDb(m[1] ?? "");
    if (col.length >= 6 && !/^PS\d/i.test(col)) set.add(col);
  }
  return [...set];
}

export async function findCompatibilityMatch(params: {
  augUpper: string;
  augCollapsed: string;
  part?: PartRow | null;
}): Promise<CatalogShape["compatibilities"][number] | undefined> {
  const models = extractCollapsedModelCandidates(`${params.augUpper} ${params.augCollapsed}`);
  const partPs = params.part?.partNumber?.trim().toUpperCase();

  let rows;

  if (models.length > 0 && partPs) {
    rows = await prisma.catalogCompatibility.findMany({
      where: { partNumber: partPs, modelNormalized: { in: models } },
      take: 80,
    });
  } else if (models.length > 0) {
    rows = await prisma.catalogCompatibility.findMany({
      where: { modelNormalized: { in: models } },
      take: 80,
    });
  } else if (partPs) {
    rows = await prisma.catalogCompatibility.findMany({
      where: { partNumber: partPs },
      take: 120,
    });
  } else {
    return undefined;
  }

  const normalizeModelToken = (s: string) => s.trim().toUpperCase();

  for (const row of rows) {
    const c = row.data as CatalogShape["compatibilities"][number];
    const modelUpper = normalizeModelToken(c.model);
    const modelCollapsed = collapseModelTokenDb(c.model);
    const modelMatches =
      params.augUpper.includes(modelUpper) || params.augCollapsed.includes(modelCollapsed);
    if (!modelMatches) continue;
    if (!params.part || c.partNumber.toUpperCase() === params.part.partNumber.toUpperCase()) {
      return c;
    }
  }
  return undefined;
}

let repairGuidesCache: Array<{ id: string; data: unknown }> | null = null;

export async function loadRepairGuideRows(): Promise<Array<{ id: string; data: unknown }>> {
  if (!repairGuidesCache) {
    repairGuidesCache = await prisma.catalogRepairGuide.findMany({
      select: { id: true, data: true },
    });
  }
  return repairGuidesCache;
}

export async function samplePartsByApplianceFamily(family: string, limit: number): Promise<PartRow[]> {
  const rows = await prisma.catalogPart.findMany({
    where: { applianceFamily: family },
    orderBy: { partNumber: "asc" },
    take: limit,
  });
  return rows.map(jsonPart);
}

export function invalidateRepairGuideCache(): void {
  repairGuidesCache = null;
}

/** Parameterized FULLTEXT — safe binding for MATCH AGAINST BOOLEAN MODE. */
export async function fulltextSearchParts(lower: string, limit: number): Promise<PartRow[]> {
  const q = booleanModeQueryFromText(lower);
  if (!q) return [];

  const rows = await prisma.$queryRaw<Array<{ data: unknown }>>`
    SELECT data
    FROM CatalogPart
    WHERE MATCH(searchDocument) AGAINST (${q} IN BOOLEAN MODE)
    ORDER BY MATCH(searchDocument) AGAINST (${q} IN BOOLEAN MODE) DESC
    LIMIT ${limit}
  `;

  return rows.map((r) => r.data as PartRow);
}
