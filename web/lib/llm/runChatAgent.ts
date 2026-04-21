import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import type { ToolTraceEntry } from "../agentTools";
import { CATALOG_SEARCH_TOOL_NAME, NORMALIZE_PART_NUMBER_TOOL_NAME } from "../agentTools";
import { formatCatalogReplyFromRetrieval } from "../formatCatalogReply";
import type { Citation } from "../retrieveExact";
import { retrieveExact } from "../retrieveExact";
import { executePartselectTool } from "../toolExecutor";
import { PARTSELECT_OPENAI_TOOLS } from "./openaiTools";
import { PARTSELECT_AGENT_SYSTEM } from "./systemPrompt";

export type LlmChatResult = {
  reply: string;
  citations: Citation[];
  normalized_part_numbers: string[];
  tool_trace: ToolTraceEntry[];
  used_llm: true;
  /** Last catalog retrieval; API route builds blocks from this (not sent as a top-level field). */
  retrieval: ReturnType<typeof retrieveExact>;
};

const MAX_TOOL_ROUNDS = 6;

export async function runChatWithLlmTools(
  userMessage: string
): Promise<LlmChatResult> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const model = (process.env.OPENAI_MODEL ?? "gpt-5.4-mini").trim();
  const openai = new OpenAI({ apiKey });

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: PARTSELECT_AGENT_SYSTEM },
    { role: "user", content: userMessage },
  ];

  const tool_trace: ToolTraceEntry[] = [];
  const normalized = new Set<string>();
  let lastRetrieval: ReturnType<typeof retrieveExact> | null = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const completion = await openai.chat.completions.create({
      model,
      messages,
      tools: PARTSELECT_OPENAI_TOOLS,
      tool_choice: "auto",
    });

    const choice = completion.choices[0]?.message;
    if (!choice) {
      break;
    }

    const toolCalls = choice.tool_calls ?? [];
    messages.push(choice);

    if (toolCalls.length === 0) {
      break;
    }

    for (const tc of toolCalls) {
      if (tc.type !== "function") continue;
      const name = tc.function.name;
      const argsJson = tc.function.arguments ?? "{}";
      const exec = executePartselectTool(name, argsJson);
      tool_trace.push({
        name: exec.name,
        ok: exec.ok,
        output: exec.output,
      });

      if (exec.ok && exec.name === NORMALIZE_PART_NUMBER_TOOL_NAME && exec.output) {
        const o = exec.output as { part_numbers: string[] };
        o.part_numbers.forEach((p) => normalized.add(p));
      }
      if (exec.ok && exec.name === CATALOG_SEARCH_TOOL_NAME && exec.output) {
        lastRetrieval = exec.output as ReturnType<typeof retrieveExact>;
      }

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(exec.output ?? { error: "no_output" }),
      });
    }
  }

  if (!lastRetrieval) {
    const forced = retrieveExact(userMessage);
    lastRetrieval = forced;
    tool_trace.push({
      name: CATALOG_SEARCH_TOOL_NAME,
      ok: true,
      output: forced,
    });
  }

  const lastMsg = messages[messages.length - 1]!;
  let replyText = "";
  if (lastMsg.role === "assistant" && typeof lastMsg.content === "string") {
    replyText = lastMsg.content.trim();
  }

  if (!replyText) {
    const finalCompletion = await openai.chat.completions.create({
      model,
      messages,
    });
    const m = finalCompletion.choices[0]?.message;
    if (m) {
      messages.push(m);
    }
    replyText = typeof m?.content === "string" ? m.content.trim() : "";
  }

  if (!replyText) {
    replyText = formatCatalogReplyFromRetrieval(lastRetrieval, userMessage);
  }

  return {
    reply: replyText,
    citations: lastRetrieval.citations,
    normalized_part_numbers: Array.from(normalized),
    tool_trace,
    used_llm: true,
    retrieval: lastRetrieval,
  };
}
