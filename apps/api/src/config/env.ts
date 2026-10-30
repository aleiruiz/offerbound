import { isIP } from "node:net";
import { z } from "zod";
import type { LlmPurpose } from "@offerbound/contracts";

/** TECHNICAL_SPEC §3.4. `loadEnv` is the only place that reads environment variables. */

export const EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export type ModelPrice = {
  inputPerMTokMicros: number;
  cachedInputPerMTokMicros: number;
  outputPerMTokMicros: number;
};

export type Env = {
  mode: "private" | "demo";
  publicBaseUrl: string;
  databaseUrl: string;
  ownerEmail: string | null;
  userTimezone: string;
  homeCountry: string;
  google: { clientId: string; clientSecret: string } | null;
  tokenEncryptionKey: Buffer | null;
  openai: {
    apiKey: string;
    models: Record<LlmPurpose, string>;
    efforts: Record<LlmPurpose, Effort>;
  } | null;
  aiPricing: Record<string, ModelPrice>;
  webSearchCostPerCallMicros: number | null;
  gmailBackfillSince: string;
  gmailSyncIntervalMinutes: number;
  searchMaxToolCallsPerRound: number;
  searchMaxRounds: number;
  backupRetentionDays: number;
  trustedProxyIps: string[];
  logLevel: string;
};

/**
 * Thrown by `loadEnv`. Lists variable names only, never values, so it is safe to print.
 * `invalid` is an addition to the brief's `{ missing, forbidden }`: variables that are present
 * but malformed (bad key length, bad JSON, bad number).
 */
export class EnvError extends Error {
  constructor(
    readonly missing: string[],
    readonly forbidden: string[],
    readonly invalid: string[] = [],
  ) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing: ${missing.join(", ")}`);
    if (forbidden.length > 0) parts.push(`not allowed in this mode: ${forbidden.join(", ")}`);
    if (invalid.length > 0) parts.push(`invalid: ${invalid.join(", ")}`);
    super(`Invalid environment (${parts.join("; ")})`);
    this.name = "EnvError";
  }
}

const DEFAULTS = {
  userTimezone: "America/Monterrey",
  homeCountry: "MX",
  gmailBackfillSince: "2026-09-01",
  gmailSyncIntervalMinutes: 5,
  searchMaxToolCallsPerRound: 40,
  searchMaxRounds: 3,
  backupRetentionDays: 14,
  logLevel: "info",
  model: "gpt-6-luna",
  // Docker private ranges (TECHNICAL_SPEC §3.4).
  trustedProxyIps: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
} as const;

/** Purposes with their own variables; `parse_report` is derived from `extract`. */
const OWN_PURPOSES: Exclude<LlmPurpose, "parse_report">[] = [
  "triage",
  "extract",
  "rank",
  "search",
  "cv_profile",
];

const DEFAULT_EFFORTS: Record<(typeof OWN_PURPOSES)[number], Effort> = {
  triage: "low",
  extract: "low",
  rank: "low",
  search: "medium",
  cv_profile: "low",
};

/** Env var suffix per purpose. Report parsing uses the extraction model and effort (§8.2). */
const PURPOSE_SUFFIX = {
  triage: "TRIAGE",
  extract: "EXTRACT",
  rank: "RANK",
  search: "SEARCH",
  cv_profile: "PROFILE",
} as const;
const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"];

const PriceSchema = z.object({
  inputPerMTokMicros: z.number().int().nonnegative(),
  cachedInputPerMTokMicros: z.number().int().nonnegative(),
  outputPerMTokMicros: z.number().int().nonnegative(),
});
const PricingSchema = z.record(z.string().min(1), PriceSchema);

/** Variables that must be absent in demo mode (TECHNICAL_SPEC §3.4, AC-16.1). */
const DEMO_FORBIDDEN_EXACT = [
  "OWNER_EMAIL",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "TOKEN_ENCRYPTION_KEY",
  "AI_PRICING",
  "AI_WEB_SEARCH_COST_PER_CALL_MICROS",
  "GMAIL_BACKFILL_SINCE",
  "GMAIL_SYNC_INTERVAL_MINUTES",
  "SEARCH_MAX_TOOL_CALLS_PER_ROUND",
  "SEARCH_MAX_ROUNDS",
  "BACKUP_RETENTION_DAYS",
];

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

function isIpOrCidr(value: string): boolean {
  const [address, prefix, ...rest] = value.split("/");
  if (rest.length > 0 || address === undefined) return false;
  const version = isIP(address);
  if (version === 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (version === 4 ? 32 : 128);
}

function decodeKey(value: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const key = Buffer.from(value, "base64");
  return key.length === 32 ? key : null;
}

/**
 * Validates the process environment. Throws `EnvError` listing every missing, forbidden and
 * malformed variable at once, so a deploy fails with one complete message.
 */
export function loadEnv(raw: NodeJS.ProcessEnv): Env {
  const missing: string[] = [];
  const forbidden: string[] = [];
  const invalid: string[] = [];

  /** Empty strings count as unset (compose and Coolify pass empty values for blank fields). */
  const read = (name: string): string | undefined => {
    const value = raw[name]?.trim();
    return value === undefined || value === "" ? undefined : value;
  };

  const modeRaw = read("APP_MODE");
  // An absent or unknown mode is reported, then the rest is checked as private so one run lists everything.
  if (modeRaw !== "private" && modeRaw !== "demo") missing.push("APP_MODE");

  const required = (name: string): string | undefined => {
    const value = read(name);
    if (value === undefined) missing.push(name);
    return value;
  };

  const optional = <T>(name: string, fallback: T, parse: (value: string) => T | undefined): T => {
    const value = read(name);
    if (value === undefined) return fallback;
    const parsed = parse(value);
    if (parsed === undefined) {
      invalid.push(name);
      return fallback;
    }
    return parsed;
  };

  const positiveInt = (value: string): number | undefined => {
    if (!/^\d+$/.test(value)) return undefined;
    const n = Number(value);
    return Number.isSafeInteger(n) && n > 0 ? n : undefined;
  };

  // Shared by both modes.
  const publicBaseUrl = required("PUBLIC_BASE_URL");
  if (publicBaseUrl !== undefined) {
    try {
      const url = new URL(publicBaseUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("scheme");
    } catch {
      invalid.push("PUBLIC_BASE_URL");
    }
  }
  const databaseUrl = required("DATABASE_URL");

  const userTimezone = optional("USER_TIMEZONE", DEFAULTS.userTimezone, (v) =>
    isTimeZone(v) ? v : undefined,
  );
  const homeCountry = optional("HOME_COUNTRY", DEFAULTS.homeCountry, (v) =>
    /^[A-Za-z]{2}$/.test(v) ? v.toUpperCase() : undefined,
  );
  const logLevel = optional("LOG_LEVEL", DEFAULTS.logLevel, (v) =>
    LOG_LEVELS.includes(v) ? v : undefined,
  );
  const trustedProxyIps = optional<string[]>(
    "TRUSTED_PROXY_IPS",
    [...DEFAULTS.trustedProxyIps],
    (v) => {
      const entries = v
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "");
      return entries.length > 0 && entries.every(isIpOrCidr) ? entries : undefined;
    },
  );

  // Settings that are private-only; in demo mode they are forbidden and take their defaults.
  const demo = modeRaw === "demo";
  const privateOptional = <T>(
    name: string,
    fallback: T,
    parse: (value: string) => T | undefined,
  ) => (demo ? fallback : optional(name, fallback, parse));

  const gmailBackfillSince = privateOptional(
    "GMAIL_BACKFILL_SINCE",
    DEFAULTS.gmailBackfillSince,
    (v) => (isCalendarDate(v) ? v : undefined),
  );
  const gmailSyncIntervalMinutes = privateOptional(
    "GMAIL_SYNC_INTERVAL_MINUTES",
    DEFAULTS.gmailSyncIntervalMinutes,
    positiveInt,
  );
  const searchMaxToolCallsPerRound = privateOptional(
    "SEARCH_MAX_TOOL_CALLS_PER_ROUND",
    DEFAULTS.searchMaxToolCallsPerRound,
    positiveInt,
  );
  const searchMaxRounds = privateOptional(
    "SEARCH_MAX_ROUNDS",
    DEFAULTS.searchMaxRounds,
    positiveInt,
  );
  const backupRetentionDays = privateOptional(
    "BACKUP_RETENTION_DAYS",
    DEFAULTS.backupRetentionDays,
    positiveInt,
  );

  if (demo) {
    for (const name of Object.keys(raw)) {
      const forbiddenName = DEMO_FORBIDDEN_EXACT.includes(name) || name.startsWith("OPENAI_");
      if (forbiddenName && read(name) !== undefined) forbidden.push(name);
    }
    if (missing.length > 0 || forbidden.length > 0 || invalid.length > 0) {
      throw new EnvError(missing, forbidden, invalid);
    }
    return {
      mode: "demo",
      publicBaseUrl: publicBaseUrl as string,
      databaseUrl: databaseUrl as string,
      ownerEmail: null,
      userTimezone,
      homeCountry,
      google: null,
      tokenEncryptionKey: null,
      openai: null,
      aiPricing: {},
      webSearchCostPerCallMicros: null,
      gmailBackfillSince,
      gmailSyncIntervalMinutes,
      searchMaxToolCallsPerRound,
      searchMaxRounds,
      backupRetentionDays,
      trustedProxyIps,
      logLevel,
    };
  }

  // Private mode.
  let ownerEmail = required("OWNER_EMAIL");
  if (ownerEmail !== undefined) {
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) ownerEmail = ownerEmail.toLowerCase();
    else invalid.push("OWNER_EMAIL");
  }

  const clientId = required("GOOGLE_CLIENT_ID");
  const clientSecret = required("GOOGLE_CLIENT_SECRET");

  const keyRaw = required("TOKEN_ENCRYPTION_KEY");
  let tokenEncryptionKey: Buffer | null = null;
  if (keyRaw !== undefined) {
    tokenEncryptionKey = decodeKey(keyRaw);
    if (tokenEncryptionKey === null) invalid.push("TOKEN_ENCRYPTION_KEY");
  }

  const apiKey = required("OPENAI_API_KEY");

  const models = {} as Record<LlmPurpose, string>;
  const efforts = {} as Record<LlmPurpose, Effort>;
  for (const purpose of OWN_PURPOSES) {
    const suffix = PURPOSE_SUFFIX[purpose];
    models[purpose] = optional(`OPENAI_MODEL_${suffix}`, DEFAULTS.model, (v) => v);
    efforts[purpose] = optional(
      `OPENAI_REASONING_EFFORT_${suffix}`,
      DEFAULT_EFFORTS[purpose],
      (v) => ((EFFORTS as readonly string[]).includes(v) ? (v as Effort) : undefined),
    );
  }
  models.parse_report = models.extract;
  efforts.parse_report = efforts.extract;

  let aiPricing: Record<string, ModelPrice> = {};
  const pricingRaw = required("AI_PRICING");
  if (pricingRaw !== undefined) {
    try {
      aiPricing = PricingSchema.parse(JSON.parse(pricingRaw));
    } catch {
      invalid.push("AI_PRICING");
    }
  }

  let webSearchCostPerCallMicros: number | null = null;
  const webSearchRaw = required("AI_WEB_SEARCH_COST_PER_CALL_MICROS");
  if (webSearchRaw !== undefined) {
    if (/^\d+$/.test(webSearchRaw) && Number.isSafeInteger(Number(webSearchRaw))) {
      webSearchCostPerCallMicros = Number(webSearchRaw);
    } else {
      invalid.push("AI_WEB_SEARCH_COST_PER_CALL_MICROS");
    }
  }

  if (missing.length > 0 || invalid.length > 0) throw new EnvError(missing, forbidden, invalid);

  return {
    mode: "private",
    publicBaseUrl: publicBaseUrl as string,
    databaseUrl: databaseUrl as string,
    ownerEmail: ownerEmail as string,
    userTimezone,
    homeCountry,
    google: { clientId: clientId as string, clientSecret: clientSecret as string },
    tokenEncryptionKey,
    openai: { apiKey: apiKey as string, models, efforts },
    aiPricing,
    webSearchCostPerCallMicros,
    gmailBackfillSince,
    gmailSyncIntervalMinutes,
    searchMaxToolCallsPerRound,
    searchMaxRounds,
    backupRetentionDays,
    trustedProxyIps,
    logLevel,
  };
}
