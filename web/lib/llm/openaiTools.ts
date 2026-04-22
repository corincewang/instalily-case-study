import type { ChatCompletionTool } from "openai/resources/chat/completions";

import {
  CATALOG_SEARCH_TOOL_NAME,
  CHECK_COMPATIBILITY_TOOL_NAME,
  GET_INSTALL_GUIDE_TOOL_NAME,
  LOOKUP_PART_TOOL_NAME,
  NORMALIZE_PART_NUMBER_TOOL_NAME,
  SEARCH_BY_SYMPTOM_TOOL_NAME,
} from "../agentTools";

export const PARTSELECT_OPENAI_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: NORMALIZE_PART_NUMBER_TOOL_NAME,
      description:
        "Extract PartSelect-style PS##### part numbers from arbitrary user text. Call this first whenever the user's message might contain a PS number.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Raw user text to scan for PS numbers." },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: LOOKUP_PART_TOOL_NAME,
      description:
        "Fetch full details for a single part by its PS number: title, price, stock, appliance family, OEM number, install steps, and customer stories. Use when the user asks about a specific part by PS number.",
      parameters: {
        type: "object",
        properties: {
          part_number: {
            type: "string",
            description: "Uppercase PS number, e.g. PS11752778.",
          },
        },
        required: ["part_number"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: CHECK_COMPATIBILITY_TOOL_NAME,
      description:
        "Check whether a specific part is compatible with a specific appliance model. BOTH part_number AND model are required — ask the user if either is missing before calling.",
      parameters: {
        type: "object",
        properties: {
          part_number: {
            type: "string",
            description: "Uppercase PS number, e.g. PS11752778.",
          },
          model: {
            type: "string",
            description: "Appliance model number exactly as the user provided, e.g. WRS325SDHZ.",
          },
        },
        required: ["part_number", "model"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: GET_INSTALL_GUIDE_TOOL_NAME,
      description:
        "Return step-by-step installation instructions for a part, enriched with aggregated customer experience signals (difficulty, time estimate, tools needed). Use when the user asks how to install a specific part.",
      parameters: {
        type: "object",
        properties: {
          part_number: {
            type: "string",
            description: "Uppercase PS number, e.g. PS11752778.",
          },
        },
        required: ["part_number"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: SEARCH_BY_SYMPTOM_TOOL_NAME,
      description:
        "Reverse-diagnose which parts are most likely responsible for a described symptom. Returns up to 3 ranked candidates. Use when the user describes a problem (e.g. 'ice maker not working', 'door won't close') without naming a specific part.",
      parameters: {
        type: "object",
        properties: {
          symptom: {
            type: "string",
            description:
              "User-described symptom or problem, e.g. 'ice maker not working and no ice'.",
          },
        },
        required: ["symptom"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: CATALOG_SEARCH_TOOL_NAME,
      description:
        "Broad fallback search across the catalog. Use ONLY when none of the other specific tools apply — for example, a keyword or brand browse query that doesn't map to a single PS number, compat check, install guide, or symptom.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Search query preserving model numbers, PS numbers, symptoms, and brand when relevant.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_part_page",
      description:
        "Fetches live product data for any PS part number directly from PartSelect.com. " +
        "Use this ONLY when lookup_part returns an error (part not in local catalog). " +
        "Returns title, price, stock status, and a description with install hints. " +
        "May take up to 12 seconds — only call when local tools have failed.",
      parameters: {
        type: "object",
        properties: {
          part_number: {
            type: "string",
            description: "The PS part number to look up, e.g. PS3406971",
          },
        },
        required: ["part_number"],
      },
    },
  },
];
