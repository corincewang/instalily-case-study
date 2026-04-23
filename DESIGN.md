# PartSelect Chat Agent — Design Document

## Summary

This is a **domain-scoped** assistant for **refrigerator and dishwasher parts** only. The server exposes a **streaming chat API** (NDJSON over `fetch`, not SSE) that either runs a **tool-calling LLM** when `OPENAI_API_KEY` is set or a **fully deterministic** path when it is not. Structured answers (price, compatibility, install steps, cards) are always grounded in **`retrieveExact` + `catalog.json`**; fuzzy “customer experience” questions can optionally use **`semantic_search`** over precomputed embeddings. The UI is a single-page layout: **chat** (product / support cards, suggested chips, sticky chrome so only the transcript scrolls) plus a **left mock cart** for a simple customer transaction demo tied to “Add to cart” on product cards.

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

**Boundary enforcement** is layered (system prompt → deterministic OOS gate → `no_evidence` + citation alignment). The LLM cannot widen scope by prompt alone; see **Session and scope** below and **Agentic architecture** for session memory.

---

## Design decisions and tradeoffs

**Cross-cutting (applies to every axis):** two architecture choices that sit above any single layer.

| Design point | Tradeoff / rationale |
| ------------ | -------------------- |
| **Server-built blocks (stable, grounded UI payloads)** | `buildBlocksFromRetrieval` assembles `product` / `support` blocks from `retrieveExact` and tool-backed retrieval. The model streams natural language; I **do not** rely on the LLM emitting parse-perfect JSON for card payloads, so the UI stays deterministic and testable. |
| **Stable `POST /api/chat` JSON contract** | After NDJSON `token` / `replace` lines, the terminal **`done`** object always carries the same shape: `reply`, `blocks`, `citations`, `suggested_actions`, `tool_trace`, `no_evidence`, etc. Frontends, mocks, and golden tests can assert on fields without guessing schema drift. |

### Interface (client + HTTP contract)

| Design point | Tradeoff / rationale |
| ------------ | -------------------- |
| **Stream replies as newline-delimited JSON over POST (not SSE)** | I need the request body to carry message + history; `EventSource` can’t do that cleanly. Downside: the client parses each line itself instead of using a built-in SSE helper. |
| **Show answers as cards plus short “what next?” chips** | Cards hold structured catalog data (part, install, compat); chips are tap-to-send follow-ups. Clarify flows keep real tips in the reply text so they aren’t mistaken for buttons. |
| **Left sidebar mock cart for a lightweight “transaction” story** | A fixed **cart** column (drawer on small viewports) holds **browser-local** lines only—qty, line subtotal, thumbnails via `/api/part-image`—so I can demo add-to-cart → review → jump to PartSelect checkout without pretending the real PartSelect cart API exists. |

### Agentic architecture

| Design point | Tradeoff / rationale |
| ------------ | -------------------- |
| **Let the model call tools in a loop, with a hard round cap** | It can chain “normalize text → look up part → check fit” like a human. More rounds mean more latency and cost, so we stop after a small fixed maximum. |
| **Treat the local catalog as the source of truth for what appears on screen** | Tool results plus `retrieveExact` fill a retrieval object; cards and citations come from that. The model explains — it shouldn’t invent PS numbers, prices, or compatibility verdicts. |
| **One main path for real catalog answers (OpenAI tools + streaming)** | Easier to maintain than two divergent pipelines. Tradeoff: no API key means catalog turns return **503**; lightweight routes (hello, glossary, hard refusal) still run without the model. |
| **Session memory for multi-turn tools and retrieval** | Each `POST` includes `history`. I scan newest-first for the latest **PS** and **appliance model** token, pass them as `SessionContext` into `retrieveExact`, and add a **one-line session note** to the system prompt so the agent does not re-parse the whole thread for anchors. **`allowSessionCarryForRetrieval`** only merges that PS/model when the *current* message still reads like install, price, fit, or names a part—so a fresh symptom question does not inherit an unrelated compat or product row. |

### Extensibility and scalability

| Design point | Tradeoff / rationale |
| ------------ | -------------------- |
| **Keep the dataset in `catalog.json`** | Great for a demo I can diff in Git; not a production database — no concurrent writes, and I’d replace it if the product grew. |
| **Put all “match this message to catalog rows” logic in `retrieveExact`** | One place to read when adding a signal; later I could swap innards (SQL, cache) without changing what the UI expects. |
| **Optional RAG: `semantic_search` on a small embedding file + in-memory cosine** | Lightweight **RAG** over curated text chunks (`embeddings.json`); no hosted vector DB. Fine for hundreds of chunks at O(n) cosine; if content explodes, I’d move to an approximate nearest-neighbor index. |

### Queries (six query categories)

I split traffic into **six top-level categories**. The **system prompt** and routing heuristics steer the **agent toward the right tools** for each category; **`classifyIntent`** + **`buildBlocksFromRetrieval`** then pick the **card** shape (`product` / `support` kinds) from the merged retrieval.

| # | Category | What the user is usually doing | Tools the agent leans on (typical) | Primary UI |
|---|----------|--------------------------------|-------------------------------------|------------|
| **1** | **Install** | “How do I install / replace PS…?” | `get_install_guide`, `lookup_part`, `normalize_part_number` | `support` · `kind: install` |
| **2** | **Compatibility** | “Does this part fit model …?” | `check_compatibility`, `normalize_part_number`, `lookup_part` | `support` · `kind: compat` |
| **3** | **Symptom / repair** | Ice maker, leak, noise, not draining, etc. | `search_by_symptom`, `catalog_search` | `support` · `kind: repair` and/or `candidates` |
| **4** | **Part lookup & browse** | PS/OEM, supersession, “show fridge parts” | `lookup_part`, `normalize_part_number`, `catalog_search` | `product` and/or `candidates` |
| **5** | **Out-of-scope** | Wrong appliance or off-topic | *(no catalog tools)* — refusal copy + chips | **No** block |
| **6** | **Clarify** | Missing model, PS, or symptom detail | Optional `normalize_part_number`; mostly dialog | Question + example chips; **no** block |

**When no block is rendered:** out-of-scope refusal → missing-field clarify → generic “no match” copy. *Implementation detail:* `buildChatBlocks.ts` uses a few extra intent labels (`buy`, `oem`, `diagnose`, `search`, `generic`) under the hood; they fold into the rows above for cards and chips.

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
