import { z } from "zod";
import type { LlmUsage } from "./provider.js";

/** One model's prices in micro-dollars per million tokens (the shape of `AI_PRICING`). */
export const ModelPriceSchema = z.strictObject({
  inputPerMTokMicros: z.number().nonnegative(),
  cachedInputPerMTokMicros: z.number().nonnegative(),
  outputPerMTokMicros: z.number().nonnegative(),
});
export type ModelPrice = z.infer<typeof ModelPriceSchema>;

/** What cost accounting needs: the pricing table and the price of one web search call. */
export type LlmCostConfig = {
  pricing: Record<string, ModelPrice>;
  webSearchCostPerCallMicros: number | null;
};

/**
 * Cost of one call in micro-dollars (TECHNICAL_SPEC §8.1):
 * `(input − cached) × input price + cached × cached price + output × output price
 * + webSearchCalls × search price`, rounded to a whole micro. Null when the model has no entry in
 * the pricing table, or when web searches were made and no search price is configured.
 */
export function computeCostMicros(
  usage: LlmUsage,
  pricing: Record<string, ModelPrice>,
  perSearchMicros: number | null,
): number | null {
  const price = pricing[usage.model];
  if (price === undefined) return null;
  if (usage.webSearchCalls > 0 && perSearchMicros === null) return null;

  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const uncached = usage.inputTokens - cached;
  const tokenMicros =
    (uncached * price.inputPerMTokMicros +
      cached * price.cachedInputPerMTokMicros +
      usage.outputTokens * price.outputPerMTokMicros) /
    1_000_000;
  return Math.round(tokenMicros + usage.webSearchCalls * (perSearchMicros ?? 0));
}
