import OpenAI from "openai";
import { observeOpenAI } from "@langfuse/openai";

import { isLangfuseConfigured, startLangfuseOtelOnce } from "./otel";

/** Mirrors Langfuse `observeOpenAI` options used by this app. */
export type LangfuseTraceOpts = {
  traceName?: string;
  sessionId?: string;
  userId?: string;
  tags?: string[];
  generationName?: string;
  generationMetadata?: Record<string, unknown>;
};

/**
 * Returns a Langfuse-instrumented OpenAI client when LANGFUSE_* env is set; otherwise the plain client.
 */
export function createTrackedOpenAI(apiKey: string, opts?: LangfuseTraceOpts): OpenAI {
  const base = new OpenAI({ apiKey });
  if (!isLangfuseConfigured()) return base;

  startLangfuseOtelOnce();

  return observeOpenAI(base, {
    traceName: opts?.traceName ?? "partselect",
    sessionId: opts?.sessionId,
    userId: opts?.userId,
    tags: opts?.tags ?? ["partselect"],
    generationName: opts?.generationName,
    generationMetadata: opts?.generationMetadata,
  });
}
