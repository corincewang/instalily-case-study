import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeSDK } from "@opentelemetry/sdk-node";

let sdk: NodeSDK | null = null;
let spanProcessor: LangfuseSpanProcessor | null = null;

/** Both keys required by Langfuse Cloud; optional self-hosted overrides via LANGFUSE_BASE_URL. */
export function isLangfuseConfigured(): boolean {
  return !!(
    process.env.LANGFUSE_SECRET_KEY?.trim() &&
    process.env.LANGFUSE_PUBLIC_KEY?.trim()
  );
}

/**
 * Langfuse JS v5 traces OpenAI via OTEL. Start once per Node process when Langfuse env is set.
 */
export function startLangfuseOtelOnce(): void {
  if (sdk || !isLangfuseConfigured()) return;

  const baseUrl =
    process.env.LANGFUSE_BASE_URL?.trim() || "https://cloud.langfuse.com";

  spanProcessor = new LangfuseSpanProcessor({
    baseUrl,
  });

  sdk = new NodeSDK({
    spanProcessors: [spanProcessor],
  });
  sdk.start();
}

/** Short-lived serverless handlers should flush so spans reach Langfuse before freeze. */
export async function flushLangfuseSpans(): Promise<void> {
  await spanProcessor?.forceFlush();
}
