import { describe, expect, it } from "vitest";
import { computeCostMicros, type ModelPrice } from "./pricing.js";
import type { LlmUsage } from "./provider.js";

const usage = (over: Partial<LlmUsage> = {}): LlmUsage => ({
  model: "m1",
  inputTokens: 1_000_000,
  cachedInputTokens: 200_000,
  outputTokens: 100_000,
  webSearchCalls: 2,
  latencyMs: 10,
  requestId: null,
  ...over,
});

const pricing: Record<string, ModelPrice> = {
  m1: {
    inputPerMTokMicros: 1_250_000,
    cachedInputPerMTokMicros: 125_000,
    outputPerMTokMicros: 10_000_000,
  },
};

describe("computeCostMicros", () => {
  it("computes 2,045,000 micros for 1,000,000 input (200,000 cached), 100,000 output and 2 searches", () => {
    expect(computeCostMicros(usage(), pricing, 10_000)).toBe(2_045_000);
  });

  it("returns null cost for a model missing from AI_PRICING", () => {
    expect(computeCostMicros(usage({ model: "unlisted" }), pricing, 10_000)).toBeNull();
  });

  it("returns null when web searches were made but no per-search price is configured", () => {
    expect(computeCostMicros(usage(), pricing, null)).toBeNull();
    expect(computeCostMicros(usage({ webSearchCalls: 0 }), pricing, null)).toBe(2_025_000);
  });

  it("rounds to whole micros and never counts more cached tokens than input tokens", () => {
    const small = usage({
      inputTokens: 3,
      cachedInputTokens: 1,
      outputTokens: 1,
      webSearchCalls: 0,
    });
    // 2 × 1.25 + 1 × 0.125 + 1 × 10 = 12.625 micros
    expect(computeCostMicros(small, pricing, null)).toBe(13);
    const odd = usage({
      inputTokens: 10,
      cachedInputTokens: 50,
      outputTokens: 0,
      webSearchCalls: 0,
    });
    expect(computeCostMicros(odd, pricing, null)).toBe(1); // cached capped at 10: 10 × 0.125 = 1.25
  });
});
