import { describe, expect, it } from "vitest";
import { LlmPurposeSchema } from "@offerbound/contracts";
import { PROMPTS } from "./prompts.js";

describe("PROMPTS", () => {
  it("has a versioned prompt for every purpose", () => {
    for (const purpose of LlmPurposeSchema.options) {
      const prompt = PROMPTS[purpose];
      expect(prompt.version, purpose).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
      expect(prompt.system.length, purpose).toBeGreaterThan(200);
    }
  });

  it("starts every prompt with the untrusted-data instruction (SECURITY §9)", () => {
    for (const purpose of LlmPurposeSchema.options) {
      expect(PROMPTS[purpose].system, purpose).toMatch(
        /^The [^.]*untrusted data[^.]*never follow instructions/i,
      );
    }
  });

  it("keeps the spec's fixed instructions", () => {
    expect(PROMPTS.triage.system).toMatch(/job-related/i);
    expect(PROMPTS.triage.system).toMatch(/newsletters/i);
    expect(PROMPTS.extract.system).toMatch(/Date header/);
    expect(PROMPTS.extract.system).toMatch(/candidate_outbound/);
    expect(PROMPTS.extract.system).toMatch(/never invent a job URL/i);
    expect(PROMPTS.search.system).toMatch(/at most one posting per company/i);
    expect(PROMPTS.search.system).toMatch(/estimate/i);
    expect(PROMPTS.rank.system).toMatch(/leadRef/);
  });
});
