import { describe, expect, it } from "vitest";
import { QUEUE_CONFIG, QUEUES } from "./queues.js";

describe("QUEUE_CONFIG", () => {
  it("retries triage and extraction with a 30 s base backoff (TECHNICAL_SPEC §8.3)", () => {
    for (const name of [QUEUES.emailTriage, QUEUES.emailExtract]) {
      expect(QUEUE_CONFIG[name].retryDelay, name).toBe(30);
      expect(QUEUE_CONFIG[name].retryLimit, name).toBe(4);
    }
  });
});
