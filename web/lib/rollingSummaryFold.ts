import { VERBATIM_MESSAGE_CAP } from "./conversationMemory";

export type FoldTurn = { role: "user" | "assistant"; content: string };

/**
 * Fold messages that have left the verbatim window into the rolling summary
 * (via `/api/summarize-conversation`). Idempotent when nothing new left the window.
 */
export async function foldRollingSummary(
  thread: FoldTurn[],
  previousSummary: string,
  foldCursor: number
): Promise<{ summary: string; foldCursor: number }> {
  const K = VERBATIM_MESSAGE_CAP;
  const keepStart = Math.max(0, thread.length - K);
  if (thread.length <= K) {
    return { summary: "", foldCursor: 0 };
  }

  const newChunk = thread.slice(foldCursor, keepStart);
  if (newChunk.length === 0) {
    return { summary: previousSummary, foldCursor: foldCursor };
  }

  try {
    const res = await fetch("/api/summarize-conversation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        previous_summary: previousSummary,
        turns: newChunk,
      }),
    });
    if (!res.ok) {
      return { summary: previousSummary, foldCursor };
    }
    const data = (await res.json()) as { summary?: string };
    const text = typeof data.summary === "string" ? data.summary.trim() : "";
    if (!text) {
      return { summary: previousSummary, foldCursor };
    }
    return { summary: text, foldCursor: keepStart };
  } catch {
    return { summary: previousSummary, foldCursor };
  }
}
