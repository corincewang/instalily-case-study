# PartSelect Chat Agent — Case Study

A chat agent for the PartSelect e-commerce platform, scoped to **refrigerator and dishwasher parts**. Built with Next.js 16, OpenAI function calling, and a rule-based retrieval layer with live PartSelect.com fallback.

---

## Quick start

```bash
cd web
npm install
cp .env.example .env.local   # then add your OpenAI key (optional — see below)
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Environment variables

Create `web/.env.local`:

```env
# Required for the LLM path (GPT function calling + reasoning replies).
# If omitted the agent runs in deterministic mode — all 7 query categories
# still work; the reply text is rule-generated instead of LLM-written.
OPENAI_API_KEY=sk-...

# Optional — defaults to gpt-4o-mini if not set.
OPENAI_MODEL=gpt-4o-mini
```

---

## Project layout

```
web/
├── app/
│   ├── page.tsx              # Chat UI (React, Tailwind)
│   └── api/chat/route.ts     # POST /api/chat — main agent endpoint
├── lib/
│   ├── retrieveExact.ts      # Rule-based hybrid retrieval (catalog lookup)
│   ├── buildChatBlocks.ts    # Intent classification → UI block builder
│   ├── formatCatalogReply.ts # Deterministic reply fallback (no-LLM path)
│   ├── agentTools.ts         # Tool names + deterministic tool chain
│   ├── toolExecutor.ts       # Sync tool dispatcher (used by LLM loop)
│   ├── tools/
│   │   ├── normalizePartNumber.ts  # Extract PS##### from free text
│   │   ├── lookupPart.ts           # Fetch a single part from local catalog
│   │   ├── checkCompatibility.ts   # Part × model compatibility check
│   │   ├── getInstallGuide.ts      # Install steps + customer experience
│   │   ├── searchBySymptom.ts      # Symptom → candidate parts
│   │   └── fetchPartPage.ts        # Live fetch from PartSelect via Jina.ai
│   └── llm/
│       ├── runChatAgent.ts   # OpenAI tool-call loop (LLM path)
│       ├── openaiTools.ts    # Tool schemas for function calling
│       └── systemPrompt.ts   # Agent standing instructions
├── data/
│   └── catalog.json          # Seeded data: 4 parts, compat rows, repair guides
└── scripts/
    └── goldenCases.mjs       # End-to-end golden test suite
```

---

## Running the golden tests

The golden test suite covers all 7 query categories against the live `/api/chat` endpoint. Start the dev server first, then:

```bash
cd web
npm run test:golden
```

The suite runs 19 test cases including:
- Install by PS number (`PS11752778`)
- Compatibility check (`WDT780SAEM1` — not compatible, `WRS325SDHZ` — compatible)
- Symptom → repair guide (Whirlpool ice maker)
- OEM / supersession lookup
- Reverse diagnosis (candidate parts)
- Browse / keyword search
- Out-of-scope refusal (4 shapes)
- Clarification prompts (3 shapes)
- Multi-turn context carry-forward

When `OPENAI_API_KEY` is set, the suite also asserts that the LLM chose the correct specific tool for each query (e.g. `check_compatibility` not `catalog_search`).

---

## Architecture overview

```
User message
    │
    ▼
[OOS gate]  ← deterministic, runs before LLM — cannot be prompt-injected
    │ in-scope
    ├── LLM path (OPENAI_API_KEY set)
    │   Tool loop (≤ 6 rounds):
    │     normalize_part_number → lookup_part | check_compatibility |
    │     get_install_guide | search_by_symptom | catalog_search (fallback)
    │   If lookup_part fails → fetch_part_page (live PartSelect.com via Jina.ai)
    │
    ├── Deterministic path (no API key)
    │   Same tools via heuristic routing — identical golden test coverage
    │
    ▼
[buildBlocksFromRetrieval]  ← shared by both paths
[OOS / clarify override]    ← if blocks empty
JSON { reply, blocks, citations, suggested_actions, tool_trace, used_llm }
```

**Two invariants:**
1. The LLM never invents product facts — retrieval is the source of truth.
2. The system works end-to-end without an API key (deterministic path passes all golden tests).

**Live fetch fallback:** For any PS number not in the local catalog, `fetch_part_page` fetches the real PartSelect product page via [Jina.ai](https://jina.ai) and returns price, stock, and description. The local catalog acts as a rich cache for a small set of seed parts; the live tool makes the agent answer-capable across PartSelect's full catalog.

---

## The three case study queries

| Query | Expected response |
|---|---|
| How can I install part number PS11752778? | Install guide card (amber) with steps + 6 customer stories |
| Is this part compatible with my WDT780SAEM1 model? | Compatibility card (red) — WDT780SAEM1 is a dishwasher, PS11752778 is a refrigerator part |
| The ice maker on my Whirlpool fridge is not working. How can I fix it? | Repair guide card + 2 candidate parts (ice maker assembly + water inlet valve) |

---

## Design decisions

See [DESIGN.md](./DESIGN.md) for architecture rationale, tradeoffs, and extensibility notes.

**Scaling path:** Replace `retrieveExact.ts` with a vector search index (Pinecone / pgvector) over the full PartSelect catalog. The `buildBlocksFromRetrieval` interface is stable — retrieval and rendering are fully decoupled.
