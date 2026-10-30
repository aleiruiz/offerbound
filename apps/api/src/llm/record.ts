import type { Prisma } from "@prisma/client";
import type { LlmPurpose } from "@offerbound/contracts";
import { computeCostMicros, type LlmCostConfig } from "./pricing.js";
import type { LlmCallCtx, LlmUsage } from "./provider.js";

/** Anything with a Prisma `llmCall` delegate: the client or a transaction client. */
export type LlmCallDb = {
  llmCall: { create(args: { data: Prisma.LlmCallUncheckedCreateInput }): Promise<unknown> };
};

/** The part of a logger this module uses (Fastify's `log.warn(obj, msg)` fits). */
export type WarnLogger = { warn(fields: Record<string, unknown>, message?: string): void };

export type LlmCallRecord = {
  purpose: LlmPurpose;
  usage: LlmUsage;
  status: "ok" | "error";
  errorCode: string | null;
} & LlmCallCtx;

/**
 * Writes one `llm_call` row for a finished call, successful or not (AC-17.2). The cost is computed
 * from the pricing table; a model missing from it stores a null cost and logs a warning with the
 * model name only. Prompts and outputs are never recorded.
 */
export async function recordLlmCall(
  db: LlmCallDb,
  rec: LlmCallRecord,
  cost: LlmCostConfig,
  log?: WarnLogger,
): Promise<void> {
  const { usage } = rec;
  const costMicros = computeCostMicros(usage, cost.pricing, cost.webSearchCostPerCallMicros);
  if (costMicros === null) log?.warn({ model: usage.model }, "llm call has no known cost");
  await db.llmCall.create({
    data: {
      purpose: rec.purpose,
      model: usage.model,
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      outputTokens: usage.outputTokens,
      webSearchCalls: usage.webSearchCalls,
      costMicros: costMicros === null ? null : BigInt(costMicros),
      latencyMs: Math.round(usage.latencyMs),
      status: rec.status,
      errorCode: rec.errorCode,
      requestId: usage.requestId,
      messageId: rec.messageId ?? null,
      searchRunId: rec.searchRunId ?? null,
    },
  });
}
