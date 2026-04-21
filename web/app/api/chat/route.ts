import { NextResponse } from "next/server";
import { retrieveExact } from "@/lib/retrieveExact";

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

  const { citations, part, compatibility, guide } = retrieveExact(message);

  let reply: string;
  if (!part && !compatibility && !guide) {
    reply =
      "No exact catalog match (part #, known model, or repair-guide keywords). " +
      `Next step: LLM + broader retrieval. Your message: ${message.slice(0, 200)}`;
  } else {
    const chunks: string[] = [];
    if (part) {
      chunks.push(
        `**${part.title} (${part.partNumber})**\n\nInstallation (from part catalog):\n${part.installSteps}`
      );
    }
    if (compatibility) {
      chunks.push(
        `**Compatibility** — model **${compatibility.model}** with **${compatibility.partNumber}**: ` +
          `${compatibility.compatible ? "Compatible (sample data)." : "Not compatible (sample data)."}\n` +
          compatibility.note
      );
    }
    if (guide) {
      chunks.push(
        `**${guide.brand} ${guide.appliance} — ${guide.topic}** (repair guide)\n\n` +
          guide.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")
      );
    }
    reply = chunks.join("\n\n---\n\n");
  }

  return NextResponse.json({
    reply,
    blocks: [] as const,
    citations,
    suggested_actions: [] as const,
  });
}
