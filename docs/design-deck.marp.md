---
marp: true
theme: default
size: 16:9
paginate: true
footer: PartSelect Chat Agent — Design (from DESIGN.md)
---

<!-- _class: lead -->
# PartSelect Chat Agent
## Architecture & design (case study)
**Refrigerator & dishwasher parts · streaming chat · tool-calling LLM**

---

## Summary

- **Domain-scoped** assistant: fridge & dishwasher parts only  
- **API:** `POST /api/chat` — **NDJSON** stream (`token` / `replace` → `done`), not SSE  
- **Catalog:** `retrieveExact` + `catalog.json`; optional **`semantic_search`** (embeddings)  
- **UI:** Chat (cards + chips) + **left mock cart** (local demo transaction → PartSelect checkout link)

---

## Goals

- In-domain: lookup, price/stock, OEM/supersession, install, compat, symptom → repair / candidates  
- **Refuse** out-of-domain topics clearly  
- **Ground** copy & cards in catalog + citations  
- **Stream** replies; optional **RAG** for experiential questions  

---

## Scope

| **In scope** | **Out of scope** |
|--------------|------------------|
| PS / OEM / symptoms / install / compat | Orders, returns, live handoff |
| `catalog.json` + optional PDP scrape | Washers, HVAC, … (refused) |
| Read-only PartSelect HTML (`fetch_part_page`, images) | Official PartSelect API |

**Layers:** system prompt → **OOS gate** → `no_evidence` + **citation alignment**

---

## Cross-cutting (2)

| **Choice** | **Why** |
|------------|---------|
| **Server-built blocks** | `buildBlocksFromRetrieval` — UI from retrieval; **no** fragile LLM JSON for cards |
| **Stable `done` JSON** | `reply`, `blocks`, `citations`, `suggested_actions`, `tool_trace`, `no_evidence` — easy to test & integrate |

---

## Interface (Instalily axis)

1. **NDJSON over POST** — body carries `message` + `history` (`EventSource` / SSE is GET-only)  
2. **Cards + chips** — structured catalog UI; clarify keeps tips in prose vs fake buttons  
3. **Left mock cart** — browser-local qty/subtotal/thumbs (`/api/part-image`); demo checkout story  

---

## Agentic architecture (1/2)

| **Decision** | **Rationale** |
|----------------|---------------|
| **Tool loop + cap** | Chain normalize → lookup / compat / symptom; bound cost & latency |
| **Catalog = source of truth** | Tool output + `retrieveExact` → retrieval → cards; model narrates only |

---

## Agentic architecture (2/2)

| **Decision** | **Rationale** |
|----------------|---------------|
| **One LLM path for catalog** | No key → **503** on catalog turns; hello / glossary / OOS without model |
| **Session memory (gated)** | `history` → PS + model → `SessionContext` + system note; **`allowSessionCarryForRetrieval`** so vague follow-ups don’t inherit wrong compat/product |

---

## Extensibility & scalability

1. **`catalog.json`** — diff-friendly demo DB; swap for real DB later  
2. **`retrieveExact`** — single hybrid retrieval API (indexes/SQL later)  
3. **Optional RAG** — `semantic_search` + `embeddings.json` + in-memory cosine; scale → ANN  

---

## Six query categories → tools → UI

| # | Category | Typical tools | Primary UI |
|---|----------|---------------|------------|
| 1 | Install | `get_install_guide`, `lookup_part` | `support` · install |
| 2 | Compatibility | `check_compatibility`, `normalize` | `support` · compat |
| 3 | Symptom / repair | `search_by_symptom`, `catalog_search` | repair / **candidates** |
| 4 | Lookup & browse | `lookup_part`, `catalog_search` | `product` / candidates |
| 5 | Out-of-scope | *(none)* | refusal, **no** block |
| 6 | Clarify | optional `normalize` | question + chips, **no** block |

**No block:** OOS → clarify → no-match copy · *Finer intents in `buildChatBlocks.ts`*

---

## Tool catalog (compact)

`normalize_part_number` · `lookup_part` · `check_compatibility` · `get_install_guide` · `search_by_symptom` · **`semantic_search`** · `fetch_part_page` · **`catalog_search`**

---

## Session & scope (recap)

**Scope (outer → inner)**  
1. System prompt — in-domain tools  
2. **Deterministic OOS** — empty blocks + refusal  
3. **`alignCitationsToBlocks`** — citations match rendered blocks only  

**Clarify:** `Example:` lines → chips; other tips stay in reply body  

---

## Server pipeline

```
POST /api/chat
  → conversation / glossary (optional)
  → OOS gate
  → LLM tool loop
  → buildBlocksFromRetrieval
  → clarify override (if no blocks)
  → alignCitationsToBlocks
  → done { blocks, citations, suggested_actions, tool_trace, … }
```

---

## Data artifacts

| Path | Role |
|------|------|
| `web/data/catalog.json` | Source of truth for cards |
| `web/data/embeddings.json` | Optional vectors for `semantic_search` |
| `web/scripts/scrape-parts.mjs` | Refresh PDP fields |
| `web/scripts/generate-embeddings.mjs` | Build embeddings |

---

## Invariants & evaluation

**Invariants**  
1. Structured facts from catalog / tools — not hallucinated  
2. No API key → still usable paths (per DESIGN.md)  
3. Stream always **closes** in `finally`  

**Evaluation:** `web/scripts/goldenCases.mjs` — single- + multi-turn; **`tool_trace`** assertions when LLM on  

---

<!-- _class: lead -->
# Thank you
### Source: `DESIGN.md` · **PPTX:** `python3 docs/generate_design_deck.py` → `docs/PartSelect-Design-Deck.pptx` · Optional: edit `docs/design-deck.marp.md` and export with [Marp](https://marp.app/) (VS Code extension or CLI)
