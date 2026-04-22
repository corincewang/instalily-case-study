import {
  CATALOG_SEARCH_TOOL_NAME,
  CHECK_COMPATIBILITY_TOOL_NAME,
  GET_INSTALL_GUIDE_TOOL_NAME,
  LOOKUP_PART_TOOL_NAME,
  NORMALIZE_PART_NUMBER_TOOL_NAME,
  SEARCH_BY_SYMPTOM_TOOL_NAME,
  type ToolName,
  type ToolTraceEntry,
} from "./agentTools";
import type { SessionContext } from "./retrieveExact";
import { retrieveExact } from "./retrieveExact";
import { checkCompatibilityTool } from "./tools/checkCompatibility";
import { getInstallGuideTool } from "./tools/getInstallGuide";
import { lookupPartTool } from "./tools/lookupPart";
import { normalizePartNumberTool } from "./tools/normalizePartNumber";
import { searchBySymptomTool } from "./tools/searchBySymptom";

/** @deprecated Use ToolTraceEntry from agentTools instead. */
export type ToolExecutionResult = ToolTraceEntry;

/** 3-P1: limits so a runaway LLM call can't dump arbitrary-length payloads into tools. */
const MAX_TEXT_LEN = 8000;
const MAX_QUERY_LEN = 2000;

function fail(name: ToolName, error: string, extra?: Record<string, unknown>): ToolTraceEntry {
  return { name, ok: false, output: { error, ...extra } };
}

export function executePartselectTool(
  name: string,
  argsJson: string,
  context?: SessionContext
): ToolTraceEntry {
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
        output: retrieveExact(query, context),
      };
    }
    case LOOKUP_PART_TOOL_NAME: {
      const raw = (args as { part_number?: unknown }).part_number;
      if (typeof raw !== "string" || !raw.trim()) {
        return fail(LOOKUP_PART_TOOL_NAME, "part_number_required");
      }
      return { name: LOOKUP_PART_TOOL_NAME, ok: true, output: lookupPartTool({ part_number: raw }) };
    }
    case CHECK_COMPATIBILITY_TOOL_NAME: {
      const a = args as { part_number?: unknown; model?: unknown };
      if (typeof a.part_number !== "string" || !a.part_number.trim()) {
        return fail(CHECK_COMPATIBILITY_TOOL_NAME, "part_number_required");
      }
      if (typeof a.model !== "string" || !a.model.trim()) {
        return fail(CHECK_COMPATIBILITY_TOOL_NAME, "model_required");
      }
      return {
        name: CHECK_COMPATIBILITY_TOOL_NAME,
        ok: true,
        output: checkCompatibilityTool({ part_number: a.part_number, model: a.model }),
      };
    }
    case GET_INSTALL_GUIDE_TOOL_NAME: {
      const raw = (args as { part_number?: unknown }).part_number;
      if (typeof raw !== "string" || !raw.trim()) {
        return fail(GET_INSTALL_GUIDE_TOOL_NAME, "part_number_required");
      }
      return { name: GET_INSTALL_GUIDE_TOOL_NAME, ok: true, output: getInstallGuideTool({ part_number: raw }) };
    }
    case SEARCH_BY_SYMPTOM_TOOL_NAME: {
      const raw = (args as { symptom?: unknown }).symptom;
      if (typeof raw !== "string" || !raw.trim()) {
        return fail(SEARCH_BY_SYMPTOM_TOOL_NAME, "symptom_required");
      }
      if (raw.length > MAX_QUERY_LEN) {
        return fail(SEARCH_BY_SYMPTOM_TOOL_NAME, "symptom_too_long", { limit: MAX_QUERY_LEN });
      }
      return { name: SEARCH_BY_SYMPTOM_TOOL_NAME, ok: true, output: searchBySymptomTool({ symptom: raw }) };
    }
    default:
      return fail(name as ToolName, "unknown_tool", { name });
  }
}
