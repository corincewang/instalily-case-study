# PartSelect Chat Agent — Case Study

A chat agent for the PartSelect e-commerce platform, scoped to **refrigerator and dishwasher parts**. Built with Next.js 16, OpenAI function calling, and a rule-based retrieval layer with live PartSelect.com fallback.

---

## Quick start

```bash
cd web
npm install
cp .env.example .env.local   # then add your OpenAI key (required for /api/chat)
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Environment variables

Create `web/.env.local`:

```env
# Required — catalog turns use GPT function calling + streaming replies.
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
│   ├── formatCatalogReply.ts # Reply text helper for LLM consistency guard
│   ├── agentTools.ts         # Tool name constants + ToolTraceEntry type
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

The suite asserts that the LLM chose the correct specific tool where applicable (e.g. `check_compatibility` not `catalog_search`). Requires `OPENAI_API_KEY` in the server environment.

---

## Architecture overview

```
User message
    │
    ▼
[OOS gate]  ← deterministic, runs before LLM — cannot be prompt-injected
    │ in-scope
    ├── LLM path (OPENAI_API_KEY required)
    │   Tool loop (≤ 6 rounds):
    │     normalize_part_number → lookup_part | check_compatibility |
    │     get_install_guide | search_by_symptom | catalog_search (fallback)
    │   If lookup_part fails → fetch_part_page (live PartSelect.com via Jina.ai)
    │
    ▼
[buildBlocksFromRetrieval]
[OOS / clarify override]    ← if blocks empty
JSON { reply, blocks, citations, suggested_actions, tool_trace, used_llm }
```

**Two invariants:**
1. The LLM never invents product facts — tool outputs + `retrieveExact` are the source of truth for cards.
2. Small shortcuts (greeting ack, glossary FAQs) avoid an LLM round but do not run the full catalog agent.

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
