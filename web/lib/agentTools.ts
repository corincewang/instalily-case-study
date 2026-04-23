export const NORMALIZE_PART_NUMBER_TOOL_NAME = "normalize_part_number" as const;
export const CATALOG_SEARCH_TOOL_NAME = "catalog_search" as const;
export const LOOKUP_PART_TOOL_NAME = "lookup_part" as const;
export const CHECK_COMPATIBILITY_TOOL_NAME = "check_compatibility" as const;
export const GET_INSTALL_GUIDE_TOOL_NAME = "get_install_guide" as const;
export const SEARCH_BY_SYMPTOM_TOOL_NAME = "search_by_symptom" as const;
export const FETCH_PART_PAGE_TOOL_NAME = "fetch_part_page" as const;
export const SEMANTIC_SEARCH_TOOL_NAME = "semantic_search" as const;

export type ToolName =
  | typeof NORMALIZE_PART_NUMBER_TOOL_NAME
  | typeof CATALOG_SEARCH_TOOL_NAME
  | typeof LOOKUP_PART_TOOL_NAME
  | typeof CHECK_COMPATIBILITY_TOOL_NAME
  | typeof GET_INSTALL_GUIDE_TOOL_NAME
  | typeof SEARCH_BY_SYMPTOM_TOOL_NAME
  | typeof FETCH_PART_PAGE_TOOL_NAME
  | typeof SEMANTIC_SEARCH_TOOL_NAME;

export type ToolTraceEntry = {
  name: ToolName;
  ok: boolean;
  output?: unknown;
};
