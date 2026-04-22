/**
 * Generates vector embeddings for all repairStories and FAQ questions in
 * catalog.json and writes the result to data/embeddings.json.
 *
 * Usage:  OPENAI_API_KEY=sk-... node scripts/generate-embeddings.mjs
 *
 * Model: text-embedding-3-small (1536 dims, cheap ~$0.02 per 1M tokens)
 * Estimated cost for 20 parts × ~8 chunks = ~160 chunks ≈ < $0.001
 */

import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH  = join(__dirname, "../data/catalog.json");
const OUTPUT_PATH   = join(__dirname, "../data/embeddings.json");
const MODEL         = "text-embedding-3-small";
const BATCH_SIZE    = 20; // embed N texts per API call

const apiKey = process.env.OPENAI_API_KEY?.trim();
if (!apiKey) {
  console.error("Error: OPENAI_API_KEY env var is required.");
  process.exit(1);
}

// ── Build text chunks from catalog ──────────────────────────────────────────

const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
const chunks = [];

for (const part of catalog.parts) {
  const partLabel = `${part.partNumber} — ${part.title} (${part.applianceFamily})`;

  // Repair stories / install reviews
  for (const story of (part.repairStories ?? [])) {
    chunks.push({
      id:        `${part.partNumber}::story::${story.id}`,
      partNumber: part.partNumber,
      kind:      "repair_story",
      text:      `Part: ${partLabel}\nTitle: ${story.title}\n${story.body}`,
      meta: {
        title:       story.title,
        author:      story.author ?? null,
        helpfulYes:  story.helpfulYes ?? 0,
        helpfulTotal: story.helpfulTotal ?? 0,
      },
    });
  }

  // FAQ questions + answers
  for (const qa of (part.questions ?? [])) {
    chunks.push({
      id:        `${part.partNumber}::qa::${qa.id}`,
      partNumber: part.partNumber,
      kind:      "faq",
      text:      `Part: ${partLabel}\nQ: ${qa.question}\nA: ${qa.answer}`,
      meta: {
        question:    qa.question,
        answer:      qa.answer,
        helpfulCount: qa.helpfulCount ?? 0,
      },
    });
  }

  // Part description (if available)
  if (part.installSteps) {
    chunks.push({
      id:        `${part.partNumber}::install`,
      partNumber: part.partNumber,
      kind:      "install",
      text:      `Part: ${partLabel}\nInstall: ${part.installSteps}`,
      meta: { title: `Install ${part.partNumber}` },
    });
  }
}

console.log(`Built ${chunks.length} chunks from ${catalog.parts.length} parts.\n`);

// ── Embed in batches ──────────────────────────────────────────────────────────

async function embedBatch(texts) {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: MODEL, input: texts }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${err}`);
  }
  const data = await res.json();
  return data.data.map((d) => d.embedding); // array of float32 arrays
}

const embedded = [];
for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
  const batch = chunks.slice(i, i + BATCH_SIZE);
  process.stdout.write(`  Embedding batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(chunks.length / BATCH_SIZE)} (${batch.length} chunks)...`);
  const vectors = await embedBatch(batch.map((c) => c.text));
  for (let j = 0; j < batch.length; j++) {
    embedded.push({ ...batch[j], embedding: vectors[j] });
  }
  console.log(" ✓");
  if (i + BATCH_SIZE < chunks.length) await new Promise((r) => setTimeout(r, 200));
}

// ── Write output ─────────────────────────────────────────────────────────────

const output = {
  model:     MODEL,
  dims:      embedded[0]?.embedding?.length ?? 1536,
  createdAt: new Date().toISOString(),
  chunks:    embedded,
};

writeFileSync(OUTPUT_PATH, JSON.stringify(output));
console.log(`\n✅ Wrote ${embedded.length} embeddings to data/embeddings.json`);
console.log(`   Model: ${MODEL} | Dims: ${output.dims}`);
