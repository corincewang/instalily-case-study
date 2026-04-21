import { NextResponse } from "next/server";

import { runToolsForUserMessage } from "@/lib/agentTools";
import { formatCatalogReplyFromRetrieval } from "@/lib/formatCatalogReply";
import { runChatWithLlmTools } from "@/lib/llm/runChatAgent";

type ChatRequestBody = {
  message?: unknown;
  messages?: unknown;
};

export async function POST(request: Request) {
  let body: ChatRequestBody;
  try {
    body = (await request.json()) as ChatRequestBody;
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "Body must be JSON." },
      { status: 400 }
    );
  }

  const message =
    typeof body.message === "string" ? body.message.trim() : "";

  if (!message) {
    return NextResponse.json(
      {
        error: "invalid_body",
        message: "Field `message` (non-empty string) is required.",
      },
      { status: 400 }
    );
  }

  const useLlm = Boolean(process.env.OPENAI_API_KEY?.trim());

  if (useLlm) {
    try {
      const out = await runChatWithLlmTools(message);
      return NextResponse.json({
        reply: out.reply,
        blocks: [] as const,
        citations: out.citations,
        suggested_actions: [] as const,
        normalized_part_numbers: out.normalized_part_numbers,
        tool_trace: out.tool_trace,
        used_llm: true,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "LLM error";
      return NextResponse.json(
        { error: "llm_failed", message: msg },
        { status: 502 }
      );
    }
  }

  const { retrieval, tool_trace, normalization } =
    runToolsForUserMessage(message);
  const reply = formatCatalogReplyFromRetrieval(retrieval, message);

  return NextResponse.json({
    reply,
    blocks: [] as const,
    citations: retrieval.citations,
    suggested_actions: [] as const,
    normalized_part_numbers: normalization.part_numbers,
    tool_trace,
    used_llm: false,
  });
}
