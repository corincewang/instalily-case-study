import type { SessionContext } from "./retrieveExact";
import { retrieveExact } from "./retrieveExact";
import { checkCompatibilityTool } from "./tools/checkCompatibility";
import { getInstallGuideTool } from "./tools/getInstallGuide";
import { lookupPartTool } from "./tools/lookupPart";
import { normalizePartNumberTool } from "./tools/normalizePartNumber";
import { searchBySymptomTool } from "./tools/searchBySymptom";

export const NORMALIZE_PART_NUMBER_TOOL_NAME = "normalize_part_number" as const;
export const CATALOG_SEARCH_TOOL_NAME = "catalog_search" as const;
export const LOOKUP_PART_TOOL_NAME = "lookup_part" as const;
export const CHECK_COMPATIBILITY_TOOL_NAME = "check_compatibility" as const;
export const GET_INSTALL_GUIDE_TOOL_NAME = "get_install_guide" as const;
export const SEARCH_BY_SYMPTOM_TOOL_NAME = "search_by_symptom" as const;
export const FETCH_PART_PAGE_TOOL_NAME = "fetch_part_page" as const;

export type ToolName =
  | typeof NORMALIZE_PART_NUMBER_TOOL_NAME
  | typeof CATALOG_SEARCH_TOOL_NAME
  | typeof LOOKUP_PART_TOOL_NAME
  | typeof CHECK_COMPATIBILITY_TOOL_NAME
  | typeof GET_INSTALL_GUIDE_TOOL_NAME
  | typeof SEARCH_BY_SYMPTOM_TOOL_NAME
  | typeof FETCH_PART_PAGE_TOOL_NAME;

export type ToolTraceEntry = {
  name: ToolName;
  ok: boolean;
  output?: unknown;
};

/** Detect a model token (e.g. WRS325SDHZ) — excludes PS##### part numbers. */
const MODEL_TOKEN_RE = /\b([A-Z]{2,}\d{3,}[A-Z0-9]{2,})\b/gi;
function extractModelToken(text: string): string | undefined {
  const upper = text.toUpperCase();
  for (const m of upper.matchAll(MODEL_TOKEN_RE)) {
    if (!m[1].startsWith("PS")) return m[1];
  }
  return undefined;
}

const INSTALL_RE = /\b(install|replace|swap|fit|remove|how to)\b/i;
const SYMPTOM_RE =
  /\b(not working|broken|leaking|noisy|won't|doesn't|stops?|fails?|fix|problem|issue|repair|troubleshoot)\b/i;

/**
 * Deterministic tool chain (no LLM).
 *
 * Mirrors what the LLM would decide: pick the most specific tool first based
 * on heuristics, then always finish with catalog_search so buildBlocksFromRetrieval
 * has a retrieveExact-compatible result.
 */
export function runToolsForUserMessage(
  message: string,
  context?: SessionContext
): {
  normalization: ReturnType<typeof normalizePartNumberTool>;
  retrieval: ReturnType<typeof retrieveExact>;
  tool_trace: ToolTraceEntry[];
} {
  const trimmed = message.trim();
  const tool_trace: ToolTraceEntry[] = [];

  // Step 1: normalize to extract PS numbers.
  const normalization = normalizePartNumberTool({ text: trimmed });
  tool_trace.push({ name: NORMALIZE_PART_NUMBER_TOOL_NAME, ok: true, output: normalization });

  // Step 2: pick the most specific tool.
  const firstPS = normalization.part_numbers[0] ?? context?.partNumber;
  const model = extractModelToken(trimmed) ?? context?.model;

  if (firstPS && model) {
    // Both part + model present → compatibility check.
    const result = checkCompatibilityTool({ part_number: firstPS, model });
    tool_trace.push({ name: CHECK_COMPATIBILITY_TOOL_NAME, ok: result.ok, output: result });
  } else if (firstPS && INSTALL_RE.test(trimmed)) {
    // Part + install intent → install guide.
    const result = getInstallGuideTool({ part_number: firstPS });
    tool_trace.push({ name: GET_INSTALL_GUIDE_TOOL_NAME, ok: result.ok, output: result });
  } else if (firstPS) {
    // Part number only → full part lookup.
    const result = lookupPartTool({ part_number: firstPS });
    tool_trace.push({ name: LOOKUP_PART_TOOL_NAME, ok: result.ok, output: result });
  } else if (SYMPTOM_RE.test(trimmed)) {
    // No part number, symptom words → reverse diagnosis.
    const result = searchBySymptomTool({ symptom: trimmed });
    tool_trace.push({ name: SEARCH_BY_SYMPTOM_TOOL_NAME, ok: result.ok, output: result });
  }

  // Step 3: catalog_search always runs — buildBlocksFromRetrieval needs this format.
  const retrieval = retrieveExact(trimmed, context);
  tool_trace.push({ name: CATALOG_SEARCH_TOOL_NAME, ok: true, output: retrieval });

  return { normalization, retrieval, tool_trace };
}
