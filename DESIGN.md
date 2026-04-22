# PartSelect Chat Agent — Design Doc

A chat agent scoped to **refrigerator and dishwasher parts**. Answers product, install, compatibility, and repair questions; refuses everything else.

---

## Goals

**In scope** — product info (price, stock, OEM, supersession), install guidance, compatibility checks, symptom → repair / candidate parts, strict domain refusal, grounded answers tied to catalog citations.

**Out of scope** — order/shipping/returns, other appliances, arbitrary chat, vector search (catalog is small enough for rule-based retrieval today).

---

## Architecture

```
User message
    │
    ▼
[OOS gate] ← deterministic, runs before LLM — cannot be prompt-injected
    │ in-scope
    ├─── LLM path (OPENAI_API_KEY set) ────────────────────────┐
    │    Tool loop (≤ 6 rounds):                               │
    │      normalize_part_number → route to most specific tool  │
    │      lookup_part | check_compatibility |                  │
    │      get_install_guide | search_by_symptom |             │
    │      catalog_search (fallback)                           │
    │    buildRetrievalFromTrace() ← no re-query for specific  │
    │    tools; symptom queries fall back to retrieveExact     │
    │                                                          │
    ├─── Deterministic path (no key) ──────────────────────────┤
    │    Same 6 tools via heuristic routing                    │
    │    catalog_search always runs last                       │
    │                                                          │
    ▼                                                          │
[buildBlocksFromRetrieval] ←───────────────────────────────────┘
[OOS / clarify override]  ← if blocks empty
[alignCitationsToBlocks]
    │
JSON  { reply, blocks, citations, suggested_actions, tool_trace, used_llm }
```

**Two invariants:**

1. The LLM never invents product facts — `retrieveExact` is the source of truth.
2. The system works end-to-end without an API key (deterministic path, same golden tests).

---

## Tool surface


| Tool                    | When                                                   |
| ----------------------- | ------------------------------------------------------ |
| `normalize_part_number` | Always first if PS##### might be in message            |
| `lookup_part`           | User asks about a specific part                        |
| `check_compatibility`   | Need both part + model; agent asks if missing          |
| `get_install_guide`     | Install intent + known part                            |
| `search_by_symptom`     | Symptom described, no part named                       |
| `catalog_search`        | OEM/supersession/browse/repair-guide — everything else |


---

## Scope enforcement

Three independent layers, outermost first:

1. **System prompt** — tells the LLM to refuse out-of-scope and call tools instead of guessing.
2. **Deterministic OOS gate** — runs *before* retrieval. Whitelist of in-scope signals (appliance words, PS numbers, known brands) checked against a prioritized blacklist. On a hit, blocks are forced to `[]` and reply is a canonical refusal regardless of what the LLM said.
3. `**no_evidence` + citation alignment** — if retrieval found nothing, no card renders.

The LLM cannot override scope.

---

## Session memory

History is sent from the client each turn. The route extracts the most recently mentioned `partNumber` and `model` deterministically (regex, no LLM) and injects them as a compact one-line note into the system prompt. The LLM gets context without replaying full history; retrieval uses the resolved values as fallback seeds.

---

## Design Decisions, Tradeoffs & extensibility


| Decision                                          | Tradeoff                                                                                                                                                                                                                   |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rule-based retrieval over vector search           | Fully explainable, zero infra — swap body of `retrieveExact.ts` when scale demands it                                                                                                                                      |
| Specific tools + `catalog_search` fallback        | Four retrieval modes (OEM, supersession, repair guide, browse) have no dedicated tool — adding them would fragment LLM routing. `retrieveExact` handles all four in one pass; split into indexed tools when catalog scales |
| `buildBlocksFromRetrieval` as stable interface    | Retrieval and rendering are decoupled; LLM path and deterministic path share identical block logic                                                                                                                         |
| Compact session context string (not full history) | O(1) token cost per turn; deterministic extraction avoids LLM re-reading old turns                                                                                                                                         |


---

## Evaluation

19 golden cases (`scripts/goldenCases.mjs`) cover all 7 query categories: install, price/stock, compatibility (ok + warn), symptom → repair guide, OEM/supersession lookup, reverse diagnosis, browse, clarify (3 shapes), OOS (4 shapes), multi-turn stitching. When the LLM is active, tool_trace assertions verify it chose the right specific tool.