import {
  CATALOG_SEARCH_TOOL_NAME,
  NORMALIZE_PART_NUMBER_TOOL_NAME,
  type ToolName,
} from "./agentTools";
import { retrieveExact } from "./retrieveExact";
import { normalizePartNumberTool } from "./tools/normalizePartNumber";

export type ToolExecutionResult = {
  name: ToolName;
  ok: boolean;
  output?: unknown;
};

/** 3-P1: limits so a runaway LLM call can't dump arbitrary-length payloads into tools. */
const MAX_TEXT_LEN = 8000;
const MAX_QUERY_LEN = 2000;

function fail(name: ToolName, error: string, extra?: Record<string, unknown>): ToolExecutionResult {
  return { name, ok: false, output: { error, ...extra } };
}

export function executePartselectTool(
  name: string,
  argsJson: string
): ToolExecutionResult {
  let args: unknown;
  try {
    args = argsJson ? JSON.parse(argsJson) : {};
  } catch {
    return fail(name as ToolName, "invalid_tool_arguments_json");
  }
  if (!args || typeof args !== "object") {
    return fail(name as ToolName, "invalid_args_object");
  }

  switch (name) {
    case NORMALIZE_PART_NUMBER_TOOL_NAME: {
      const raw = (args as { text?: unknown }).text;
      if (typeof raw !== "string") {
        return fail(NORMALIZE_PART_NUMBER_TOOL_NAME, "text_must_be_string");
      }
      if (raw.length > MAX_TEXT_LEN) {
        return fail(NORMALIZE_PART_NUMBER_TOOL_NAME, "text_too_long", {
          limit: MAX_TEXT_LEN,
        });
      }
      return {
        name: NORMALIZE_PART_NUMBER_TOOL_NAME,
        ok: true,
        output: normalizePartNumberTool({ text: raw }),
      };
    }
    case CATALOG_SEARCH_TOOL_NAME: {
      const raw = (args as { query?: unknown }).query;
      if (typeof raw !== "string") {
        return fail(CATALOG_SEARCH_TOOL_NAME, "query_must_be_string");
      }
      const query = raw.trim();
      if (!query) {
        return fail(CATALOG_SEARCH_TOOL_NAME, "query_required");
      }
      if (query.length > MAX_QUERY_LEN) {
        return fail(CATALOG_SEARCH_TOOL_NAME, "query_too_long", {
          limit: MAX_QUERY_LEN,
        });
      }
      return {
        name: CATALOG_SEARCH_TOOL_NAME,
        ok: true,
        output: retrieveExact(query),
      };
    }
    default:
      return fail(name as ToolName, "unknown_tool", { name });
  }
}
