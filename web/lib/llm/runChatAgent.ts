import type { ToolTraceEntry } from "../agentTools";
import { createTrackedOpenAI, type LangfuseTraceOpts } from "../langfuse/createTrackedOpenAI";
import {
  CATALOG_SEARCH_TOOL_NAME,
  FETCH_PART_PAGE_TOOL_NAME,
  NORMALIZE_PART_NUMBER_TOOL_NAME,
  SEMANTIC_SEARCH_TOOL_NAME,
} from "../agentTools";
import { formatCatalogReplyFromRetrieval } from "../formatCatalogReply";
import { resolveCatalogContext, type CatalogContext } from "../loadCatalog";
import type { Citation, RetrievalResult, SessionContext } from "../retrieveExact";
import {
  allowSessionCarryForRetrieval,
  retrieveExact,
} from "../retrieveExact";
import { executePartselectTool } from "../toolExecutor";
import { fetchPartPageTool } from "../tools/fetchPartPage";
import { semanticSearchTool } from "../tools/semanticSearch";
import { generateFinalAssistantTurn } from "./finalAssistantReply";
import { PARTSELECT_OPENAI_TOOLS } from "./openaiTools";
import { applyRetrievalReplyGuards } from "./replyGuards";
import { buildRetrievalFromTrace } from "./retrievalFromTrace";
import { PARTSELECT_AGENT_SYSTEM } from "./systemPrompt";

/** Optional catalog + Langfuse metadata for one agent run. */
export type ChatAgentRunOptions = {
  catalogArg?: CatalogContext;
  langfuse?: LangfuseTraceOpts;
};

/** A single turn in the conversation, as sent from the client. */
export type HistoryTurn = {
  role: "user" | "assistant";
  content: string;
};

export type LlmChatResult = {
  reply: string;
  citations: Citation[];
  normalized_part_numbers: string[];
  tool_trace: ToolTraceEntry[];
  used_llm: true;
  /** Last catalog retrieval; API route builds blocks from this (not sent as a top-level field). */
  retrieval: RetrievalResult;
};

const MAX_TOOL_ROUNDS = 6;

/** Cap prior turns sent to the model — the route still scans full `history` for session anchors. */
const MAX_PRIOR_CHAT_MESSAGES = 40;

/**
 * Same gate as `retrieveExact`: only expose PS/model session to the LLM and
 * `catalog_search` when the current message continues a parts task.
 */
function gatedSessionContext(
  userMessage: string,
  context: SessionContext | undefined
): SessionContext | undefined {
  if (!context?.partNumber && !context?.model) return undefined;
  return allowSessionCarryForRetrieval(userMessage, userMessage.toLowerCase())
    ? context
    : undefined;
}

function buildSystemContent(context?: SessionContext, conversationSummary?: string): string {
  const contextLines: string[] = [];
  if (context?.partNumber) contextLines.push(`part ${context.partNumber}`);
  if (context?.model) contextLines.push(`model ${context.model}`);
  const sessionNote =
    contextLines.length > 0
      ? `\n\n[Session context — resolved from prior turns: ${contextLines.join(", ")}. Prefer these anchors when the user's *current* message continues the same parts task (install, price/stock, fit, or lookup). Do not call check_compatibility with them on vague follow-ups (e.g. "yes", "narrow it down") unless the user clearly means that specific part and model.]`
      : "";
  const sum = conversationSummary?.trim();
  const summaryNote =
    sum && sum.length > 0
      ? `\n\n[Earlier conversation — compressed summary. Verbatim recent turns follow as normal chat messages below. If a PS number or model in the summary disagrees with the recent turns, trust the recent turns.]\n\n${sum}`
      : "";
  return PARTSELECT_AGENT_SYSTEM + sessionNote + summaryNote;
}

async function runToolLoop(
  userMessage: string,
  history: HistoryTurn[],
  context: SessionContext | undefined,
  openai: import("openai").default,
  model: string,
  systemContent: string,
  catalogCtx: CatalogContext
): Promise<{
  messages: import("openai/resources/chat/completions").ChatCompletionMessageParam[];
  tool_trace: ToolTraceEntry[];
  normalized: Set<string>;
  lastRetrieval: RetrievalResult;
}> {
  const prior = history.slice(-MAX_PRIOR_CHAT_MESSAGES).map((t) => ({
    role: t.role,
    content: t.content,
  }));

  const messages: import("openai/resources/chat/completions").ChatCompletionMessageParam[] = [
    { role: "system", content: systemContent },
    ...prior,
    { role: "user", content: userMessage },
  ];

  const tool_trace: ToolTraceEntry[] = [];
  const normalized = new Set<string>();
  let lastRetrieval: RetrievalResult | null = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const completion = await openai.chat.completions.create({
      model,
      messages,
      tools: PARTSELECT_OPENAI_TOOLS,
      tool_choice: "auto",
    });

    const choice = completion.choices[0]?.message;
    if (!choice) break;

    const toolCalls = choice.tool_calls ?? [];
    messages.push(choice);
    if (toolCalls.length === 0) break;

    for (const tc of toolCalls) {
      if (tc.type !== "function") continue;
      const name = tc.function.name;
      const argsJson = tc.function.arguments ?? "{}";

      let exec: ToolTraceEntry;
      if (name === FETCH_PART_PAGE_TOOL_NAME) {
        try {
          const args = JSON.parse(argsJson) as { part_number?: string };
          const result = await fetchPartPageTool({ part_number: args.part_number ?? "" });
          exec = { name: FETCH_PART_PAGE_TOOL_NAME, ok: result.ok, output: result };
        } catch {
          exec = { name: FETCH_PART_PAGE_TOOL_NAME, ok: false, output: { error: "fetch_failed" } };
        }
      } else if (name === SEMANTIC_SEARCH_TOOL_NAME) {
        try {
          const args = JSON.parse(argsJson) as { query?: string };
          const result = await semanticSearchTool({ query: args.query ?? "" });
          exec = { name: SEMANTIC_SEARCH_TOOL_NAME, ok: result.ok, output: result };
        } catch {
          exec = {
            name: SEMANTIC_SEARCH_TOOL_NAME,
            ok: false,
            output: { error: "semantic_search_failed" },
          };
        }
      } else {
        exec = await executePartselectTool(name, argsJson, context, catalogCtx);
      }

      tool_trace.push({ name: exec.name, ok: exec.ok, output: exec.output });

      if (exec.ok && exec.name === NORMALIZE_PART_NUMBER_TOOL_NAME && exec.output) {
        const o = exec.output as { part_numbers: string[] };
        o.part_numbers.forEach((p) => normalized.add(p));
      }
      if (exec.ok && exec.name === CATALOG_SEARCH_TOOL_NAME && exec.output) {
        lastRetrieval = exec.output as RetrievalResult;
      }

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(exec.output ?? { error: "no_output" }),
      });
    }
  }

  if (!lastRetrieval) {
    lastRetrieval =
      (await buildRetrievalFromTrace(tool_trace, catalogCtx)) ??
      (await retrieveExact(userMessage, context, catalogCtx));
    tool_trace.push({ name: CATALOG_SEARCH_TOOL_NAME, ok: true, output: lastRetrieval });
  }

  return { messages, tool_trace, normalized, lastRetrieval };
}

type BootstrapArgs = {
  userMessage: string;
  history: HistoryTurn[];
  context?: SessionContext;
  conversationSummary?: string;
  catalogArg?: CatalogContext;
  langfuse?: LangfuseTraceOpts;
};

/** Shared OpenAI client, tool loop, and retrieval for both streaming and non-streaming entrypoints. */
async function bootstrapAgentTurn(args: BootstrapArgs) {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const catalogCtx = args.catalogArg ?? (await resolveCatalogContext());
  const model = (process.env.OPENAI_MODEL ?? "gpt-4o-mini").trim();
  const openai = createTrackedOpenAI(apiKey, {
    traceName: "partselect-chat-agent",
    ...args.langfuse,
  });
  const gated = gatedSessionContext(args.userMessage, args.context);
  const systemContent = buildSystemContent(gated, args.conversationSummary);

  const { messages, tool_trace, normalized, lastRetrieval } = await runToolLoop(
    args.userMessage,
    args.history,
    gated,
    openai,
    model,
    systemContent,
    catalogCtx
  );

  return {
    openai,
    model,
    catalogCtx,
    gated,
    messages,
    tool_trace,
    normalized,
    lastRetrieval,
  };
}

export async function runChatWithLlmTools(
  userMessage: string,
  history: HistoryTurn[] = [],
  context?: SessionContext,
  conversationSummary?: string,
  options?: ChatAgentRunOptions
): Promise<LlmChatResult> {
  const { openai, model, catalogCtx, messages, tool_trace, normalized, lastRetrieval } =
    await bootstrapAgentTurn({
      userMessage,
      history,
      context,
      conversationSummary,
      catalogArg: options?.catalogArg,
      langfuse: options?.langfuse,
    });

  let replyText = await generateFinalAssistantTurn({
    openai,
    model,
    messages,
    lastRetrieval,
    stream: false,
  });

  if (!replyText) replyText = formatCatalogReplyFromRetrieval(lastRetrieval, userMessage);
  replyText = await applyRetrievalReplyGuards(replyText, lastRetrieval, userMessage, context, catalogCtx);

  return {
    reply: replyText,
    citations: lastRetrieval.citations,
    normalized_part_numbers: Array.from(normalized),
    tool_trace,
    used_llm: true,
    retrieval: lastRetrieval,
  };
}

/**
 * Streaming variant: runs the tool loop (blocking), then streams the final
 * LLM reply token-by-token via `onToken`.
 */
export async function streamChatWithLlmTools(
  userMessage: string,
  history: HistoryTurn[],
  context: SessionContext | undefined,
  onToken: (text: string) => void,
  conversationSummary?: string,
  options?: ChatAgentRunOptions
): Promise<LlmChatResult> {
  const { openai, model, catalogCtx, messages, tool_trace, normalized, lastRetrieval } =
    await bootstrapAgentTurn({
      userMessage,
      history,
      context,
      conversationSummary,
      catalogArg: options?.catalogArg,
      langfuse: options?.langfuse,
    });

  let replyText = await generateFinalAssistantTurn({
    openai,
    model,
    messages,
    lastRetrieval,
    stream: true,
    onToken,
  });

  if (!replyText) replyText = formatCatalogReplyFromRetrieval(lastRetrieval, userMessage);
  replyText = await applyRetrievalReplyGuards(replyText, lastRetrieval, userMessage, context, catalogCtx);

  return {
    reply: replyText,
    citations: lastRetrieval.citations,
    normalized_part_numbers: Array.from(normalized),
    tool_trace,
    used_llm: true,
    retrieval: lastRetrieval,
  };
}
