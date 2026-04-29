import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import type { RetrievalResult } from "../retrieveExact";
import { appendRetrievalContextMessage } from "./retrievalDigest";

/** Tool loop ended with an assistant message that already contains prose (rare). */
export function assistantProseAfterToolLoop(messages: ChatCompletionMessageParam[]): string | undefined {
  const last = messages[messages.length - 1];
  if (last?.role === "assistant" && typeof last.content === "string") {
    const t = last.content.trim();
    return t.length > 0 ? t : undefined;
  }
  return undefined;
}

export type FinalAssistantParams = {
  openai: OpenAI;
  model: string;
  /** Conversation after tool loop; may be mutated when non-stream completes (assistant appended). */
  messages: ChatCompletionMessageParam[];
  lastRetrieval: RetrievalResult;
  stream: boolean;
  onToken?: (text: string) => void;
};

/**
 * If the tool loop did not emit assistant text, run one more completion with canonical
 * retrieval injected as a user message so prose aligns with UI blocks.
 */
export async function generateFinalAssistantTurn(params: FinalAssistantParams): Promise<string> {
  const existing = assistantProseAfterToolLoop(params.messages);
  if (existing) {
    if (params.stream && params.onToken) params.onToken(existing);
    return existing;
  }

  const messagesForFinal = appendRetrievalContextMessage(params.messages, params.lastRetrieval);

  if (!params.stream) {
    const completion = await params.openai.chat.completions.create({
      model: params.model,
      messages: messagesForFinal,
    });
    const m = completion.choices[0]?.message;
    const text = typeof m?.content === "string" ? m.content.trim() : "";
    if (m) params.messages.push(m);
    return text;
  }

  let acc = "";
  const stream = await params.openai.chat.completions.create({
    model: params.model,
    messages: messagesForFinal,
    stream: true,
    stream_options: { include_usage: true },
  });
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content ?? "";
    if (delta) {
      acc += delta;
      params.onToken?.(delta);
    }
  }
  return acc;
}
