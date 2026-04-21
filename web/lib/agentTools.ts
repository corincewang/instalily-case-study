import { retrieveExact } from "./retrieveExact";
import { normalizePartNumberTool } from "./tools/normalizePartNumber";

export const NORMALIZE_PART_NUMBER_TOOL_NAME = "normalize_part_number" as const;
export const CATALOG_SEARCH_TOOL_NAME = "catalog_search" as const;

export type ToolName =
  | typeof NORMALIZE_PART_NUMBER_TOOL_NAME
  | typeof CATALOG_SEARCH_TOOL_NAME;

export type ToolTraceEntry = {
  name: ToolName;
  ok: boolean;
  output?: unknown;
};

/**
 * Deterministic tool chain before LLM.
 * Order: normalize part numbers → catalog retrieval (unchanged; still uses full message).
 */
export function runToolsForUserMessage(message: string): {
  normalization: ReturnType<typeof normalizePartNumberTool>;
  retrieval: ReturnType<typeof retrieveExact>;
  tool_trace: ToolTraceEntry[];
} {
  const trimmed = message.trim();

  const normalization = normalizePartNumberTool({ text: trimmed });
  const retrieval = retrieveExact(trimmed);

  const tool_trace: ToolTraceEntry[] = [
    {
      name: NORMALIZE_PART_NUMBER_TOOL_NAME,
      ok: true,
      output: normalization,
    },
    {
      name: CATALOG_SEARCH_TOOL_NAME,
      ok: true,
      output: retrieval,
    },
  ];

  return { normalization, retrieval, tool_trace };
}
