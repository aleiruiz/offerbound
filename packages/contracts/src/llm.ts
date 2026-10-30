import { z } from "zod";
import {
  CompPeriodSchema,
  EmailCategorySchema,
  InterviewKindSchema,
  SenioritySchema,
  TriStateSchema,
  WorkModeSchema,
} from "./enums.js";

// LLM output schemas are sent to the model as OpenAI strict JSON schemas:
// every object is a z.strictObject, every key is required (nullable, never optional),
// and nothing carries a length or range limit. clampExtraction and clampRanking enforce the
// limits after parsing.

// --- Triage (TECHNICAL_SPEC §5.4) ---

export const TriageItemSchema = z.strictObject({
  id: z.string(),
  jobRelated: z.boolean(),
  confidence: z.number(),
});
export type TriageItem = z.infer<typeof TriageItemSchema>;

export const TriageResultSchema = z.strictObject({ results: z.array(TriageItemSchema) });
export type TriageResult = z.infer<typeof TriageResultSchema>;

// --- Extraction (TECHNICAL_SPEC §5.5) ---

export const ExtractionLeadSchema = z.strictObject({
  company: z.string(),
  title: z.string(),
  jobUrl: z.string().nullable(),
  locationText: z.string().nullable(),
  country: z.string().nullable(),
  workMode: WorkModeSchema,
  compensationText: z.string().nullable(),
  postedAt: z.string().nullable(),
});
export type ExtractionLead = z.infer<typeof ExtractionLeadSchema>;

export const ExtractionSchema = z.strictObject({
  category: EmailCategorySchema,
  confidence: z.number(),
  company: z.strictObject({ name: z.string(), websiteDomain: z.string().nullable() }).nullable(),
  role: z.strictObject({ title: z.string(), seniority: SenioritySchema.nullable() }).nullable(),
  jobUrl: z.string().nullable(),
  contact: z
    .strictObject({
      name: z.string().nullable(),
      email: z.string().nullable(),
      title: z.string().nullable(),
      isAgency: z.boolean(),
    })
    .nullable(),
  interview: z
    .strictObject({
      kind: InterviewKindSchema,
      startsAt: z.string().nullable(),
      endsAt: z.string().nullable(),
      timezone: z.string().nullable(),
      meetingUrl: z.string().nullable(),
      schedulingUrl: z.string().nullable(),
      location: z.string().nullable(),
      interviewers: z.array(z.string()),
    })
    .nullable(),
  assessment: z
    .strictObject({ deadline: z.string().nullable(), url: z.string().nullable() })
    .nullable(),
  leads: z.array(ExtractionLeadSchema),
  summary: z.string(),
  language: z.enum(["en", "es", "other"]),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

// --- Ranking (TECHNICAL_SPEC §7.4) ---

export const CompensationSchema = z.strictObject({
  min: z.number().nullable(),
  max: z.number().nullable(),
  currency: z.string().nullable(),
  period: CompPeriodSchema.nullable(),
  isEstimate: z.boolean(),
  basis: z.string().nullable(),
});
export type Compensation = z.infer<typeof CompensationSchema>;

export const RankingSchema = z.strictObject({
  leadRef: z.string(),
  track: z.string().nullable(),
  fitScore: z.number(),
  fitReason: z.string(),
  gaps: z.array(z.string()),
  seniority: SenioritySchema,
  workMode: WorkModeSchema,
  remoteFromHomeCountry: TriStateSchema,
  sponsorship: TriStateSchema,
  relocation: TriStateSchema,
  compensation: CompensationSchema,
  eligible: TriStateSchema,
  eligibilityReason: z.string().nullable(),
});
export type Ranking = z.infer<typeof RankingSchema>;

export const RankingsSchema = z.strictObject({ rankings: z.array(RankingSchema) });
export type Rankings = z.infer<typeof RankingsSchema>;

// --- Search (TECHNICAL_SPEC §7.3) ---

export const SearchLeadSchema = RankingSchema.extend({
  company: z.string(),
  companyDomain: z.string().nullable(),
  title: z.string(),
  jobUrl: z.string().nullable(),
  locationText: z.string().nullable(),
  country: z.string().nullable(),
  postedAt: z.string().nullable(),
  evidenceUrls: z.array(z.string()),
});
export type SearchLead = z.infer<typeof SearchLeadSchema>;

export const SearchResultSchema = z.strictObject({
  leads: z.array(SearchLeadSchema),
  notes: z.string(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

// --- Report parsing (TECHNICAL_SPEC §7.6) ---

export const ReportLeadSchema = z.strictObject({
  company: z.string(),
  companyDomain: z.string().nullable(),
  title: z.string(),
  jobUrl: z.string().nullable(),
  locationText: z.string().nullable(),
  country: z.string().nullable(),
  workMode: WorkModeSchema,
  compensationText: z.string().nullable(),
  postedAt: z.string().nullable(),
  seniority: SenioritySchema,
});
export type ReportLead = z.infer<typeof ReportLeadSchema>;

export const ParseReportResultSchema = z.strictObject({ leads: z.array(ReportLeadSchema) });
export type ParseReportResult = z.infer<typeof ParseReportResultSchema>;

// --- CV profile (TECHNICAL_SPEC §7.5) ---

export const CvProfileSchema = z.strictObject({
  headline: z.string(),
  yearsExperience: z.number().nullable(),
  coreSkills: z.array(z.string()),
  secondarySkills: z.array(z.string()),
  domains: z.array(z.string()),
  recentRoles: z.array(
    z.strictObject({
      title: z.string(),
      company: z.string(),
      years: z.string().nullable(),
    }),
  ),
  leadership: z.string().nullable(),
  languages: z.array(z.string()),
  location: z.string().nullable(),
  workAuthorization: z.string().nullable(),
});
export type CvProfile = z.infer<typeof CvProfileSchema>;

// --- Helpers ---

export const SUMMARY_MAX_CHARS = 140;
export const FIT_REASON_MAX_CHARS = 160;
export const MAX_GAPS = 3;

const clampNumber = (value: number, min: number, max: number): number => {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
};

/** Truncates by code point so a surrogate pair is never cut in half. */
const truncate = (value: string, max: number): string => {
  if (value.length <= max) return value;
  return Array.from(value).slice(0, max).join("");
};

/** Applies the limits the strict LLM schema cannot express: summary ≤ 140 characters, confidence 0..1. */
export function clampExtraction(e: Extraction): Extraction {
  return {
    ...e,
    summary: truncate(e.summary, SUMMARY_MAX_CHARS),
    confidence: clampNumber(e.confidence, 0, 1),
  };
}

/** Applies the limits the strict LLM schema cannot express: fit score 0..100 (whole number), reason ≤ 160 characters, ≤ 3 gaps. */
export function clampRanking(r: Ranking): Ranking {
  return {
    ...r,
    fitScore: Math.round(clampNumber(r.fitScore, 0, 100)),
    fitReason: truncate(r.fitReason, FIT_REASON_MAX_CHARS),
    gaps: r.gaps.slice(0, MAX_GAPS),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Keywords whose value is a map of name → schema (the names are not keywords).
const SCHEMA_MAP_KEYWORDS = new Set(["properties", "$defs", "definitions", "patternProperties"]);
// Keywords whose value is data, not a schema.
const DATA_KEYWORDS = new Set(["required", "enum", "const", "default", "examples", "example"]);

function isStrictNode(node: unknown): boolean {
  if (Array.isArray(node)) return node.every(isStrictNode);
  if (!isRecord(node)) return true;
  if ("maxLength" in node) return false;

  const properties = node["properties"];
  if (isRecord(properties)) {
    if (node["additionalProperties"] !== false) return false;
    const required = node["required"];
    if (!Array.isArray(required)) return false;
    const requiredKeys = new Set(required);
    if (!Object.keys(properties).every((key) => requiredKeys.has(key))) return false;
  } else if (node["type"] === "object") {
    // An object with no declared properties is open-ended; strict mode cannot describe it.
    if (node["additionalProperties"] !== false) return false;
  }

  return Object.entries(node).every(([keyword, value]) => {
    if (DATA_KEYWORDS.has(keyword)) return true;
    if (SCHEMA_MAP_KEYWORDS.has(keyword) && isRecord(value)) {
      return Object.values(value).every(isStrictNode);
    }
    return isStrictNode(value);
  });
}

/**
 * True when a JSON schema satisfies the OpenAI strict structured-output rules this app relies on:
 * the root is an object, every object has `additionalProperties: false` and lists every key in
 * `required`, and no `maxLength` appears anywhere.
 */
export function isOpenAiStrictSchema(jsonSchema: unknown): boolean {
  if (!isRecord(jsonSchema) || jsonSchema["type"] !== "object") return false;
  return isStrictNode(jsonSchema);
}
