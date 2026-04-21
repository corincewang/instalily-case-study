import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { CATALOG_SEARCH_TOOL_NAME, NORMALIZE_PART_NUMBER_TOOL_NAME } from "../agentTools";

export const PARTSELECT_OPENAI_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: NORMALIZE_PART_NUMBER_TOOL_NAME,
      description:
        "Extract PartSelect-style PS##### part numbers from arbitrary user text. Returns uppercase unique IDs.",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "Raw user text to scan for PS numbers.",
          },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: CATALOG_SEARCH_TOOL_NAME,
      description:
        "Search the case-study static catalog for parts, model compatibility rows, and short repair guides.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Search query: include model numbers, PS numbers, symptoms, and brand when relevant.",
          },
        },
        required: ["query"],
      },
    },
  },
];
