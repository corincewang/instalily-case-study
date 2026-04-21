"use client";

import { useState } from "react";

type ChatResponse = {
  reply: string;
  blocks: unknown[];
  citations: unknown[];
  suggested_actions: unknown[];
};

export default function Home() {
  const [message, setMessage] = useState("Find part PS11752778");
  const [reply, setReply] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function send() {
    setError(null);
    setReply(null);
    setLoading(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: message.trim() }),
      });
      const data = (await res.json()) as ChatResponse & {
        error?: string;
        message?: string;
      };
      if (!res.ok) {
        setError(data.message ?? data.error ?? "Request failed");
        return;
      }
      setReply(data.reply);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto flex max-w-lg flex-col gap-4 p-8">
      <h1 className="text-xl font-semibold">Chat API smoke test</h1>
      <p className="text-sm text-zinc-600">
        Calls <code className="rounded bg-zinc-100 px-1">POST /api/chat</code>{" "}
        (mock).
      </p>
      <label className="flex flex-col gap-1 text-sm">
        Message
        <input
          className="rounded border border-zinc-300 px-3 py-2 text-base"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
      </label>
      <button
        type="button"
        className="rounded bg-zinc-900 px-4 py-2 text-white disabled:opacity-50"
        onClick={() => void send()}
        disabled={loading || !message.trim()}
      >
        {loading ? "Sending…" : "Send"}
      </button>
      {error && (
        <p className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </p>
      )}
      {reply && (
        <p className="whitespace-pre-wrap rounded border border-zinc-200 bg-zinc-50 p-3 text-sm">
          {reply}
        </p>
      )}
    </main>
  );
}
