import { describe, expect, it } from "vitest";
import { EnvError, loadEnv } from "./env.js";

const PRICING = {
  "gpt-6-luna": {
    inputPerMTokMicros: 1_000_000,
    cachedInputPerMTokMicros: 100_000,
    outputPerMTokMicros: 4_000_000,
  },
};
const KEY = Buffer.alloc(32, 7).toString("base64");

/** A complete, valid private-mode environment (fictional values). */
function privateEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    APP_MODE: "private",
    PUBLIC_BASE_URL: "https://offerbound.example",
    DATABASE_URL: "postgresql://offerbound:local-dev-only@localhost:5432/offerbound",
    OWNER_EMAIL: "Owner@Example.com",
    GOOGLE_CLIENT_ID: "client-id.example",
    GOOGLE_CLIENT_SECRET: "client-secret-placeholder",
    TOKEN_ENCRYPTION_KEY: KEY,
    OPENAI_API_KEY: "openai-key-placeholder",
    AI_PRICING: JSON.stringify(PRICING),
    AI_WEB_SEARCH_COST_PER_CALL_MICROS: "10000",
    ...extra,
  };
}

function demoEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    APP_MODE: "demo",
    PUBLIC_BASE_URL: "https://demo.offerbound.example",
    DATABASE_URL: "postgresql://offerbound:local-dev-only@localhost:5432/offerbound_demo",
    ...extra,
  };
}

function failure(raw: NodeJS.ProcessEnv): EnvError {
  try {
    loadEnv(raw);
  } catch (error) {
    expect(error).toBeInstanceOf(EnvError);
    return error as EnvError;
  }
  throw new Error("loadEnv did not throw");
}

describe("loadEnv", () => {
  it("private mode lists every missing required variable", () => {
    const error = failure({ APP_MODE: "private" });
    expect(error.missing).toEqual(
      expect.arrayContaining([
        "PUBLIC_BASE_URL",
        "DATABASE_URL",
        "OWNER_EMAIL",
        "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET",
        "TOKEN_ENCRYPTION_KEY",
        "OPENAI_API_KEY",
        "AI_PRICING",
        "AI_WEB_SEARCH_COST_PER_CALL_MICROS",
      ]),
    );
    expect(error.forbidden).toEqual([]);
    expect(error.message).toContain("OWNER_EMAIL");
  });

  it("treats a missing or unknown APP_MODE as missing and still lists the rest", () => {
    expect(failure({}).missing).toEqual(expect.arrayContaining(["APP_MODE", "OWNER_EMAIL"]));
    expect(failure({ APP_MODE: "staging" }).missing).toContain("APP_MODE");
  });

  it("treats empty strings as unset", () => {
    expect(failure(privateEnv({ OWNER_EMAIL: "" })).missing).toEqual(["OWNER_EMAIL"]);
  });

  it("loads a complete private environment", () => {
    const env = loadEnv(privateEnv());
    expect(env.mode).toBe("private");
    expect(env.ownerEmail).toBe("owner@example.com");
    expect(env.google).toEqual({
      clientId: "client-id.example",
      clientSecret: "client-secret-placeholder",
    });
    expect(env.tokenEncryptionKey?.length).toBe(32);
    expect(env.openai?.apiKey).toBe("openai-key-placeholder");
    expect(env.aiPricing).toEqual(PRICING);
    expect(env.webSearchCostPerCallMicros).toBe(10_000);
  });

  it("demo mode refuses OWNER_EMAIL, GOOGLE_*, TOKEN_ENCRYPTION_KEY and OPENAI_*", () => {
    const error = failure(
      demoEnv({
        OWNER_EMAIL: "owner@example.com",
        GOOGLE_CLIENT_ID: "x",
        GOOGLE_CLIENT_SECRET: "y",
        TOKEN_ENCRYPTION_KEY: KEY,
        OPENAI_API_KEY: "z",
        OPENAI_MODEL_TRIAGE: "m",
        OPENAI_REASONING_EFFORT_SEARCH: "high",
      }),
    );
    expect(error.forbidden.sort()).toEqual(
      [
        "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET",
        "OPENAI_API_KEY",
        "OPENAI_MODEL_TRIAGE",
        "OPENAI_REASONING_EFFORT_SEARCH",
        "OWNER_EMAIL",
        "TOKEN_ENCRYPTION_KEY",
      ].sort(),
    );
    expect(error.missing).toEqual([]);
  });

  it("demo mode also refuses the variables TECHNICAL_SPEC 3.4 marks as absent", () => {
    const error = failure(
      demoEnv({
        AI_PRICING: "{}",
        AI_WEB_SEARCH_COST_PER_CALL_MICROS: "1",
        GMAIL_BACKFILL_SINCE: "2026-09-01",
        GMAIL_SYNC_INTERVAL_MINUTES: "5",
        SEARCH_MAX_ROUNDS: "3",
        SEARCH_MAX_TOOL_CALLS_PER_ROUND: "40",
        BACKUP_RETENTION_DAYS: "14",
      }),
    );
    expect(error.forbidden).toHaveLength(7);
  });

  it("demo mode boots with forbidden variables set to empty strings (compose passes blanks)", () => {
    const env = loadEnv(
      demoEnv({
        OPENAI_API_KEY: "",
        OWNER_EMAIL: "  ",
        GOOGLE_CLIENT_ID: "",
        OPENAI_MODEL_RANK: "",
        AI_PRICING: "",
        GMAIL_BACKFILL_SINCE: "",
      }),
    );
    expect(env.mode).toBe("demo");
    expect(env.openai).toBeNull();
    expect(env.ownerEmail).toBeNull();
  });

  it("demo mode refuses the same variables once they hold a value (AC-16.1)", () => {
    const error = failure(
      demoEnv({
        OPENAI_API_KEY: "x",
        OWNER_EMAIL: "o@example.com",
        GOOGLE_CLIENT_ID: "y",
        OPENAI_MODEL_RANK: "m",
      }),
    );
    expect(error.forbidden.sort()).toEqual(
      ["GOOGLE_CLIENT_ID", "OPENAI_API_KEY", "OPENAI_MODEL_RANK", "OWNER_EMAIL"].sort(),
    );
  });

  it("demo mode refuses any GOOGLE_ variable, not only the client id and secret", () => {
    expect(failure(demoEnv({ GOOGLE_PROJECT: "x" })).forbidden).toEqual(["GOOGLE_PROJECT"]);
  });

  it("a variable that is not set at all is not forbidden", () => {
    expect(loadEnv(demoEnv({ OPENAI_API_KEY: undefined })).mode).toBe("demo");
  });

  it("loads demo mode without any secrets", () => {
    const env = loadEnv(
      demoEnv({ TRUSTED_PROXY_IPS: "10.0.0.0/8, 192.168.0.5", LOG_LEVEL: "warn" }),
    );
    expect(env.mode).toBe("demo");
    expect(env.ownerEmail).toBeNull();
    expect(env.google).toBeNull();
    expect(env.tokenEncryptionKey).toBeNull();
    expect(env.openai).toBeNull();
    expect(env.aiPricing).toEqual({});
    expect(env.webSearchCostPerCallMicros).toBeNull();
    expect(env.trustedProxyIps).toEqual(["10.0.0.0/8", "192.168.0.5"]);
    expect(env.logLevel).toBe("warn");
  });

  it("rejects a TOKEN_ENCRYPTION_KEY that does not decode to 32 bytes", () => {
    for (const bad of [
      Buffer.alloc(16, 1).toString("base64"),
      Buffer.alloc(33, 1).toString("base64"),
      "not base64 at all!",
    ]) {
      const error = failure(privateEnv({ TOKEN_ENCRYPTION_KEY: bad }));
      expect(error.invalid).toEqual(["TOKEN_ENCRYPTION_KEY"]);
      expect(error.message).not.toContain(bad);
    }
  });

  it("applies the defaults", () => {
    const env = loadEnv(privateEnv());
    expect(env.userTimezone).toBe("America/Monterrey");
    expect(env.homeCountry).toBe("MX");
    expect(env.gmailBackfillSince).toBe("2026-09-01");
    expect(env.gmailSyncIntervalMinutes).toBe(5);
    expect(env.searchMaxToolCallsPerRound).toBe(40);
    expect(env.searchMaxRounds).toBe(3);
    expect(env.backupRetentionDays).toBe(14);
    expect(env.logLevel).toBe("info");
    expect(env.port).toBe(3000);
    expect(env.trustedProxyIps).toEqual(["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]);
    expect(env.openai?.models).toEqual({
      triage: "gpt-6-luna",
      extract: "gpt-6-luna",
      rank: "gpt-6-luna",
      search: "gpt-6-luna",
      parse_report: "gpt-6-luna",
      cv_profile: "gpt-6-luna",
    });
    expect(env.openai?.efforts).toEqual({
      triage: "low",
      extract: "low",
      rank: "low",
      search: "medium",
      parse_report: "low",
      cv_profile: "low",
    });
  });

  it("reads per-purpose models and efforts; parse_report follows extract", () => {
    const env = loadEnv(
      privateEnv({
        OPENAI_MODEL_EXTRACT: "model-extract",
        OPENAI_MODEL_PROFILE: "model-profile",
        OPENAI_REASONING_EFFORT_EXTRACT: "high",
        OPENAI_REASONING_EFFORT_SEARCH: "xhigh",
        OPENAI_REASONING_EFFORT_PROFILE: "none",
      }),
    );
    expect(env.openai?.models.extract).toBe("model-extract");
    expect(env.openai?.models.parse_report).toBe("model-extract");
    expect(env.openai?.models.cv_profile).toBe("model-profile");
    expect(env.openai?.efforts.extract).toBe("high");
    expect(env.openai?.efforts.parse_report).toBe("high");
    expect(env.openai?.efforts.search).toBe("xhigh");
    expect(env.openai?.efforts.cv_profile).toBe("none");
  });

  it("reads overrides for the optional settings", () => {
    const env = loadEnv(
      privateEnv({
        USER_TIMEZONE: "Europe/Madrid",
        HOME_COUNTRY: "es",
        GMAIL_BACKFILL_SINCE: "2026-10-01",
        GMAIL_SYNC_INTERVAL_MINUTES: "10",
        SEARCH_MAX_TOOL_CALLS_PER_ROUND: "20",
        SEARCH_MAX_ROUNDS: "2",
        BACKUP_RETENTION_DAYS: "7",
      }),
    );
    expect(env.userTimezone).toBe("Europe/Madrid");
    expect(env.homeCountry).toBe("ES");
    expect(env.gmailBackfillSince).toBe("2026-10-01");
    expect(env.gmailSyncIntervalMinutes).toBe(10);
    expect(env.searchMaxToolCallsPerRound).toBe(20);
    expect(env.searchMaxRounds).toBe(2);
    expect(env.backupRetentionDays).toBe(7);
  });

  it("names every invalid variable without echoing its value", () => {
    const error = failure(
      privateEnv({
        PUBLIC_BASE_URL: "not a url",
        OWNER_EMAIL: "no-at-sign",
        USER_TIMEZONE: "Mars/Olympus",
        GMAIL_BACKFILL_SINCE: "2026-13-45",
        GMAIL_SYNC_INTERVAL_MINUTES: "0",
        LOG_LEVEL: "loud",
        AI_PRICING: "{not json",
        AI_WEB_SEARCH_COST_PER_CALL_MICROS: "-1",
        OPENAI_REASONING_EFFORT_RANK: "extreme",
        TRUSTED_PROXY_IPS: "10.0.0.0/99",
      }),
    );
    expect(error.invalid.sort()).toEqual(
      [
        "PUBLIC_BASE_URL",
        "OWNER_EMAIL",
        "USER_TIMEZONE",
        "GMAIL_BACKFILL_SINCE",
        "GMAIL_SYNC_INTERVAL_MINUTES",
        "LOG_LEVEL",
        "AI_PRICING",
        "AI_WEB_SEARCH_COST_PER_CALL_MICROS",
        "OPENAI_REASONING_EFFORT_RANK",
        "TRUSTED_PROXY_IPS",
      ].sort(),
    );
    expect(error.message).not.toContain("Mars/Olympus");
  });

  it("reads PORT in both modes and rejects values that are not a valid port", () => {
    expect(loadEnv(privateEnv({ PORT: "8080" })).port).toBe(8080);
    expect(loadEnv(demoEnv({ PORT: "4000" })).port).toBe(4000);
    expect(loadEnv(demoEnv()).port).toBe(3000);
    for (const bad of ["abc", "0", "65536", "30.5", "-1"]) {
      expect(failure(privateEnv({ PORT: bad })).invalid, bad).toEqual(["PORT"]);
    }
  });

  it("rejects AI_PRICING entries with missing or negative prices", () => {
    const error = failure(
      privateEnv({ AI_PRICING: JSON.stringify({ m: { inputPerMTokMicros: 1 } }) }),
    );
    expect(error.invalid).toEqual(["AI_PRICING"]);
  });
});
