import type { CatalogContext } from "../loadCatalog";
import { formatCatalogReplyFromRetrieval, formatMissingCompatPairReply } from "../formatCatalogReply";
import type { RetrievalResult, SessionContext } from "../retrieveExact";
import { modelTokenInCurrentMessage } from "../retrieveExact";

function applyConsistencyGuard(
  replyText: string,
  retrieval: RetrievalResult,
  userMessage: string
): string {
  const hasContent = !!(
    retrieval.guide ??
    retrieval.part ??
    retrieval.compatibility ??
    (retrieval.candidates && retrieval.candidates.length > 0)
  );
  const llmSaysMiss =
    /couldn.t\s+match|couldn.t\s+find|no\s+match|not\s+find|unable\s+to\s+find|nothing\s+in|didn.t\s+find|not\s+found\s+in|no\s+result/i.test(
      replyText
    );
  return hasContent && llmSaysMiss
    ? formatCatalogReplyFromRetrieval(retrieval, userMessage)
    : replyText;
}

function replyImpliesNeedModelNumber(reply: string): boolean {
  return (
    /\b(need|what'?s|what is|share|tell me|give me).{0,55}\b(appliance\s+)?model\b/i.test(reply) ||
    /\bmodel number\b.{0,25}\b(first|before|to proceed|to check)\b/i.test(reply) ||
    /\bI need your.{0,35}\bmodel\b/i.test(reply) ||
    /\bbefore I can check.{0,45}\bmodel\b/i.test(reply) ||
    /\bcan check that.{0,55}\bmodel\b/i.test(reply)
  );
}

function applyCompatAskModelMismatchGuard(
  replyText: string,
  retrieval: RetrievalResult,
  userMessage: string,
  sessionContext: SessionContext | undefined
): string {
  if (!retrieval.compatibility || !replyImpliesNeedModelNumber(replyText)) {
    return replyText;
  }
  const c = retrieval.compatibility;
  const pn = retrieval.part?.partNumber ?? c.partNumber;
  const verdict = c.compatible ? "compatible" : "not compatible";
  const hasSessionModel = !!sessionContext?.model?.trim();
  const deicticModel =
    /\b(my|this|the)\s+model\b/i.test(userMessage) ||
    /\b(that|same)\s+appliance\b/i.test(userMessage);
  const opener =
    hasSessionModel || deicticModel
      ? `I'm using the appliance model we already established in this chat for that check — the exact tag is on the compatibility card. `
      : `The compatibility card already shows the model tag and verdict for this check. `;
  return (
    `${opener}` +
    `**${pn}** is **${verdict}** with that appliance; see the card below for the full breakdown.`
  );
}

function isBareModelOnlyMessage(msg: string): boolean {
  const t = msg.trim();
  if (t.length < 6 || t.length > 24) return false;
  return /^[A-Z]{2,}\d{2,}[A-Z0-9-]*$/i.test(t);
}

async function applyMissingCompatPairGuard(
  replyText: string,
  retrieval: RetrievalResult,
  userMessage: string,
  catalogCtx: CatalogContext
): Promise<string> {
  if (!retrieval.part || retrieval.compatibility) return replyText;
  if (!modelTokenInCurrentMessage(userMessage)) return replyText;
  const uncertain =
    /\b(couldn.?t confirm|could not confirm|can.?t confirm|unable to confirm|not able to confirm|couldn.?t\s+(verify|tell)|can.?t\s+(verify|tell)|not sure|verify on partselect)\b/i.test(
      replyText
    );
  if (!isBareModelOnlyMessage(userMessage) && !uncertain) return replyText;
  return formatMissingCompatPairReply(retrieval.part.partNumber, catalogCtx);
}

export async function applyRetrievalReplyGuards(
  replyText: string,
  retrieval: RetrievalResult,
  userMessage: string,
  sessionContext: SessionContext | undefined,
  catalogCtx: CatalogContext
): Promise<string> {
  let out = applyConsistencyGuard(replyText, retrieval, userMessage);
  out = applyCompatAskModelMismatchGuard(out, retrieval, userMessage, sessionContext);
  out = await applyMissingCompatPairGuard(out, retrieval, userMessage, catalogCtx);
  return out;
}
