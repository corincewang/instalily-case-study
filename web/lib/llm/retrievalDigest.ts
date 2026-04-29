import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import type { RetrievalResult } from "../retrieveExact";

const DIGEST_MAX_CHARS = 8000;

/** Shown at the top of the injected context message so the model treats it as server-side evidence. */
const CONTEXT_HEADER =
  "[SERVER_RETRIEVAL_CONTEXT — canonical snapshot aligned with UI cards this turn; use these ids/part numbers for catalog-backed statements; do not invent SKUs outside this JSON.]";

/**
 * Compact JSON for prompt injection so the final assistant generation sees the same
 * structured anchors as {@link RetrievalResult} used for UI blocks (cards/citations).
 */
export function serializeCanonicalRetrievalDigest(r: RetrievalResult): string | null {
  const hasAnything = !!(
    r.part ??
    r.compatibility ??
    r.guide ??
    (r.candidates && r.candidates.length > 0) ??
    (r.searchResults && r.searchResults.length > 0)
  );
  if (!hasAnything) return null;

  const snapshot: Record<string, unknown> = {};

  if (r.part) {
    snapshot.primary_part = {
      id: r.part.id,
      partNumber: r.part.partNumber,
      title: r.part.title,
      applianceFamily: r.part.applianceFamily,
    };
  }

  if (r.compatibility) {
    snapshot.compatibility = {
      id: r.compatibility.id,
      partNumber: r.compatibility.partNumber,
      model: r.compatibility.model,
      compatible: r.compatibility.compatible,
    };
  }

  if (r.guide) {
    snapshot.repair_guide = {
      id: r.guide.id,
      topic: (r.guide as { topic?: string }).topic,
      appliance: (r.guide as { appliance?: string }).appliance,
    };
  }

  if (r.candidates && r.candidates.length > 0) {
    snapshot.candidate_parts = r.candidates.slice(0, 5).map((c) => ({
      id: c.part.id,
      partNumber: c.part.partNumber,
      title: c.part.title,
    }));
  }

  if (r.searchResults && r.searchResults.length > 0) {
    snapshot.search_hits = r.searchResults.slice(0, 5).map((s) => ({
      id: s.part.id,
      partNumber: s.part.partNumber,
      title: s.part.title,
    }));
  }

  if (r.citations.length > 0) {
    snapshot.citation_ids = r.citations.map((c) => ({ id: c.id, source: c.source }));
  }

  let raw = JSON.stringify(snapshot);
  if (raw.length > DIGEST_MAX_CHARS) {
    raw = raw.slice(0, DIGEST_MAX_CHARS - 20) + "\n…(truncated)";
  }
  return raw;
}

/**
 * Appends a dedicated **`user`-role message** carrying the canonical retrieval JSON so it lives
 * explicitly inside `messages` (document-RAG style), after tool outputs and before the final
 * assistant generation — same anchors as UI blocks.
 */
export function appendRetrievalContextMessage(
  messages: ChatCompletionMessageParam[],
  retrieval: RetrievalResult
): ChatCompletionMessageParam[] {
  const digest = serializeCanonicalRetrievalDigest(retrieval);
  if (!digest) return messages;

  const content = `${CONTEXT_HEADER}\n\n${digest}`;
  return [
    ...messages,
    {
      role: "user",
      content,
    },
  ];
}
