# PartSelect Chat Agent — Design Document

## Summary

This is a **domain-scoped** assistant for **refrigerator and dishwasher parts** only. The server exposes a **streaming chat API** (NDJSON over `fetch`, not SSE) that either runs a **tool-calling LLM** when `OPENAI_API_KEY` is set or a **fully deterministic** path when it is not. Structured answers (price, compatibility, install steps, cards) are always grounded in **`retrieveExact` + `catalog.json`**; fuzzy “customer experience” questions can optionally use **`semantic_search`** over precomputed embeddings. The UI is a single-page chat with **product / support cards**, **suggested chips**, and **sticky chrome** so scrolling stays inside the message pane.

---

## Goals

- Answer **in-domain** questions: part lookup, price/stock, OEM/supersession, install steps, model compatibility, symptom → repair guide or candidate parts.
- **Refuse** clearly when the topic is outside refrigerators/dishwashers or is order/returns/support we do not model.
- **Ground** assistant copy and cards in catalog data and aligned citations; avoid inventing SKUs, prices, or compatibility.
- **Stream** the assistant reply so the user sees text before structured cards arrive.
- **Optional RAG**: surface relevant customer stories / FAQ / install snippets when the question is experiential (“how hard”, “anyone on Kenmore”, etc.).

---

## Scope

| In scope | Out of scope |
| -------- | ------------ |
| Fridge & dishwasher parts (PartSelect-style PS numbers, OEM cross-refs, symptoms, install, compat) | Orders, shipping, returns, warranties, live human handoff |
| Local `catalog.json` + optional scraped PDP fields | Other appliance categories (washers, HVAC, …) unless clearly refused |
| Live **read-only** fetch of PartSelect HTML for gaps (`fetch_part_page`, part images) | Official PartSelect API (none public); scraping must stay polite / ToS-aware in production |

**Boundary enforcement** is layered (system prompt → deterministic OOS gate → `no_evidence` + citation alignment). The LLM cannot widen scope by prompt alone; see **Session and scope** below.

---

## Design decisions and tradeoffs

Design choices are grouped along four axes: **interface**, **agentic architecture**, **extensibility & scalability**, and **queries** (routing + retrieval).

### Interface (client + HTTP contract)

| Design point | Tradeoff / rationale |
| ------------ | -------------------- |
| **NDJSON stream** (`token` → optional `replace` → `done`) | **Pro:** Works with `POST` + JSON body (history, message). **Con:** No browser `EventSource`; client must parse lines and handle backpressure manually. SSE was rejected because `EventSource` cannot send a request body. |
| **Single `ReadableStream` close in `finally`** | Ensures the client always sees stream end so UI state (e.g. “typing”) clears; omitting `controller.close()` wedges the UI. |
| **`h-dvh` + `min-h-0` on flex children** | Locks layout to the viewport so only the message list scrolls; avoids whole-page scroll hiding the header. **Con:** Requires discipline on nested flex (classic `min-height: auto` trap). |
| **Cards + chips** (`product` / `support` blocks + `suggested_actions`) | Structured UI for catalog-backed answers; chips only for **actionable** next prompts, not free-text tips (see Clarify UX). |
| **`GET /api/part-image/[ps]`** for thumbnails / install video | Server-side fetch avoids client CORS/WAF issues; **Con:** Couples availability to PartSelect HTML shape; cache is in-process only (resets on deploy). |

### Agentic architecture

| Design point | Tradeoff / rationale |
| ------------ | -------------------- |
| **Tool loop (≤ 6 rounds)** with `tool_choice: "auto"` | Lets the model chain normalize → lookup/compat/symptom → fallback `catalog_search`. **Con:** Latency stacks with rounds; cap prevents runaway cost. |
| **`buildRetrievalFromTrace`** after specific tools | Avoids re-querying the full catalog when the LLM never called `catalog_search`; **Con:** must keep trace → `Retrieval` mapping in sync when adding tools. |
| **Async tools** (`fetch_part_page`, `semantic_search`) in the loop | Network + embedding calls handled like other side effects; sync `executePartselectTool` stays pure for the rest. |
| **Reply consistency guard** (`formatCatalogReplyFromRetrieval` when LLM claims “no match” but blocks exist) | Prevents contradictory UX; **Con:** rare case where streamed tokens disagree with final `replace` — client handles `replace`. |
| **Dual path: LLM vs no-key deterministic** | Same golden tests and similar UX without vendor lock-in for local runs. **Con:** Two code paths to maintain; feature parity skews toward LLM path for streaming/RAG. |

### Extensibility and scalability

| Design point | Tradeoff / rationale |
| ------------ | -------------------- |
| **`catalog.json` as the “database”** | Zero ops, easy diff/review for a case study. **Con:** No concurrent writes, no partial updates; swap for SQLite/Postgres when you need multi-tenant or writes. |
| **`retrieveExact` as single structured retrieval API** | One place to add indexes, caching, or SQL later. **Con:** Grows monolithic until you split by intent behind the same facade. |
| **File-backed `embeddings.json` + in-memory cosine search** | No Pinecone/pgvector for hundreds of chunks. **Con:** O(n) per query; move to ANN index when n ≫ 10⁴. |
| **One-off `scrape-parts.mjs` + `generate-embeddings.mjs`** | Reproducible data refresh in CI or locally. **Con:** Requires API key for embeddings; scraper must rate-limit (sleep between PDPs). |
| **`buildBlocksFromRetrieval` stable contract** | UI and API stay decoupled from whether the LLM ran; add new block types without changing the stream envelope beyond `done.blocks`. |

### Queries (six intent categories + overrides)

These buckets drive **which card** renders, **which chips** appear, and the **reply override** order when no catalog block is shown.

| # | Category | Typical intent | Primary output |
|---|----------|----------------|----------------|
| **1** | Install (PS) | “How do I install PS…?” | `support` · `kind: install` |
| **2** | Compatibility | “Does PS… fit WRS…?” | `support` · `kind: compat` |
| **3** | Symptom | “Ice maker not working” → repair steps and/or reverse-diagnosis candidates | `support` · `kind: repair` and/or `candidates` |
| **4** | Part lookup / browse | OEM, supersession, multi-hit search | `product` and/or `candidates` |
| **5** | Out-of-scope | Wrong appliance / generic chat | Refusal reply + chips; **no** block |
| **6** | Clarify | Missing model, missing PS, etc. | Question reply + example chips; **tips in prose**, not chips |

**Override order (no block):** **(5) OOS** → **(6) clarify** → deterministic “no match” copy.  
*(An older internal comment listed a seventh “reserved” slot for removed order-support; it is intentionally omitted here.)*

---

## Tool catalog

| Tool | Role |
| ---- | ---- |
| `normalize_part_number` | Extract PS##### tokens from messy user text. |
| `lookup_part` | Full part row by PS number. |
| `check_compatibility` | Part + model → compat row. |
| `get_install_guide` | Install copy + steps for a known PS. |
| `search_by_symptom` | Symptom → catalog search path. |
| `semantic_search` | Embed query → cosine match on stories / FAQ / install chunks (`embeddings.json`). |
| `fetch_part_page` | Live PartSelect PDP when the part is missing locally (slow; last resort). |
| `catalog_search` | Broad `retrieveExact` pass; typical fallback after specific tools. |

---

## Session and scope

**Session memory** — The client sends prior turns each request. The route **regex-scans** history (newest first) for the latest PS number and model token and injects a **one-line session note** into the system prompt so the model does not re-read full history for anchors.

**Scope layers (outer → inner):**

1. **System prompt** — In-domain tool use; no inventing catalog facts.  
2. **Deterministic OOS gate** — Runs before retrieval; can force empty blocks + canned refusal.  
3. **`no_evidence` + `alignCitationsToBlocks`** — Citations only for rendered block ids; empty retrieval → no cards.

**Clarify UX** — `buildClarifyReplyFromRetrieval` splits lines starting with `Example:` into **chips**; plain informational lines (e.g. where to read the model tag) are **appended to the reply body** so they are not mistaken for user-sendable prompts.

---

## Server pipeline (concise)

```
POST /api/chat
  → glossary short-circuit (optional stream)
  → OOS gate
  → [LLM tool loop | deterministic tools]
  → buildBlocksFromRetrieval
  → clarify / OOS reply overrides
  → alignCitationsToBlocks
  → stream: tokens (LLM or chunked deterministic) → done { blocks, citations, suggested_actions, tool_trace, ... }
```

---

## Data artifacts

| Artifact | Purpose |
| -------- | ------- |
| `web/data/catalog.json` | Parts, compatibilities, repair guides — source of truth for structured cards. |
| `web/data/embeddings.json` | Optional; chunks + vectors for `semantic_search`. Generated by `web/scripts/generate-embeddings.mjs`. |
| `web/scripts/scrape-parts.mjs` | Merge real PartSelect PDP fields into `catalog.json` (rate-limited). |

---

## Invariants

1. **Structured facts** come from the catalog / `retrieveExact` path (and live fetch only as an explicit tool), not from unconstrained model prose.  
2. **No API key** still yields a working app (deterministic routing + same block builder + golden tests).  
3. **Streaming** must always end the body stream so clients can finalize UI state.

---

## Evaluation

**19 golden cases** in `web/scripts/goldenCases.mjs` cover the six query categories, clarify shapes, OOS, and multi-turn context. With the LLM enabled, assertions on `tool_trace` check that the expected tool was chosen for representative turns.
