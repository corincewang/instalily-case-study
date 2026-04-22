"use client";

import { useEffect, useRef, useState } from "react";

type Citation = { id: string; source: string; label: string };
type ToolTraceEntry = { name: string; ok: boolean; output?: unknown };

type ProductBlock = {
  type: "product";
  id: string;
  partNumber: string;
  title: string;
  applianceFamily: string;
  price?: number;
  currency?: string;
  inStock?: boolean;
  shipEta?: string;
  rating?: number;
  reviewCount?: number;
  manufacturer?: string;
  manufacturerPartNumber?: string;
  replaces?: string[];
};

type CandidateEntry = {
  id: string;
  partNumber: string;
  title: string;
  applianceFamily: string;
  reason?: string;
  price?: number;
  currency?: string;
  inStock?: boolean;
};

type InstallExperience = {
  difficulty?: string;
  timeLabel?: string;
  tools: string[];
  sampleCount: number;
};

type CustomerStory = {
  id: string;
  title: string;
  body: string;
  author?: string;
  location?: string;
  helpfulYes?: number;
  helpfulTotal?: number;
};

type SupportBlock = {
  type: "support";
  kind: "install" | "compat" | "repair" | "candidates";
  id: string;
  title: string;
  subtitle?: string;
  verdict?: { label: string; tone: "ok" | "warn" };
  note?: string;
  steps?: string[];
  candidates?: CandidateEntry[];
  experience?: InstallExperience;
  stories?: CustomerStory[];
};

type ChatBlock = ProductBlock | SupportBlock;

type SuggestedAction = { id: string; label: string; prompt: string };

type ChatApiResponse = {
  reply: string;
  blocks: ChatBlock[];
  citations: Citation[];
  suggested_actions: SuggestedAction[];
  normalized_part_numbers?: string[];
  tool_trace?: ToolTraceEntry[];
  used_llm?: boolean;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  blocks?: ChatBlock[];
  suggested_actions?: SuggestedAction[];
};

function formatPrice(p?: number, currency?: string): string | null {
  if (typeof p !== "number") return null;
  if (currency === "USD" || !currency) return `$${p.toFixed(2)}`;
  return `${p.toFixed(2)} ${currency}`;
}

function BlockCard({ block }: { block: ChatBlock }) {
  if (block.type === "product") {
    const priceText = formatPrice(block.price, block.currency);
    const stockText =
      typeof block.inStock === "boolean"
        ? block.inStock
          ? "In Stock"
          : "Out of stock"
        : null;
    const hasCommerce = priceText || stockText || block.shipEta;
    const hasRating =
      typeof block.rating === "number" && typeof block.reviewCount === "number";

    return (
      <div
        className="mt-3 rounded-xl p-4 text-left text-xs text-white shadow-sm ring-1 ring-black/10"
        style={{ backgroundColor: "#337788" }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/70">
              Part
            </p>
            <p className="mt-1 truncate text-sm font-semibold leading-tight text-white">
              {block.title}
            </p>
            <p className="mt-1 font-mono text-[11px] text-white/80">
              {block.partNumber} · {block.applianceFamily}
            </p>
            {(block.manufacturer || block.manufacturerPartNumber) && (
              <p className="mt-0.5 text-[11px] text-white/75">
                {block.manufacturer}
                {block.manufacturer && block.manufacturerPartNumber ? " · " : ""}
                {block.manufacturerPartNumber && (
                  <>
                    OEM{" "}
                    <span className="font-mono text-white/90">
                      {block.manufacturerPartNumber}
                    </span>
                  </>
                )}
              </p>
            )}
          </div>
          {priceText && (
            <span className="shrink-0 rounded-lg bg-white/95 px-2.5 py-1 text-sm font-bold text-[#1f4b57] shadow-sm">
              {priceText}
            </span>
          )}
        </div>

        {(stockText || block.shipEta || hasRating) && (
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            {stockText && (
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  block.inStock
                    ? "bg-emerald-400/20 text-emerald-100 ring-1 ring-emerald-300/40"
                    : "bg-white/15 text-white/80 ring-1 ring-white/20"
                }`}
              >
                {stockText}
              </span>
            )}
            {block.shipEta && (
              <span className="text-[11px] text-white/70">{block.shipEta}</span>
            )}
            {hasRating && (
              <span className="text-[11px] text-white/85">
                <span className="text-amber-300">★</span>{" "}
                <span className="font-semibold text-white">
                  {block.rating!.toFixed(1)}
                </span>{" "}
                <span className="text-white/70">· {block.reviewCount} reviews</span>
              </span>
            )}
          </div>
        )}

        {block.replaces && block.replaces.length > 0 && (
          <p className="mt-3 border-t border-white/20 pt-2.5 text-[11px] leading-relaxed text-white/80">
            <span className="font-semibold text-white/90">Replaces:</span>{" "}
            <span className="font-mono">{block.replaces.join(", ")}</span>
          </p>
        )}
      </div>
    );
  }

  const kindLabel =
    block.kind === "install"
      ? "Install guide"
      : block.kind === "compat"
        ? "Compatibility"
        : block.kind === "candidates"
          ? "Candidate parts"
          : "Repair guide";
  const kindAccent =
    block.kind === "install"
      ? "text-teal-700"
      : block.kind === "compat"
        ? "text-indigo-700"
        : block.kind === "candidates"
          ? "text-rose-700"
          : "text-amber-700";

  return (
    <div className="mt-3 rounded-xl border border-zinc-200 bg-white p-4 text-left text-xs text-zinc-800 shadow-sm">
      <p
        className={`text-[10px] font-semibold uppercase tracking-[0.12em] ${kindAccent}`}
      >
        {kindLabel}
      </p>
      <p className="mt-1 text-sm font-semibold leading-tight text-zinc-900">
        {block.title}
      </p>
      {block.subtitle && (
        <p className="mt-0.5 font-mono text-[11px] text-zinc-500">{block.subtitle}</p>
      )}
      {block.verdict && (
        <p
          className={`mt-2 inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${
            block.verdict.tone === "ok"
              ? "bg-emerald-100 text-emerald-800"
              : "bg-amber-100 text-amber-900"
          }`}
        >
          {block.verdict.label}
        </p>
      )}
      {block.note && (
        <p className="mt-2 text-[11px] leading-relaxed text-zinc-700">{block.note}</p>
      )}
      {block.experience && (
        <div className="mt-3 border-t border-zinc-200 pt-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500">
            Most customers report
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {block.experience.difficulty && (
              <span className="inline-flex items-center rounded-full bg-teal-50 px-2 py-0.5 text-[10px] font-medium text-teal-800">
                {block.experience.difficulty}
              </span>
            )}
            {block.experience.timeLabel && (
              <span className="inline-flex items-center rounded-full bg-teal-50 px-2 py-0.5 text-[10px] font-medium text-teal-800">
                {block.experience.timeLabel}
              </span>
            )}
            <span className="inline-flex items-center rounded-full bg-teal-50 px-2 py-0.5 text-[10px] font-medium text-teal-800">
              {block.experience.tools.length === 0
                ? "No tools required"
                : block.experience.tools.join(" · ")}
            </span>
            <span className="text-[10px] text-zinc-500">
              · from {block.experience.sampleCount} customer{" "}
              {block.experience.sampleCount === 1 ? "story" : "stories"}
            </span>
          </div>
        </div>
      )}
      {block.steps && block.steps.length > 0 && (
        <ol className="mt-3 list-decimal space-y-1 border-t border-zinc-200 pt-2.5 pl-4 text-[11px] leading-relaxed text-zinc-700">
          {block.steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      )}
      {block.candidates && block.candidates.length > 0 && (
        <ul className="mt-3 space-y-2 border-t border-zinc-200 pt-2.5">
          {block.candidates.map((c, i) => {
            const price = formatPrice(c.price, c.currency);
            const stock =
              typeof c.inStock === "boolean"
                ? c.inStock
                  ? "In Stock"
                  : "Out of stock"
                : null;
            return (
              <li
                key={c.id}
                className="flex items-start justify-between gap-3 rounded-lg bg-zinc-50 px-2.5 py-2 text-[11px]"
              >
                <div className="min-w-0">
                  <p className="text-zinc-900">
                    <span className="mr-1 font-semibold text-zinc-500">#{i + 1}</span>
                    <span className="font-medium">{c.title}</span>
                  </p>
                  <p className="mt-0.5 font-mono text-[10px] text-zinc-500">
                    {c.partNumber} · {c.applianceFamily}
                  </p>
                  {c.reason && (
                    <p className="mt-0.5 text-[10px] italic text-zinc-500">
                      matches: “{c.reason}”
                    </p>
                  )}
                </div>
                <div className="shrink-0 text-right">
                  {price && (
                    <p className="text-xs font-semibold text-zinc-900">{price}</p>
                  )}
                  {stock && (
                    <p
                      className={`mt-0.5 text-[10px] ${
                        c.inStock ? "text-emerald-700" : "text-zinc-500"
                      }`}
                    >
                      {stock}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {block.stories && block.stories.length > 0 && (
        <div className="mt-3 border-t border-zinc-200 pt-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500">
            From customers
          </p>
          <ul className="mt-1.5 space-y-2">
            {block.stories.map((s) => {
              const helpful =
                typeof s.helpfulYes === "number" &&
                typeof s.helpfulTotal === "number" &&
                s.helpfulTotal > 0
                  ? `${s.helpfulYes} of ${s.helpfulTotal} found this helpful`
                  : null;
              const byline =
                [s.author, s.location].filter(Boolean).join(", ") || "Customer";
              return (
                <li key={s.id} className="rounded-lg bg-zinc-50 px-2.5 py-2">
                  <p className="text-[11px] font-semibold text-zinc-900">{s.title}</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-zinc-700">{s.body}</p>
                  <p className="mt-1 text-[10px] text-zinc-500">
                    — {byline}
                    {helpful ? ` · ${helpful}` : ""}
                  </p>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

const QUICK_ACTIONS = [
  { label: "Find a part", text: "I want to find a part" },
  { label: "Check compatibility", text: "Is PS11752778 compatible with WRS325SDHZ?" },
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
      // Capture history before adding the new user message so we don't echo
      // it twice. We snapshot inside the closure using the functional updater's
      // previous value via a separate ref-like read.
      const currentMessages = messages; // closure over state at call time
      const history = currentMessages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .filter((m) => m.id !== "welcome") // skip the static greeting
        .map((m) => ({ role: m.role, content: m.content }));

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed, history }),
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
          blocks: Array.isArray(data.blocks) ? data.blocks : [],
          suggested_actions: Array.isArray(data.suggested_actions)
            ? data.suggested_actions
            : [],
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
                {msg.role === "assistant" && msg.blocks && msg.blocks.length > 0 && (
                  <div className="mt-1 space-y-1">
                    {msg.blocks.map((b) => (
                      <BlockCard key={`${b.type}-${b.id}`} block={b} />
                    ))}
                  </div>
                )}
                {msg.role === "assistant" &&
                  msg.suggested_actions &&
                  msg.suggested_actions.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2 border-t border-zinc-100 pt-3">
                      {msg.suggested_actions.map((a) => (
                        <button
                          key={a.id}
                          type="button"
                          className="rounded-full border border-zinc-200 bg-white px-3 py-1 text-[11px] font-medium text-zinc-700 shadow-sm hover:bg-zinc-50"
                          onClick={() => void sendText(a.prompt)}
                          disabled={loading}
                        >
                          {a.label}
                        </button>
                      ))}
                    </div>
                  )}
              </div>
            </div>
          ))}
          {loading && (
            <div className="flex justify-start">
              <div className="rounded-2xl rounded-bl-md border border-zinc-200 bg-white px-4 py-3 shadow-sm">
                <span className="flex items-center gap-1">
                  <span className="h-2 w-2 animate-bounce rounded-full bg-zinc-400 [animation-delay:-0.3s]" />
                  <span className="h-2 w-2 animate-bounce rounded-full bg-zinc-400 [animation-delay:-0.15s]" />
                  <span className="h-2 w-2 animate-bounce rounded-full bg-zinc-400" />
                </span>
              </div>
            </div>
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
