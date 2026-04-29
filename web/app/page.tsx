"use client";

import { useEffect, useRef, useState } from "react";

import { MAX_CONVERSATION_SUMMARY_CHARS, VERBATIM_MESSAGE_CAP } from "@/lib/conversationMemory";
import { partSelectProductPageUrl } from "@/lib/partselectUrls";
import { foldRollingSummary } from "@/lib/rollingSummaryFold";

// ─── API types ────────────────────────────────────────────────────────────────

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
  partNumber?: string;
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

/** Browser-local demo state (chat + cart + rolling summary). Bump `v` if the shape changes. */
const LS_DEMO_STATE_KEY = "partselect-demo-state-v2";

function isChatMessage(x: unknown): x is ChatMessage {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    (o.role === "user" || o.role === "assistant") &&
    typeof o.content === "string"
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatPrice(p?: number, currency?: string): string | null {
  if (typeof p !== "number") return null;
  return currency && currency !== "USD" ? `${p.toFixed(2)} ${currency}` : `$${p.toFixed(2)}`;
}

// ─── Skeleton card ─────────────────────────────────────────────────────────────

function SkeletonCard() {
  return (
    <div className="mt-3 animate-pulse rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
      <div className="h-2 w-20 rounded bg-zinc-200" />
      <div className="mt-2.5 h-4 w-2/3 rounded bg-zinc-200" />
      <div className="mt-1.5 h-3 w-1/2 rounded bg-zinc-200" />
      <div className="mt-3 space-y-1.5 border-t border-zinc-100 pt-3">
        <div className="h-3 rounded bg-zinc-100" />
        <div className="h-3 w-5/6 rounded bg-zinc-100" />
        <div className="h-3 w-4/6 rounded bg-zinc-100" />
      </div>
    </div>
  );
}

// ─── Part media hook ──────────────────────────────────────────────────────────

function usePartMedia(partNumber: string) {
  const [media, setMedia] = useState<{ imageUrl: string | null; videoId: string | null }>({
    imageUrl: null,
    videoId: null,
  });
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/part-image/${encodeURIComponent(partNumber)}`)
      .then((r) => r.json())
      .then((d: { imageUrl?: string | null; videoId?: string | null }) => {
        if (!cancelled) setMedia({ imageUrl: d.imageUrl ?? null, videoId: d.videoId ?? null });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [partNumber]);
  return media;
}

/** Cart row thumbnail — same `/api/part-image` source as product cards. */
function CartLineThumb({ partNumber, title }: { partNumber: string; title: string }) {
  const { imageUrl } = usePartMedia(partNumber);
  return (
    <div className="flex h-10 w-10 shrink-0 overflow-hidden rounded-lg border border-zinc-200 bg-white">
      {imageUrl ? (
        <img
          src={imageUrl}
          alt={title}
          className="h-full w-full object-contain p-0.5"
          loading="lazy"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-[#337788]/10">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="currentColor"
            className="h-5 w-5 animate-pulse text-[#337788]/40"
            aria-hidden
          >
            <path
              fillRule="evenodd"
              d="M12 6.75a5.25 5.25 0 0 1 6.775-5.025.75.75 0 0 1 .313 1.248l-3.32 3.319c.063.475.276.934.641 1.299.365.365.824.578 1.3.641l3.318-3.319a.75.75 0 0 1 1.248.313 5.25 5.25 0 0 1-5.472 6.756c-1.018-.086-1.87.1-2.309.634L7.344 21.3A3.298 3.298 0 1 1 2.7 16.657l8.684-7.151c.533-.44.72-1.291.634-2.309A5.342 5.342 0 0 1 12 6.75ZM4.117 19.125a.75.75 0 0 1 .75-.75h.008a.75.75 0 0 1 .75.75v.008a.75.75 0 0 1-.75.75h-.008a.75.75 0 0 1-.75-.75v-.008Z"
              clipRule="evenodd"
            />
          </svg>
        </div>
      )}
    </div>
  );
}

// ─── Product block card ───────────────────────────────────────────────────────

function ProductCard({ block, onAddToCart }: { block: ProductBlock; onAddToCart?: () => void }) {
  const { imageUrl } = usePartMedia(block.partNumber);
  const priceText = formatPrice(block.price, block.currency);
  const stockText =
    typeof block.inStock === "boolean" ? (block.inStock ? "In Stock" : "Out of stock") : null;
  const hasRating = typeof block.rating === "number" && typeof block.reviewCount === "number";

  return (
    <div
      className="mt-3 rounded-xl p-4 text-left text-xs text-white shadow-sm ring-1 ring-black/10"
      style={{ backgroundColor: "#337788" }}
    >
      <div className="flex items-start gap-3">
        {imageUrl && (
          <img
            src={imageUrl}
            alt={block.title}
            className="h-20 w-20 shrink-0 rounded-lg object-contain bg-white/10 p-1"
          />
        )}
        <div className="flex min-w-0 flex-1 items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/70">Part</p>
            <p className="mt-1 truncate text-sm font-semibold leading-tight text-white">{block.title}</p>
            <p className="mt-1 font-mono text-[11px] text-white/80">
              {block.partNumber} · {block.applianceFamily}
            </p>
            {(block.manufacturer || block.manufacturerPartNumber) && (
              <p className="mt-0.5 text-[11px] text-white/75">
                {block.manufacturer}
                {block.manufacturer && block.manufacturerPartNumber ? " · " : ""}
                {block.manufacturerPartNumber && (
                  <>OEM <span className="font-mono text-white/90">{block.manufacturerPartNumber}</span></>
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
      </div>
        {(stockText || block.shipEta || hasRating) && (
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            {stockText && (
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                block.inStock
                  ? "bg-emerald-400/20 text-emerald-100 ring-1 ring-emerald-300/40"
                  : "bg-white/15 text-white/80 ring-1 ring-white/20"
              }`}>{stockText}</span>
            )}
            {block.shipEta && <span className="text-[11px] text-white/70">{block.shipEta}</span>}
            {hasRating && (
              <span className="text-[11px] text-white/85">
                <span className="text-amber-300">★</span>{" "}
                <span className="font-semibold text-white">{block.rating!.toFixed(1)}</span>{" "}
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
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/20 pt-2.5">
          {onAddToCart && (
            <button
              type="button"
              onClick={() => onAddToCart?.()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-[11px] font-semibold text-[#1f4b57] shadow-sm hover:bg-white/90 transition-colors"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-3 w-3">
                <path d="M1.75 1.5a.75.75 0 0 0 0 1.5h.733l1.506 6.025A2.25 2.25 0 0 0 6.5 11.5h5.25a.75.75 0 0 0 0-1.5H6.5a.75.75 0 0 1-.727-.563L5.54 8.5h6.648a.75.75 0 0 0 .734-.589l.823-4.115A.75.75 0 0 0 13.011 3H3.927l-.23-.92A.75.75 0 0 0 3.75 1.5H1.75Z" />
                <path d="M6 13.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM12.5 13.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z" />
              </svg>
              Add to cart
            </button>
          )}
          <a
            href={partSelectProductPageUrl({
              partNumber: block.partNumber,
              title: block.title,
              manufacturer: block.manufacturer,
              manufacturerPartNumber: block.manufacturerPartNumber,
            })}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg bg-white/15 px-3 py-1.5 text-[11px] font-semibold text-white ring-1 ring-white/30 hover:bg-white/25 transition-colors"
          >
            View on PartSelect
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-3 w-3 opacity-75">
              <path fillRule="evenodd" d="M4.22 11.78a.75.75 0 0 1 0-1.06l5.25-5.25H6.75a.75.75 0 0 1 0-1.5h4.5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0V6.53l-5.25 5.25a.75.75 0 0 1-1.06 0Z" clipRule="evenodd" />
            </svg>
          </a>
        </div>
    </div>
  );
}

// ─── Block card ───────────────────────────────────────────────────────────────

// ─── Install card (needs hook for video) ─────────────────────────────────────

function InstallCard({ block }: { block: SupportBlock & { kind: "install" } }) {
  const { videoId } = usePartMedia(block.partNumber ?? "");

  return (
    <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-left text-xs shadow-sm">
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-amber-700">Install</p>
      <p className="mt-1 text-sm font-semibold leading-tight text-zinc-900">{block.title}</p>
      {block.subtitle && (
        <p className="mt-0.5 font-mono text-[11px] text-zinc-500">{block.subtitle}</p>
      )}

      {block.experience && (
        <div className="mt-3 border-t border-amber-200/60 pt-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-amber-700/80">
            Most customers report
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {block.experience.difficulty && (
              <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800">
                {block.experience.difficulty}
              </span>
            )}
            {block.experience.timeLabel && (
              <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800">
                {block.experience.timeLabel}
              </span>
            )}
            <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800">
              {block.experience.tools.length === 0 ? "No tools required" : block.experience.tools.join(" · ")}
            </span>
            <span className="text-[10px] text-zinc-500">
              · from {block.experience.sampleCount} customer{block.experience.sampleCount === 1 ? " story" : " stories"}
            </span>
          </div>
        </div>
      )}

      {block.steps && block.steps.length > 0 && (
        <ol className="mt-3 list-decimal space-y-1 border-t border-zinc-200 pt-2.5 pl-4 text-[11px] leading-relaxed text-zinc-700">
          {block.steps.map((s, i) => <li key={i}>{s}</li>)}
        </ol>
      )}

      {videoId && (
        <a
          href={`https://www.youtube.com/watch?v=${videoId}`}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 block overflow-hidden rounded-lg border border-amber-200 shadow-sm"
        >
          <div className="relative">
            <img
              src={`https://img.youtube.com/vi/${videoId}/mqdefault.jpg`}
              alt="Install video"
              className="w-full object-cover"
            />
            <div className="absolute inset-0 flex items-center justify-center bg-black/20">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/90 shadow">
                <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5 translate-x-0.5 text-amber-700">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </div>
            </div>
            <div className="absolute bottom-0 left-0 right-0 bg-linear-to-t from-black/60 to-transparent px-3 py-2">
              <p className="text-[11px] font-medium text-white">Watch install video on YouTube</p>
            </div>
          </div>
        </a>
      )}
    </div>
  );
}

// ─── Block card ───────────────────────────────────────────────────────────────

function BlockCard({ block, onAddToCart }: { block: ChatBlock; onAddToCart?: () => void }) {
  if (block.type === "product") {
    return <ProductCard block={block} onAddToCart={onAddToCart} />;
  }

  if (block.kind === "install") {
    return <InstallCard block={block as SupportBlock & { kind: "install" }} />;
  }

  // Support card (compat / repair / candidates) — color-coded by kind / verdict
  const isCompat   = block.kind === "compat";
  const compatOk   = isCompat && block.verdict?.tone === "ok";
  const compatWarn = isCompat && block.verdict?.tone === "warn";

  const cardBg = compatOk
    ? "bg-green-50 border-green-200"
    : compatWarn
      ? "bg-red-50 border-red-200"
      : "bg-white border-zinc-200";

  const kindLabel =
    block.kind === "compat"      ? "Compatibility"
    : block.kind === "candidates" ? "Candidate parts"
    : "Repair";

  const kindAccent = compatOk
    ? "text-green-700"
    : compatWarn
      ? "text-red-700"
      : block.kind === "candidates"
        ? "text-rose-700"
        : "text-zinc-600";

  return (
    <div className={`mt-3 rounded-xl border p-4 text-left text-xs shadow-sm ${cardBg}`}>
      <p className={`text-[10px] font-semibold uppercase tracking-[0.12em] ${kindAccent}`}>
        {kindLabel}
      </p>
      <p className="mt-1 text-sm font-semibold leading-tight text-zinc-900">{block.title}</p>
      {block.subtitle && (
        <p className="mt-0.5 font-mono text-[11px] text-zinc-500">{block.subtitle}</p>
      )}

      {block.verdict && (
        <div className={`mt-2 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold ${
          block.verdict.tone === "ok"
            ? "bg-green-100 text-green-800 ring-1 ring-green-300"
            : "bg-red-100 text-red-800 ring-1 ring-red-300"
        }`}>
          <span>{block.verdict.tone === "ok" ? "✓" : "✕"}</span>
          {block.verdict.label}
        </div>
      )}

      {block.note && (
        <p className="mt-2 text-[11px] leading-relaxed text-zinc-700">{block.note}</p>
      )}

      {block.steps && block.steps.length > 0 && (
        <ol className="mt-3 list-decimal space-y-1 border-t border-zinc-200 pt-2.5 pl-4 text-[11px] leading-relaxed text-zinc-700">
          {block.steps.map((s, i) => <li key={i}>{s}</li>)}
        </ol>
      )}

      {block.candidates && block.candidates.length > 0 && (
        <ul className="mt-3 space-y-2 border-t border-zinc-200 pt-2.5">
          {block.candidates.map((c, i) => {
            const price = formatPrice(c.price, c.currency);
            const stock = typeof c.inStock === "boolean" ? (c.inStock ? "In Stock" : "Out of stock") : null;
            return (
              <li key={c.id} className="flex items-start justify-between gap-3 rounded-lg bg-zinc-50 px-2.5 py-2 text-[11px]">
                <div className="min-w-0">
                  <p className="text-zinc-900">
                    <span className="mr-1 font-semibold text-zinc-500">#{i + 1}</span>
                    <span className="font-medium">{c.title}</span>
                  </p>
                  <p className="mt-0.5 font-mono text-[10px] text-zinc-500">
                    {c.partNumber} · {c.applianceFamily}
                  </p>
                  {c.reason && (
                    <p className="mt-0.5 text-[10px] italic text-zinc-500">matches: &ldquo;{c.reason}&rdquo;</p>
                  )}
                </div>
                <div className="shrink-0 text-right">
                  {price && <p className="text-xs font-semibold text-zinc-900">{price}</p>}
                  {stock && (
                    <p className={`mt-0.5 text-[10px] ${c.inStock ? "text-emerald-700" : "text-zinc-500"}`}>{stock}</p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {block.stories && block.stories.length > 0 && (
        <div className="mt-3 border-t border-amber-200/60 pt-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-amber-700/80">
            From customers
          </p>
          <ul className="mt-1.5 space-y-2">
            {block.stories.map((s) => {
              const helpful =
                typeof s.helpfulYes === "number" && typeof s.helpfulTotal === "number" && s.helpfulTotal > 0
                  ? `${s.helpfulYes} of ${s.helpfulTotal} found this helpful`
                  : null;
              const byline = [s.author, s.location].filter(Boolean).join(", ") || "Customer";
              return (
                <li key={s.id} className="rounded-lg bg-zinc-50 px-2.5 py-2">
                  <p className="text-[11px] font-semibold text-zinc-900">{s.title}</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-zinc-700">{s.body}</p>
                  <p className="mt-1 text-[10px] text-zinc-500">
                    — {byline}{helpful ? ` · ${helpful}` : ""}
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

// ─── Quick actions ─────────────────────────────────────────────────────────────

const QUICK_ACTIONS = [
  { label: "How do I install PS11752778?",              text: "How can I install part number PS11752778?" },
  { label: "Is PS11752778 compatible with WDT780SAEM1?", text: "Is PS11752778 compatible with my WDT780SAEM1 model?" },
  { label: "Ice maker not working",                     text: "The ice maker on my Whirlpool fridge is not working. How can I fix it?" },
  { label: "Find a part",                               text: "I want to find a part" },
] as const;

function buildWelcomeMessages(): ChatMessage[] {
  return [
    {
      id: "welcome",
      role: "assistant",
      content:
        "Tell me what's wrong with your fridge or dishwasher and I'll help you find the right part, check if it fits your model, and walk you through the repair.",
      suggested_actions: QUICK_ACTIONS.map((a) => ({
        id: a.label,
        label: a.label,
        prompt: a.text,
      })),
    },
  ];
}

// ─── Main ─────────────────────────────────────────────────────────────────────

// ─── Cart types ───────────────────────────────────────────────────────────────

/** Local demo cart only — not synced with PartSelect.com. */
type CartItem = {
  id: string;
  partNumber: string;
  title: string;
  price?: number;
  qty: number;
};

function isCartItem(x: unknown): x is CartItem {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.partNumber === "string" &&
    typeof o.title === "string" &&
    typeof o.qty === "number" &&
    (o.price === undefined || typeof o.price === "number")
  );
}

// ─── Cart (shared body + sidebar / mobile drawer) ───────────────────────────

/** Shopping cart glyph — PartSelect-style teal `#337788` (same as product cards). */
function CartShelfIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden
    >
      <path d="M2.25 2.25a.75.75 0 0 0 0 1.5h1.386c.17 0 .318.114.362.278l2.558 9.592a3.752 3.752 0 0 0-2.806 3.63c0 .414.336.75.75.75h15.75a.75.75 0 0 0 0-1.5H5.378A2.25 2.25 0 0 1 7.5 15h11.218a.75.75 0 0 0 .674-.421 60.358 60.358 0 0 0 2.96-7.228.75.75 0 0 0-.525-.965A60.864 60.864 0 0 0 5.68 4.509l-.232-.867A1.875 1.875 0 0 0 3.636 2.25H2.25ZM3.75 20.25a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0ZM16.5 20.25a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0Z" />
    </svg>
  );
}

function CartContents({
  items,
  onRemove,
  onQtyChange,
}: {
  items: CartItem[];
  onRemove: (id: string) => void;
  onQtyChange: (id: string, qty: number) => void;
}) {
  const total = items.reduce((sum, i) => sum + (i.price ?? 0) * i.qty, 0);
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center text-zinc-400">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-10 w-10 opacity-30">
              <path d="M2.25 2.25a.75.75 0 0 0 0 1.5h1.386c.17 0 .318.114.362.278l2.558 9.592a3.752 3.752 0 0 0-2.806 3.63c0 .414.336.75.75.75h15.75a.75.75 0 0 0 0-1.5H5.378A2.25 2.25 0 0 1 7.5 15h11.218a.75.75 0 0 0 .674-.421 60.358 60.358 0 0 0 2.96-7.228.75.75 0 0 0-.525-.965A60.864 60.864 0 0 0 5.68 4.509l-.232-.867A1.875 1.875 0 0 0 3.636 2.25H2.25ZM3.75 20.25a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0ZM16.5 20.25a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0Z" />
            </svg>
            <p className="text-sm">Your cart is empty</p>
            <p className="max-w-56 text-xs text-zinc-400">
              Use <span className="font-medium text-zinc-500">Add to cart</span> on a product card to build a demo order here.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {items.map((item) => (
              <li key={item.id} className="flex items-start gap-3 px-4 py-3">
                <CartLineThumb partNumber={item.partNumber} title={item.title} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-zinc-900">{item.title}</p>
                  <p className="mt-0.5 font-mono text-[10px] text-zinc-400">{item.partNumber}</p>
                  <div className="mt-1.5 flex items-center gap-2">
                    <select
                      value={item.qty}
                      onChange={(e) => onQtyChange(item.id, Number(e.target.value))}
                      className="rounded border border-zinc-200 bg-white px-1.5 py-0.5 text-xs text-zinc-700"
                    >
                      {[1, 2, 3, 4, 5].map((n) => (
                        <option key={n} value={n}>{n}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => onRemove(item.id)}
                      className="text-[10px] text-zinc-400 hover:text-red-500"
                    >
                      Remove
                    </button>
                  </div>
                </div>
                {typeof item.price === "number" && (
                  <p className="shrink-0 text-xs font-semibold text-zinc-900">
                    ${(item.price * item.qty).toFixed(2)}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {items.length > 0 && (
        <div className="shrink-0 space-y-3 border-t border-zinc-200 p-4">
          <div className="flex items-center justify-between text-sm">
            <span className="text-zinc-500">Subtotal (demo)</span>
            <span className="font-semibold text-zinc-900">${total.toFixed(2)}</span>
          </div>
          <p className="text-[10px] leading-snug text-zinc-400">
            This cart stays in the browser for the demo. The button below only opens PartSelect; it does not transfer these lines.
          </p>
          <a
            href="https://www.partselect.com/cart/"
            target="_blank"
            rel="noopener noreferrer"
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#337788] py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#2b6575]"
          >
            Checkout on PartSelect
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5">
              <path fillRule="evenodd" d="M4.22 11.78a.75.75 0 0 1 0-1.06l5.25-5.25H6.75a.75.75 0 0 1 0-1.5h4.5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0V6.53l-5.25 5.25a.75.75 0 0 1-1.06 0Z" clipRule="evenodd" />
            </svg>
          </a>
        </div>
      )}
    </>
  );
}

function CartSidebar({
  items,
  onRemove,
  onQtyChange,
}: {
  items: CartItem[];
  onRemove: (id: string) => void;
  onQtyChange: (id: string, qty: number) => void;
}) {
  const totalQty = items.reduce((s, i) => s + i.qty, 0);
  return (
    <aside className="hidden min-h-0 w-72 shrink-0 flex-col border-r border-zinc-200 bg-white md:flex">
      <div className="shrink-0 border-b border-zinc-200 px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <CartShelfIcon className="h-4 w-4 shrink-0 text-[#337788]" />
            <h2 className="text-sm font-semibold text-zinc-900">Your cart</h2>
          </div>
          {totalQty > 0 && (
            <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold text-zinc-600">
              {totalQty} {totalQty === 1 ? "item" : "items"}
            </span>
          )}
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <CartContents items={items} onRemove={onRemove} onQtyChange={onQtyChange} />
      </div>
    </aside>
  );
}

function CartDrawer({
  items,
  onClose,
  onRemove,
  onQtyChange,
}: {
  items: CartItem[];
  onClose: () => void;
  onRemove: (id: string) => void;
  onQtyChange: (id: string, qty: number) => void;
}) {
  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm md:hidden"
        onClick={onClose}
      />
      <div className="fixed right-0 top-0 z-50 flex h-full w-[min(100%,20rem)] flex-col bg-white shadow-2xl md:hidden">
        <div className="flex shrink-0 items-center justify-between border-b border-zinc-200 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <CartShelfIcon className="h-4 w-4 shrink-0 text-[#337788]" />
            <h2 className="text-sm font-semibold text-zinc-900">Your cart</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600"
            aria-label="Close cart"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
              <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
            </svg>
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          <CartContents items={items} onRemove={onRemove} onQtyChange={onQtyChange} />
        </div>
      </div>
    </>
  );
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function Toast({ message, onDone }: { message: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 3000);
    return () => clearTimeout(t);
  }, [onDone]);
  return (
    <div className="fixed bottom-24 left-1/2 z-50 -translate-x-1/2 animate-in fade-in slide-in-from-bottom-2 duration-200">
      <div className="flex items-center gap-2 rounded-xl bg-zinc-900 px-4 py-2.5 text-sm text-white shadow-lg">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4 text-emerald-400 shrink-0">
          <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z" clipRule="evenodd" />
        </svg>
        {message}
      </div>
    </div>
  );
}

export default function Home() {
  const [toast, setToast] = useState<string | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [cartItems, setCartItems] = useState<CartItem[]>([]);
  const [hydrated, setHydrated] = useState(false);

  function addToCart(block: ProductBlock) {
    setCartItems((prev) => {
      const existing = prev.find((i) => i.partNumber === block.partNumber);
      if (existing) {
        return prev.map((i) =>
          i.partNumber === block.partNumber ? { ...i, qty: i.qty + 1 } : i
        );
      }
      return [
        ...prev,
        {
          id: crypto.randomUUID(),
          partNumber: block.partNumber,
          title: block.title,
          price: block.price,
          qty: 1,
        },
      ];
    });
    setToast(`Added to cart: ${block.title}`);
  }

  const [messages, setMessages] = useState<ChatMessage[]>(() => buildWelcomeMessages());
  /** Compressed memory for turns older than the last `VERBATIM_MESSAGE_CAP` verbatim messages. */
  const [rollingSummary, setRollingSummary] = useState("");
  /** Index in the non-welcome transcript up to which text is represented in `rollingSummary`. */
  const [summaryFoldCursor, setSummaryFoldCursor] = useState(0);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // streamingId: the message id currently receiving tokens (null = idle)
  const [streamingId, setStreamingId] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const raw =
        localStorage.getItem(LS_DEMO_STATE_KEY) ??
        localStorage.getItem("partselect-demo-state-v1");
      if (raw) {
        const data = JSON.parse(raw) as { v?: number; messages?: unknown[]; cart?: unknown[] };
        if (Array.isArray(data.messages) && data.messages.length > 0 && data.messages.every(isChatMessage)) {
          setMessages(data.messages as ChatMessage[]);
        }
        if (Array.isArray(data.cart) && data.cart.every(isCartItem)) {
          setCartItems(data.cart as CartItem[]);
        }
      }
    } catch {
      /* ignore corrupt storage */
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    if (streamingId !== null) return;
    try {
      localStorage.setItem(
        LS_DEMO_STATE_KEY,
        JSON.stringify({
          v: 2,
          messages,
          cart: cartItems,
          rollingSummary,
          summaryFoldCursor,
        })
      );
    } catch {
      /* quota / private mode */
    }
  }, [messages, cartItems, rollingSummary, summaryFoldCursor, hydrated, streamingId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  async function sendText(text: string) {
    const trimmed = text.trim();
    if (!trimmed || loading || streamingId) return;

    setError(null);
    setLoading(true);
    setDraft("");

    const priorSnapshot = messages
      .filter((m) => m.id !== "welcome")
      .map((m) => ({ role: m.role, content: m.content }));
    const history = priorSnapshot.slice(-VERBATIM_MESSAGE_CAP);
    const summaryPayload = rollingSummary.trim().slice(0, MAX_CONVERSATION_SUMMARY_CHARS);

    setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "user", content: trimmed }]);

    let assistantContent = "";

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          history,
          ...(summaryPayload ? { conversation_summary: summaryPayload } : {}),
        }),
      });

      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
        setError(data.message ?? data.error ?? "Request failed");
        return;
      }

      // Response arrived — add the assistant bubble and switch to streaming mode.
      const msgId = crypto.randomUUID();
      setMessages((prev) => [...prev, { id: msgId, role: "assistant", content: "" }]);
      setLoading(false);
      setStreamingId(msgId);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmedLine = line.trim();
          if (!trimmedLine) continue;
          let event: Record<string, unknown>;
          try {
            event = JSON.parse(trimmedLine) as Record<string, unknown>;
          } catch {
            continue;
          }

          if (event.type === "token") {
            const piece = event.text as string;
            assistantContent += piece;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === msgId ? { ...m, content: m.content + piece } : m
              )
            );
          } else if (event.type === "replace") {
            // Server overrode the streamed text (OOS / clarify)
            assistantContent = String(event.text ?? "");
            setMessages((prev) =>
              prev.map((m) =>
                m.id === msgId ? { ...m, content: assistantContent } : m
              )
            );
          } else if (event.type === "done") {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === msgId
                  ? {
                      ...m,
                      blocks: Array.isArray(event.blocks) ? (event.blocks as ChatBlock[]) : [],
                      suggested_actions: Array.isArray(event.suggested_actions)
                        ? (event.suggested_actions as SuggestedAction[])
                        : [],
                    }
                  : m
              )
            );
          } else if (event.type === "error") {
            setError(String(event.message ?? "Stream error"));
          }
        }
      }

      const thread = [
        ...priorSnapshot,
        { role: "user" as const, content: trimmed },
        { role: "assistant" as const, content: assistantContent },
      ];
      const folded = await foldRollingSummary(thread, rollingSummary, summaryFoldCursor);
      setRollingSummary(folded.summary);
      setSummaryFoldCursor(folded.foldCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setLoading(false);
      setStreamingId(null);
    }
  }

  function clearConversation() {
    if (loading || streamingId) return;
    setMessages(buildWelcomeMessages());
    setRollingSummary("");
    setSummaryFoldCursor(0);
    setError(null);
    setDraft("");
  }

  return (
    <div className="flex h-dvh flex-col bg-zinc-50 text-zinc-900 md:flex-row">
      <CartSidebar
        items={cartItems}
        onRemove={(id) => setCartItems((prev) => prev.filter((i) => i.id !== id))}
        onQtyChange={(id, qty) => setCartItems((prev) => prev.map((i) => (i.id === id ? { ...i, qty } : i)))}
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Header — chat column only */}
        <header className="sticky top-0 z-20 shrink-0 border-b border-zinc-200 bg-white px-4 py-4 shadow-sm">
          <div className="mx-auto flex w-full max-w-4xl items-center gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#337788]">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4 text-white">
                <path d="M4.913 2.658c2.075-.27 4.19-.408 6.337-.408 2.147 0 4.262.139 6.337.408 1.922.25 3.291 1.861 3.405 3.727a4.403 4.403 0 0 0-1.032-.211 50.89 50.89 0 0 0-8.42 0c-2.358.196-4.04 2.19-4.04 4.434v4.286a4.47 4.47 0 0 0 2.433 3.984L7.28 21.53A.75.75 0 0 1 6 21v-4.03a48.527 48.527 0 0 1-1.087-.128C2.905 16.58 1.5 14.833 1.5 12.862V6.638c0-1.97 1.405-3.718 3.413-3.979Z" />
                <path d="M15.75 7.5c-1.376 0-2.739.057-4.086.169C10.124 7.797 9 9.103 9 10.609v4.285c0 1.507 1.128 2.814 2.67 2.94 1.243.102 2.5.157 3.768.165l2.782 2.781a.75.75 0 0 0 1.28-.53v-2.39l.33-.026c1.542-.125 2.67-1.433 2.67-2.94v-4.286c0-1.505-1.125-2.811-2.664-2.94A49.392 49.392 0 0 0 15.75 7.5Z" />
              </svg>
            </div>
            <div>
              <h1 className="text-sm font-semibold leading-tight text-zinc-900">PartSelect Assistant</h1>
              <p className="text-xs text-zinc-500">Refrigerator &amp; dishwasher parts</p>
            </div>
            <div className="ml-auto flex flex-wrap items-center justify-end gap-2 sm:gap-3">
              <button
                type="button"
                onClick={clearConversation}
                disabled={loading || !!streamingId}
                className="rounded-lg border border-zinc-200 bg-white px-2.5 py-1 text-[11px] font-medium text-zinc-600 shadow-sm hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Clear chat
              </button>
              <div className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-emerald-400" />
                <span className="text-xs text-zinc-500">Online</span>
              </div>
              <button
                type="button"
                onClick={() => setCartOpen(true)}
                className="relative rounded-lg p-1.5 text-[#337788] hover:bg-zinc-100 hover:text-[#2b6575] md:hidden"
                aria-label="Open cart"
              >
                <CartShelfIcon className="h-5 w-5" />
                {cartItems.length > 0 && (
                  <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#337788] px-0.5 text-[10px] font-bold text-white">
                    {cartItems.reduce((s, i) => s + i.qty, 0)}
                  </span>
                )}
              </button>
            </div>
          </div>
        </header>

        <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col px-4 py-4 min-h-0">
        {/* Messages */}
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto pb-4 min-h-0">
          {messages.map((msg) => {
            const isStreaming = streamingId === msg.id;
            const showBlocks  = !isStreaming && msg.blocks && msg.blocks.length > 0;
            const showActions = !isStreaming && msg.suggested_actions && msg.suggested_actions.length > 0;

            return (
              <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={
                    msg.role === "user"
                      ? "max-w-[85%] rounded-2xl rounded-br-md bg-zinc-900 px-4 py-2.5 text-sm text-white"
                      : "max-w-[90%] rounded-2xl rounded-bl-md border border-zinc-200 bg-white px-4 py-2.5 text-sm text-zinc-800 shadow-sm"
                  }
                >
                  <p className="whitespace-pre-wrap leading-relaxed">
                    {msg.content}
                    {isStreaming && (
                      <span className="ml-0.5 inline-block h-[1em] w-0.5 animate-pulse bg-zinc-400 align-middle" />
                    )}
                  </p>

                  {showBlocks && (
                    <div className="mt-1 space-y-1">
                      {msg.blocks!.map((b) => (
                        <BlockCard
                          key={`${b.type}-${b.id}`}
                          block={b}
                          onAddToCart={b.type === "product" ? () => addToCart(b as ProductBlock) : undefined}
                        />
                      ))}
                    </div>
                  )}

                  {showActions && (
                    <div className="mt-3 flex flex-wrap gap-2 border-t border-zinc-100 pt-3">
                      {msg.suggested_actions!.map((a) => (
                        <button
                          key={a.id}
                          type="button"
                          className="rounded-full border border-zinc-200 bg-white px-3 py-1 text-[11px] font-medium text-zinc-700 shadow-sm hover:bg-zinc-50"
                          onClick={() => void sendText(a.prompt)}
                          disabled={loading || !!streamingId}
                        >
                          {a.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {/* Loading dots while waiting for the first token */}
          {loading && !streamingId && (
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

        {/* Input */}
        <form
          className="sticky bottom-0 border-t border-zinc-200 bg-zinc-50 pt-3"
          onSubmit={(e) => { e.preventDefault(); void sendText(draft); }}
        >
          <div className="flex gap-2">
            <input
              className="min-h-11 flex-1 rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm shadow-inner outline-none focus:border-zinc-400"
              placeholder="Ask about a part, model, or symptom…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={loading || !!streamingId}
            />
            <button
              type="submit"
              className="rounded-xl bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              disabled={loading || !!streamingId || !draft.trim()}
            >
              Send
            </button>
          </div>
        </form>
      </div>
      </div>

      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
      {cartOpen && (
        <CartDrawer
          items={cartItems}
          onClose={() => setCartOpen(false)}
          onRemove={(id) => setCartItems((prev) => prev.filter((i) => i.id !== id))}
          onQtyChange={(id, qty) => setCartItems((prev) => prev.map((i) => (i.id === id ? { ...i, qty } : i)))}
        />
      )}
    </div>
  );
}
