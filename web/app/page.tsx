"use client";

import { useEffect, useRef, useState } from "react";

type Citation = { id: string; source: string; label: string };
type ToolTraceEntry = { name: string; ok: boolean; output?: unknown };

type ChatApiResponse = {
  reply: string;
  blocks: unknown[];
  citations: Citation[];
  suggested_actions: unknown[];
  normalized_part_numbers?: string[];
  tool_trace?: ToolTraceEntry[];
  used_llm?: boolean;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  meta?: Pick<
    ChatApiResponse,
    "used_llm" | "tool_trace" | "citations" | "normalized_part_numbers"
  >;
};

const QUICK_ACTIONS = [
  { label: "Find a part", text: "Find part PS11752778" },
  { label: "Check compatibility", text: "Is PS11752778 compatible with WDT780SAEM1?" },
  { label: "Installation help", text: "How do I install PS11752778?" },
  { label: "Troubleshoot", text: "Whirlpool refrigerator ice maker not working" },
] as const;

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      content:
        "Hi — I help with **refrigerator and dishwasher parts** (PartSelect-style demo). " +
        "Try a quick action below or type your own question.",
    },
  ]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  async function sendText(text: string) {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    setError(null);
    setLoading(true);
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: trimmed,
    };
    setMessages((m) => [...m, userMsg]);
    setDraft("");

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed }),
      });
      const data = (await res.json()) as ChatApiResponse & {
        error?: string;
        message?: string;
      };
      if (!res.ok) {
        setError(data.message ?? data.error ?? "Request failed");
        return;
      }
      setMessages((m) => [
        ...m,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: data.reply,
          meta: {
            used_llm: data.used_llm,
            tool_trace: data.tool_trace,
            citations: data.citations,
            normalized_part_numbers: data.normalized_part_numbers,
          },
        },
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col bg-zinc-50 text-zinc-900">
      <header className="border-b border-zinc-200 bg-white px-4 py-3 shadow-sm">
        <div className="mx-auto flex max-w-2xl flex-col gap-1">
          <h1 className="text-lg font-semibold tracking-tight">
            PartSelect parts assistant
          </h1>
          <p className="text-xs text-zinc-500">
            Demo · fridge & dishwasher parts ·{" "}
            <code className="rounded bg-zinc-100 px-1">POST /api/chat</code>
          </p>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-3 py-4">
        <div className="mb-3 flex flex-wrap gap-2">
          {QUICK_ACTIONS.map((a) => (
            <button
              key={a.label}
              type="button"
              className="rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 shadow-sm hover:bg-zinc-50"
              onClick={() => void sendText(a.text)}
              disabled={loading}
            >
              {a.label}
            </button>
          ))}
        </div>

        <div className="flex flex-1 flex-col gap-3 overflow-y-auto pb-4">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={
                  msg.role === "user"
                    ? "max-w-[85%] rounded-2xl rounded-br-md bg-zinc-900 px-4 py-2.5 text-sm text-white"
                    : "max-w-[90%] rounded-2xl rounded-bl-md border border-zinc-200 bg-white px-4 py-2.5 text-sm text-zinc-800 shadow-sm"
                }
              >
                <p className="whitespace-pre-wrap leading-relaxed">{msg.content}</p>
                {msg.role === "assistant" && msg.meta && (
                  <div className="mt-3 space-y-2 border-t border-zinc-100 pt-2 text-xs text-zinc-500">
                    {typeof msg.meta.used_llm === "boolean" && (
                      <p>
                        <span className="font-medium text-zinc-600">Mode:</span>{" "}
                        {msg.meta.used_llm ? "LLM + tools" : "Rules only"}
                      </p>
                    )}
                    {msg.meta.normalized_part_numbers &&
                      msg.meta.normalized_part_numbers.length > 0 && (
                        <p>
                          <span className="font-medium text-zinc-600">PS #:</span>{" "}
                          {msg.meta.normalized_part_numbers.join(", ")}
                        </p>
                      )}
                    {msg.meta.citations && msg.meta.citations.length > 0 && (
                      <details className="rounded bg-zinc-50 p-2">
                        <summary className="cursor-pointer font-medium text-zinc-600">
                          Sources ({msg.meta.citations.length})
                        </summary>
                        <ul className="mt-1 list-inside list-disc space-y-0.5">
                          {msg.meta.citations.map((c) => (
                            <li key={c.id}>
                              {c.label} · <code>{c.id}</code>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                    {msg.meta.tool_trace && msg.meta.tool_trace.length > 0 && (
                      <details className="rounded bg-zinc-50 p-2">
                        <summary className="cursor-pointer font-medium text-zinc-600">
                          Tool trace ({msg.meta.tool_trace.length})
                        </summary>
                        <ul className="mt-1 space-y-1 font-mono text-[11px] text-zinc-600">
                          {msg.meta.tool_trace.map((t, i) => (
                            <li key={`${t.name}-${i}`}>
                              {t.ok ? "✓" : "✗"} {t.name}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
          {loading && (
            <p className="text-center text-sm italic text-zinc-400">Thinking…</p>
          )}
          <div ref={bottomRef} />
        </div>

        {error && (
          <p className="mb-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
          </p>
        )}

        <form
          className="sticky bottom-0 border-t border-zinc-200 bg-zinc-50 pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            void sendText(draft);
          }}
        >
          <div className="flex gap-2">
            <input
              className="min-h-11 flex-1 rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm shadow-inner outline-none focus:border-zinc-400"
              placeholder="Ask about a part, model, or symptom…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={loading}
            />
            <button
              type="submit"
              className="rounded-xl bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              disabled={loading || !draft.trim()}
            >
              Send
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
