import type { LlmConfig } from "./provider.js";

/** Config used by LLM tests. Not imported by production code. */
export const TEST_LLM_CONFIG: LlmConfig = {
  apiKey: "test-key",
  models: {
    triage: "model-triage",
    extract: "model-extract",
    rank: "model-rank",
    search: "model-search",
    parse_report: "model-extract",
    cv_profile: "model-profile",
  },
  efforts: {
    triage: "low",
    extract: "low",
    rank: "low",
    search: "medium",
    parse_report: "low",
    cv_profile: "low",
  },
  pricing: {
    "model-extract": {
      inputPerMTokMicros: 1_250_000,
      cachedInputPerMTokMicros: 125_000,
      outputPerMTokMicros: 10_000_000,
    },
    "model-search": {
      inputPerMTokMicros: 1_250_000,
      cachedInputPerMTokMicros: 125_000,
      outputPerMTokMicros: 10_000_000,
    },
  },
  webSearchCostPerCallMicros: 10_000,
  searchMaxToolCallsPerRound: 40,
};
