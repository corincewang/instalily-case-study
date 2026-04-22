# PartSelect Chat Agent — Design Doc

A chat agent scoped to **refrigerator and dishwasher parts** on a PartSelect-style
catalog. This doc explains the system as it stands today: what it is, how a
turn flows through it, and what knobs exist for extension.

---

## 1. Goals & non-goals

**In scope**
- Product information: identity, pricing, stock, compatibility, OEM / supersession.
- Task assistance: install guidance, basic troubleshooting, symptom → candidate parts.
- Strict domain boundary: refuse anything outside fridge / dishwasher parts.
- Grounded answers: every fact is tied to a catalog row (citation on the wire).
- Deterministic fallback: the system still works end-to-end when no LLM key is present.

**Out of scope (deliberately)**
- Order / shipping / return flows (not a fridge-or-dishwasher concern).
- Arbitrary conversational Q&A (no jokes, no coding help, no other appliances).
- Vector search / RAG (our catalog is small enough for rule-based retrieval today).
- Writes to the catalog (read-only demo).

---

## 2. Architecture at a glance

```
┌───────────────────────────┐
│  Next.js client (app/)    │   chat UI, product + support cards, chips
└─────────────┬─────────────┘
              │ POST /api/chat  { message }
              ▼
┌───────────────────────────────────────────────────────┐
│  API route (app/api/chat/route.ts)                    │
│  1. Validate input                                    │
│  2. runChatWithLlmTools() if OPENAI_API_KEY present   │
│  3. Fall back to deterministic retrieval if no key    │
│  4. Deterministic reply overrides: OOS → Clarify      │
│  5. Build blocks + suggested actions + citations      │
└──────┬──────────────────────────────┬─────────────────┘
       │                              │
       ▼                              ▼
┌──────────────┐              ┌──────────────────────┐
│  LLM planner │── tools ──►  │ retrieveExact()      │
│  (OpenAI)    │              │ (rule-based, local)  │
└──────────────┘              └──────────┬───────────┘
       │                                 │
       └─────── citations, ──────────────┘
               part / compat / guide
                         │
                         ▼
                ┌──────────────────┐
                │  catalog.json    │   parts, compatibilities, repairGuides
                └──────────────────┘
```

Two layers cooperate on every turn:

1. **LLM planner** (`lib/llm/runAgent.ts`) — uses a narrow tool set to compose a reply.
2. **Deterministic retrieval** (`lib/retrieveExact.ts`) — runs regardless; its result
   is what we render cards from and what we cite. The LLM's words are polish on top.

The LLM is **never** the source of truth for product facts — `retrieveExact` is.
This keeps us grounded, auditable, and able to degrade to a usable chat when no
key is set.

---

## 3. Request lifecycle (happy path)

A user sends `"How can I install part number PS11752778?"`.

1. **Input validation** — non-empty string, bounded length.
2. **LLM tool loop** (`runChatWithLlmTools`):
   - System prompt pins the agent to fridge/dishwasher parts and tells it to
     call tools rather than guess.
   - Tools: `normalize_part_number`, `catalog_search`. Tool args are validated
     (regex for PS numbers, collapsing for model tokens) before hitting the
     catalog. Malformed args → structured `ok: false` result, never a crash.
   - Each tool call writes a `tool_trace` entry (visible to the client for the
     Loom demo).
3. **Deterministic retrieval** runs in parallel with the LLM composition; its
   output (`part`, `compatibility`, `guide`, `candidates`, `searchResults`,
   `citations`) is the system of record.
4. **Intent classification** (`classifyIntent`) picks which card to render:
   `buy | install | compat | repair | diagnose | oem | search | generic`.
   Intent is a UI concern, **never** a retrieval gate.
5. **Block assembly** (`buildBlocksFromRetrieval`) emits at most one
   `product` + one `support` card. Content is trimmed per intent (e.g. a price
   question doesn't render install steps).
6. **Scope enforcement** runs last on empty-block responses:
   - **OOS detector** (`detectOutOfScope`) wins first — replaces the reply with a
     canonical refusal and emits in-domain chips.
   - **Clarify detector** (`buildClarifyReplyFromRetrieval`) runs next — for
     in-domain but under-specified turns (e.g. "is this compatible?" without a
     model) we reply with a short question and example chips.
   - Otherwise the fallback "no match" reply stands.
7. **Citation alignment** (`alignCitationsToBlocks`) filters citations down to
   the IDs that actually appear in rendered blocks, so the client never sees a
   dangling source.
8. **Response shape** (stable API contract):

   ```ts
   {
     reply: string,                 // short natural-language answer
     blocks: ChatBlock[],           // ≤ 1 product + ≤ 1 support
     citations: Citation[],         // every id appears somewhere in blocks
     suggested_actions: Chip[],     // next-step prompts
     normalized_part_numbers: string[],
     tool_trace: ToolTraceEntry[],  // which tools LLM chose, with args / ok
     no_evidence: boolean,          // true iff blocks.length === 0
     used_llm: boolean,
   }
   ```

---

## 4. Component map

| Area | File(s) | Role |
|---|---|---|
| UI | `app/page.tsx` | Chat surface, product card, support card, chips |
| API | `app/api/chat/route.ts` | Single `POST /api/chat` entry point |
| LLM planner | `lib/llm/runAgent.ts`, `lib/llm/systemPrompt.ts` | Tool loop + scope-pinned system prompt |
| Retrieval | `lib/retrieveExact.ts` | Hybrid rule-based retrieval |
| Block assembly | `lib/buildChatBlocks.ts` | Intent classifier + card + chip builders + OOS / clarify detectors |
| Fallback reply | `lib/formatCatalogReply.ts` | Non-LLM text reply |
| Data | `data/catalog.json` | Parts, compatibilities, repair guides, stories, Q&A |
| Eval | `scripts/goldenCases.mjs` | 17 end-to-end golden tests |

---

## 5. Scope enforcement (the "only fridge & dishwasher" contract)

Three layers, outermost first. Each layer is independently sufficient.

1. **System prompt** instructs the LLM to refuse out-of-scope and to call tools
   instead of guessing for in-scope.
2. **Deterministic OOS detector** (`detectOutOfScope`) uses a whitelist of
   in-scope signals (appliance words, PS numbers, known brands, known symptoms)
   against a prioritized blacklist of OOS patterns (other appliances, code
   requests, prompt-injection phrases, generic chatter). On a hit it
   **overwrites** the LLM reply with a canonical refusal. The LLM cannot
   override scope by being clever.
3. **Citation alignment + `no_evidence`** flag — if nothing got retrieved, the
   UI shows no card and the reply is either the OOS refusal, a clarify
   question, or "no match".

This is the piece the case-study prompt is most explicit about
("avoiding responses to questions outside this scope"), so it's the piece that
has redundancy and tests.

---

## 6. Retrieval model

`retrieveExact` runs a cascade on every turn. Earlier stages cost more in
specificity, later stages are safety nets:

1. Exact PS number token in message.
2. OEM / manufacturer part number substring (≥ 5 chars).
3. Supersession — user mentioned an older number listed in a part's `replaces[]`.
4. Model compatibility (literal + whitespace/punctuation-collapsed match).
5. Strict repair guide phrase (`matchIncludesAll` — all fragments present).
6. Part keyword substring match.
7. Flexible repair guide phrase (`matchFlexible` — AND across OR-groups).
8. Symptom → candidates (ranked by phrase-hit count, top 3).
9. Appliance / keyword browse (top 3 for "show me dishwasher parts").

Each stage pushes a `Citation` with a label that encodes which stage fired
(`Part catalog`, `Part catalog (OEM …)`, `Part catalog (supersedes …)`,
`Part catalog (keyword match)`, …) — so the downstream UI and the reviewer can
see *why* a row came back.

Why rule-based and not vector search today: the catalog has ~4 parts and
~2 compat rows; a regex pipeline is faster, cheaper, 100% explainable, and
doesn't ship with a mystery failure mode. The abstraction is small
(`retrieveExact` takes a string, returns structured results + citations), so
swapping a vector store in later is a single-file change.

---

## 7. Data model

`catalog.json` is the seed data. Three top-level collections:

- `parts[]` — identity + commerce + keywords + symptoms + install steps +
  `replaces[]` + `relatedParts[]` + `repairStories[]` + `questions[]`.
- `compatibilities[]` — `(model, partNumber, compatible, note)` rows. Compat is
  its own table because real PartSelect ships millions of (model × part) edges.
- `repairGuides[]` — brand/appliance-scoped guides with strict and flexible
  match keys, a steps list, `likelyParts[]`, and `commonQuestions[]`.

**Human-element signals** live on individual repair stories, not at the part
level, because "difficulty" and "time" are subjective. The card aggregates
them at render time (`aggregateInstallSignal` does a majority vote on
difficulty / time, unions the tool list, and reports `sampleCount` so the UI
can say "Really Easy · Less than 15 mins · No tools required · from 6 customer
stories").

---

## 8. Extensibility path

What a reviewer might reasonably ask — each has a clean extension point:

| Ask | Where you'd touch |
|---|---|
| Add a new tool to the agent (e.g. `check_inventory`) | Register in `lib/llm/runAgent.ts` + implement behind `retrieveExact`-style pure function |
| Replace static catalog with a real DB | Swap body of `retrieveExact.ts`; everything downstream is unchanged |
| Move from keyword to vector retrieval | Same: `retrieveExact` is the only caller that cares |
| Add a new intent / card kind | Add to `ChatIntent`, add a `build*Block` fn, map in `buildBlocksFromRetrieval` + `app/page.tsx` |
| Add a new OOS category | One regex group in `OOS_GROUPS` |
| Tighten accuracy on a query class | Add a golden case to `scripts/goldenCases.mjs` |

---

## 9. Evaluation

`scripts/goldenCases.mjs` hits the live dev server with 17 scripted turns
covering all seven query categories. Each case asserts three things:

1. Did the right card render? (`blocks[].type` / `.kind`)
2. Did the right citation appear? (`citations[].id`)
3. Did the reply contain the right facts / refusal wording?

Every change has to leave all 17 green. Concretely covered today:

- Install by PS number (+ aggregated experience + ≥ 2 customer stories)
- Price & stock → product block with price
- Compat: both ok and warn cases, by-model and by-part+model
- Ice maker symptom → repair guide
- OEM crosslookup, supersession reverse lookup
- Reverse diagnosis (ranked candidates)
- Browse by appliance
- Three clarify shapes (no model, no part, vague repair)
- Malformed PS number → no_evidence
- Four OOS shapes (unrelated topic, code request, prompt injection, other appliance)

---

## 10. What's next

Two planned items, ordered by ROI on the "agentic architecture" evaluation axis:

1. **Session memory** — the turn boundary is currently stateless. A clarify turn
   ("what model?") and the user's follow-up ("WDT780SAEM1") should stitch into
   a single resolved answer. Plan: accept `history[]` on `/api/chat`, carry
   forward the last known `part` / `model`, and let the LLM see prior tool
   results. This is the single biggest upgrade to "this is an agent, not a
   search bar".
2. **Architecture documentation** — this file, plus a one-pager on the tool
   contract and the rule → vector migration path.

Deliberately **not** on the near-term roadmap: more UI polish (related-parts
rails, social-proof on product cards, Q&A sections on repair cards). They're
valuable but they score on the interface axis we're already strong on.
