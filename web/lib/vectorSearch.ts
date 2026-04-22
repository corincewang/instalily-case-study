/**
 * In-memory vector search over data/embeddings.json.
 *
 * The embeddings file is generated once by scripts/generate-embeddings.mjs.
 * At runtime we load it once (module-level singleton) and do brute-force
 * cosine similarity — fast enough for hundreds of chunks, zero infra.
 */

type EmbeddingChunk = {
  id: string;
  partNumber: string;
  kind: "repair_story" | "faq" | "install";
  text: string;
  embedding: number[];
  meta: Record<string, unknown>;
};

type EmbeddingsFile = {
  model: string;
  dims: number;
  createdAt: string;
  chunks: EmbeddingChunk[];
};

export type SearchResult = {
  id: string;
  partNumber: string;
  kind: EmbeddingChunk["kind"];
  text: string;
  score: number;
  meta: Record<string, unknown>;
};

// ── Lazy singleton ────────────────────────────────────────────────────────────

let _chunks: EmbeddingChunk[] | null = null;

function getChunks(): EmbeddingChunk[] {
  if (_chunks) return _chunks;
  try {
    // Dynamic require at runtime — embeddings.json may not exist at build time.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const data = require("../data/embeddings.json") as EmbeddingsFile;
    _chunks = data.chunks ?? [];
  } catch {
    _chunks = [];
  }
  return _chunks;
}

// ── Math ──────────────────────────────────────────────────────────────────────

function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function magnitude(v: number[]): number {
  let sum = 0;
  for (const x of v) sum += x * x;
  return Math.sqrt(sum);
}

function cosineSimilarity(a: number[], b: number[]): number {
  const magA = magnitude(a);
  const magB = magnitude(b);
  if (magA === 0 || magB === 0) return 0;
  return dotProduct(a, b) / (magA * magB);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Embed a query string via OpenAI, then return the top-K most similar chunks.
 * Returns an empty array if embeddings.json doesn't exist or API key is missing.
 */
export async function semanticSearch(
  query: string,
  topK = 4,
  minScore = 0.30
): Promise<SearchResult[]> {
  const chunks = getChunks();
  if (chunks.length === 0) return [];

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return [];

  // Embed the query
  let queryVec: number[];
  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: "text-embedding-3-small", input: query }),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { data: { embedding: number[] }[] };
    queryVec = data.data[0].embedding;
  } catch {
    return [];
  }

  // Brute-force cosine similarity
  const scored = chunks.map((chunk) => ({
    id:         chunk.id,
    partNumber: chunk.partNumber,
    kind:       chunk.kind,
    text:       chunk.text,
    score:      cosineSimilarity(queryVec, chunk.embedding),
    meta:       chunk.meta,
  }));

  return scored
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/** Synchronous check: returns true if embeddings are loaded and non-empty. */
export function hasEmbeddings(): boolean {
  return getChunks().length > 0;
}
