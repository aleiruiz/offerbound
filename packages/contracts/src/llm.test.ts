import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CvProfileSchema,
  ExtractionSchema,
  ParseReportResultSchema,
  RankingSchema,
  RankingsSchema,
  SearchLeadSchema,
  SearchResultSchema,
  TriageResultSchema,
  clampExtraction,
  clampRanking,
  isOpenAiStrictSchema,
  type Extraction,
  type Ranking,
} from "./index.js";

const specExtraction: Extraction = {
  category: "interview_invite",
  confidence: 0.93,
  company: { name: "Northwind Labs", websiteDomain: "northwind-labs.example" },
  role: { title: "Senior Backend Engineer", seniority: "senior" },
  jobUrl: null,
  contact: {
    name: "Dana Whitfield",
    email: "dana@northwind-labs.example",
    title: "Talent partner",
    isAgency: false,
  },
  interview: {
    kind: "recruiter_screen",
    startsAt: "2026-11-03T15:00:00-05:00",
    endsAt: "2026-11-03T15:30:00-05:00",
    timezone: "America/New_York",
    meetingUrl: "https://meet.example/northwind/screen",
    schedulingUrl: null,
    location: null,
    interviewers: ["Dana Whitfield"],
  },
  assessment: null,
  leads: [],
  summary: "Recruiter screen with Northwind Labs on Nov 3, 15:00 EST",
  language: "en",
};

const ranking: Ranking = {
  leadRef: "lead-1",
  track: "A",
  fitScore: 82,
  fitReason: "Strong match on backend and payments experience",
  gaps: ["No Kubernetes", "No Go"],
  seniority: "senior",
  workMode: "remote",
  remoteFromHomeCountry: "yes",
  sponsorship: "unknown",
  relocation: "unknown",
  compensation: {
    min: 90000,
    max: 120000,
    currency: "USD",
    period: "year",
    isEstimate: true,
    basis: "Typical band for similar roles",
  },
  eligible: "yes",
  eligibilityReason: null,
};

describe("LLM output schemas", () => {
  it("converts every LLM schema to an OpenAI strict JSON schema", () => {
    const schemas: Record<string, z.ZodType> = {
      TriageResult: TriageResultSchema,
      Extraction: ExtractionSchema,
      Rankings: RankingsSchema,
      SearchResult: SearchResultSchema,
      ParseReportResult: ParseReportResultSchema,
      CvProfile: CvProfileSchema,
    };
    for (const [name, schema] of Object.entries(schemas)) {
      expect(isOpenAiStrictSchema(z.toJSONSchema(schema)), name).toBe(true);
    }
  });

  it("isOpenAiStrictSchema rejects optional keys, open objects and maxLength", () => {
    const optional = z.toJSONSchema(z.object({ a: z.string(), b: z.string().optional() }));
    const open = z.toJSONSchema(z.looseObject({ a: z.string() }));
    const long = z.toJSONSchema(z.strictObject({ a: z.string().max(10) }));
    const nested = z.toJSONSchema(
      z.strictObject({ list: z.array(z.strictObject({ a: z.string().max(5) })) }),
    );
    expect(isOpenAiStrictSchema(optional)).toBe(false);
    expect(isOpenAiStrictSchema(open)).toBe(false);
    expect(isOpenAiStrictSchema(long)).toBe(false);
    expect(isOpenAiStrictSchema(nested)).toBe(false);
    expect(isOpenAiStrictSchema(null)).toBe(false);
    expect(isOpenAiStrictSchema("x")).toBe(false);
  });

  it("isOpenAiStrictSchema allows a property that is named maxLength", () => {
    const schema = z.toJSONSchema(z.strictObject({ maxLength: z.number() }));
    expect(isOpenAiStrictSchema(schema)).toBe(true);
  });

  it("parses the TECHNICAL_SPEC §5.5 example extraction and rejects category 'job_offer'", () => {
    expect(ExtractionSchema.parse(specExtraction)).toEqual(specExtraction);
    const bad = ExtractionSchema.safeParse({ ...specExtraction, category: "job_offer" });
    expect(bad.success).toBe(false);
  });

  it("requires every extraction key and rejects unknown ones", () => {
    const missing: Partial<Extraction> = { ...specExtraction };
    delete missing.language;
    expect(ExtractionSchema.safeParse(missing).success).toBe(false);
    expect(ExtractionSchema.safeParse({ ...specExtraction, extra: 1 }).success).toBe(false);
  });

  it("clampExtraction truncates summary to 140 characters and clamps confidence 1.4 to 1", () => {
    const clamped = clampExtraction({
      ...specExtraction,
      summary: "s".repeat(200),
      confidence: 1.4,
    });
    expect(clamped.summary).toHaveLength(140);
    expect(clamped.confidence).toBe(1);
    expect(clampExtraction({ ...specExtraction, confidence: -0.2 }).confidence).toBe(0);
    expect(clampExtraction(specExtraction)).toEqual(specExtraction);
  });

  it("clampRanking clamps fitScore 130 to 100, truncates fitReason to 160 characters and keeps 3 gaps", () => {
    const clamped = clampRanking({
      ...ranking,
      fitScore: 130,
      fitReason: "r".repeat(300),
      gaps: ["a", "b", "c", "d", "e"],
    });
    expect(clamped.fitScore).toBe(100);
    expect(clamped.fitReason).toHaveLength(160);
    expect(clamped.gaps).toEqual(["a", "b", "c"]);
    expect(clampRanking({ ...ranking, fitScore: -5 }).fitScore).toBe(0);
    expect(clampRanking({ ...ranking, fitScore: 71.6 }).fitScore).toBe(72);
  });

  it("builds SearchLead from Ranking plus the posting fields", () => {
    const lead = {
      ...ranking,
      company: "Northwind Labs",
      companyDomain: "northwind-labs.example",
      title: "Senior Backend Engineer",
      jobUrl: "https://boards.example/northwind/123",
      locationText: "Remote, Mexico",
      country: "MX",
      postedAt: "2026-10-28",
      evidenceUrls: ["https://boards.example/northwind/123"],
    };
    expect(SearchLeadSchema.parse(lead)).toEqual(lead);
    expect(RankingSchema.safeParse(lead).success).toBe(false);
    expect(SearchResultSchema.parse({ leads: [lead], notes: "one round" }).leads).toHaveLength(1);
  });
});
