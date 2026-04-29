import { NextResponse } from "next/server";

import { createTrackedOpenAI } from "@/lib/langfuse/createTrackedOpenAI";
import { flushLangfuseSpans } from "@/lib/langfuse/otel";

type Turn = { role?: unknown; content?: unknown };

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

/**
 * Merge `previous_summary` with newly dropped verbatim turns into one short summary.
 * Used by the chat UI for rolling memory (older turns → summary, recent K stay verbatim).
 */
export async function POST(request: Request) {
  let body: { previous_summary?: unknown; turns?: unknown };
  try {
    body = (await request.json()) as { previous_summary?: unknown; turns?: unknown };
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "Body must be JSON." },
      { status: 400 }
    );
  }

  const previous_summary =
    typeof body.previous_summary === "string" ? body.previous_summary.trim() : "";

  const rawTurns = Array.isArray(body.turns) ? body.turns : [];
  const turns: { role: string; content: string }[] = [];
  for (const t of rawTurns as Turn[]) {
    if (
      (t.role === "user" || t.role === "assistant") &&
      typeof t.content === "string" &&
      t.content.trim().length > 0
    ) {
      turns.push({ role: t.role, content: truncate(t.content.trim(), 4000) });
    }
  }

  if (turns.length === 0) {
    return NextResponse.json({ summary: previous_summary });
  }

  const transcript = turns
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
    .join("\n\n");

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    const fallback = [previous_summary, transcript].filter(Boolean).join("\n\n");
    return NextResponse.json({ summary: truncate(fallback, 8000) });
  }

  const model = (process.env.OPENAI_MODEL ?? "gpt-4o-mini").trim();
  const openai = createTrackedOpenAI(apiKey, {
    traceName: "partselect-conversation-summary",
    tags: ["partselect", "summarize"],
  });

  const system =
    "You compress refrigerator/dishwasher parts chat for session memory. " +
    "Output plain prose (no markdown headings). At most 10 short sentences. " +
    "Preserve every PartSelect part number (PS followed by digits) and appliance model numbers exactly as written. " +
    "Keep the user's stated goal (symptom, install, compatibility, price). " +
    "If previous_summary is non-empty, merge it with the new turns without duplicating facts.";

  const user =
    (previous_summary ? `Previous summary:\n${previous_summary}\n\n---\n\n` : "") +
    `New transcript to fold in:\n${transcript}`;

  try {
    const completion = await openai.chat.completions.create({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 400,
      temperature: 0.2,
    });
    const text = completion.choices[0]?.message?.content?.trim() ?? "";
    if (!text) {
      return NextResponse.json({ summary: truncate(fallbackFromTurns(previous_summary, turns), 8000) });
    }
    return NextResponse.json({ summary: truncate(text, 8000) });
  } catch {
    return NextResponse.json({ summary: truncate(fallbackFromTurns(previous_summary, turns), 8000) });
  } finally {
    await flushLangfuseSpans();
  }
}

function fallbackFromTurns(previous_summary: string, turns: { role: string; content: string }[]): string {
  const t = turns.map((x) => `${x.role}: ${x.content}`).join("\n");
  return [previous_summary, t].filter(Boolean).join("\n\n");
}
