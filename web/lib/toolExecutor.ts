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

export function executePartselectTool(
  name: string,
  argsJson: string
): ToolExecutionResult {
  let args: unknown;
  try {
    args = argsJson ? JSON.parse(argsJson) : {};
  } catch {
    return {
      name: name as ToolName,
      ok: false,
      output: { error: "invalid_tool_arguments_json" },
    };
  }

  switch (name) {
    case NORMALIZE_PART_NUMBER_TOOL_NAME: {
      const text =
        typeof (args as { text?: unknown }).text === "string"
          ? (args as { text: string }).text
          : "";
      const output = normalizePartNumberTool({ text });
      return {
        name: NORMALIZE_PART_NUMBER_TOOL_NAME,
        ok: true,
        output,
      };
    }
    case CATALOG_SEARCH_TOOL_NAME: {
      const query =
        typeof (args as { query?: unknown }).query === "string"
          ? (args as { query: string }).query
          : "";
      const output = retrieveExact(query.trim());
      return {
        name: CATALOG_SEARCH_TOOL_NAME,
        ok: true,
        output,
      };
    }
    default:
      return {
        name: name as ToolName,
        ok: false,
        output: { error: "unknown_tool", name },
      };
  }
}
