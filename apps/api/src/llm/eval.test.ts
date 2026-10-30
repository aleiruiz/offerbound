import { describe, expect, it } from "vitest";
import type { EmailCategory, EmailFixture, Extraction } from "@offerbound/contracts";
import {
  EVAL_BAR,
  formatReport,
  meetsBar,
  scoreEval,
  type EvalCase,
  type EvalReport,
} from "./eval.js";
import { runEvalCases } from "./eval-run.js";
import { FakeLlmProvider } from "./fake-provider.js";
import { LlmError } from "./provider.js";
import { loadEmailFixtures } from "../fixtures/emails.js";

const FIXTURE_TIMEZONE = "America/Monterrey";

function fixture(
  id: string,
  expected: Partial<EmailFixture["expected"]> = {},
  extra: Partial<EmailFixture> = {},
): EmailFixture {
  return {
    id,
    threadId: `thr-${id}`,
    internalDate: "2026-09-10T12:00:00.000Z",
    labels: ["INBOX"],
    headers: { from: "a@x.example", to: ["owner@owner.example"], subject: "s", date: "d" },
    snippet: "",
    demo: false,
    expected: {
      triage: "job_related",
      category: "rejection",
      company: "Northwind Example",
      role: null,
      outcome: "applied",
      ...expected,
    },
    llm: { triage: null, extraction: null },
    ...extra,
  };
}

function extraction(category: EmailCategory, over: Partial<Extraction> = {}): Extraction {
  return {
    category,
    confidence: 0.9,
    company: { name: "Northwind Example", websiteDomain: null },
    role: null,
    jobUrl: null,
    contact: null,
    interview: null,
    assessment: null,
    leads: [],
    summary: "s",
    language: "en",
    ...over,
  };
}

const interview = (startsAt: string | null): Extraction["interview"] => ({
  kind: "recruiter_screen",
  startsAt,
  endsAt: null,
  timezone: null,
  meetingUrl: null,
  schedulingUrl: null,
  location: null,
  interviewers: [],
});

const REPORT_AT_BAR: EvalReport = {
  scored: 100,
  perCategory: [],
  jobRelatedRecall: { hits: 98, total: 100, rate: 0.98 },
  categoryAccuracy: { hits: 90, total: 100, rate: 0.9 },
  companyMatch: { hits: 90, total: 100, rate: 0.9 },
  startIcs: { hits: 19, total: 20, rate: 0.95 },
  startText: { hits: 17, total: 20, rate: 0.85 },
};

describe("scoreEval", () => {
  it("computes per-category precision and recall from a synthetic result set", () => {
    const cases: EvalCase[] = [
      // Two rejections: one right, one called an offer.
      { fixture: fixture("r1"), triageJobRelated: true, extraction: extraction("rejection") },
      { fixture: fixture("r2"), triageJobRelated: true, extraction: extraction("offer") },
      // An offer, right.
      {
        fixture: fixture("o1", { category: "offer" }),
        triageJobRelated: true,
        extraction: extraction("offer"),
      },
      // A decoy that triage drops: a true "not_job_related".
      {
        fixture: fixture("d1", { triage: "triaged_out", category: null, company: null }),
        triageJobRelated: false,
        extraction: null,
      },
      // A rejection triage dropped: counted as a miss for rejection.
      { fixture: fixture("r3"), triageJobRelated: false, extraction: null },
      // Skipped by a rule before any model call: left out of the scores.
      {
        fixture: fixture("s1", { triage: "skipped", category: null, company: null }),
        triageJobRelated: false,
        extraction: null,
      },
    ];

    const report = scoreEval(cases);
    const of = (category: EmailCategory) => report.perCategory.find((c) => c.category === category);

    expect(report.scored).toBe(5);
    // rejection: expected r1, r2, r3; predicted only r1 (r2 became an offer, r3 was dropped).
    expect(of("rejection")).toMatchObject({
      expected: 3,
      predicted: 1,
      truePositives: 1,
      precision: 1,
      recall: 1 / 3,
    });
    // offer: expected o1; predicted r2 and o1.
    expect(of("offer")).toMatchObject({
      expected: 1,
      predicted: 2,
      truePositives: 1,
      precision: 0.5,
      recall: 1,
    });
    // not_job_related: expected d1; predicted d1 and r3 (dropped by triage).
    expect(of("not_job_related")).toMatchObject({
      expected: 1,
      predicted: 2,
      precision: 0.5,
      recall: 1,
    });
    // A category with no labels and no predictions has no ratio.
    expect(of("job_alert")).toMatchObject({
      expected: 0,
      predicted: 0,
      precision: null,
      recall: null,
    });

    expect(report.jobRelatedRecall).toEqual({ hits: 3, total: 4, rate: 0.75 });
    expect(report.categoryAccuracy).toEqual({ hits: 2, total: 4, rate: 0.5 });
  });

  it("compares company names after normalizeCompanyName", () => {
    const named = (id: string, name: string | null) => ({
      fixture: fixture(id, { company: "Northwind Example" }),
      triageJobRelated: true,
      extraction: extraction("rejection", {
        company: name === null ? null : { name, websiteDomain: null },
      }),
    });
    const report = scoreEval([
      named("a", "NORTHWIND EXAMPLE, Inc."), // case, punctuation and a legal suffix
      named("b", "Northwind  Example"),
      named("c", "Southwind Example"), // a different company
      named("d", null), // no company extracted
      {
        // A job alert names no company: not part of the company figure.
        fixture: fixture("e", { category: "job_alert", company: null }),
        triageJobRelated: true,
        extraction: extraction("job_alert", { company: null }),
      },
    ]);
    expect(report.companyMatch).toEqual({ hits: 2, total: 4, rate: 0.5 });
  });

  it("splits the exact interview start between calendar invites and plain text", () => {
    const invite = (id: string, ics: boolean, startsAt: string | null): EvalCase => ({
      fixture: fixture(
        id,
        { category: "interview_invite", interviewStart: "2026-09-17T16:00:00.000Z" },
        ics ? { ics: "BEGIN:VCALENDAR" } : {},
      ),
      triageJobRelated: true,
      extraction: extraction("interview_invite", { interview: interview(startsAt) }),
    });
    const report = scoreEval([
      invite("i1", true, "2026-09-17T10:00:00-06:00"), // same instant, other offset
      invite("i2", true, "2026-09-17T10:00:00-05:00"), // an hour off
      invite("t1", false, "2026-09-17T16:00:00Z"),
      invite("t2", false, null),
      invite("t3", false, "not a date"),
    ]);
    expect(report.startIcs).toEqual({ hits: 1, total: 2, rate: 0.5 });
    expect(report.startText).toEqual({ hits: 1, total: 3, rate: 1 / 3 });
  });
});

describe("meetsBar", () => {
  it("is false at job-related recall 0.97 and true at the bar", () => {
    expect(meetsBar(REPORT_AT_BAR)).toBe(true);
    expect(
      meetsBar({ ...REPORT_AT_BAR, jobRelatedRecall: { hits: 97, total: 100, rate: 0.97 } }),
    ).toBe(false);
  });

  it("fails on each figure that is below its own minimum", () => {
    for (const key of Object.keys(EVAL_BAR) as (keyof typeof EVAL_BAR)[]) {
      const below = { hits: 0, total: 100, rate: EVAL_BAR[key] - 0.01 };
      expect(meetsBar({ ...REPORT_AT_BAR, [key]: below })).toBe(false);
    }
  });

  it("fails when a figure has nothing to measure", () => {
    expect(meetsBar({ ...REPORT_AT_BAR, startText: { hits: 0, total: 0, rate: null } })).toBe(
      false,
    );
  });
});

describe("formatReport", () => {
  it("prints the bar with PASS/FAIL and a row for each category", () => {
    const text = formatReport({
      ...REPORT_AT_BAR,
      jobRelatedRecall: { hits: 97, total: 100, rate: 0.97 },
      perCategory: [
        {
          category: "offer",
          expected: 2,
          predicted: 2,
          truePositives: 1,
          precision: 0.5,
          recall: 0.5,
        },
      ],
    });
    expect(text).toContain("Job-related recall");
    expect(text).toMatch(/97\.0%.*FAIL/);
    expect(text).toMatch(/Company match\s+90\.0%.*PASS/);
    expect(text).toMatch(/offer\s+2\s+2\s+50\.0%\s+50\.0%/);
  });
});

describe("runEvalCases", () => {
  it("replays the public fixtures through a fake provider and meets the bar", async () => {
    const fixtures = loadEmailFixtures();
    const llm = FakeLlmProvider.fromFixtures({ emails: fixtures, leadBatches: [] });
    // The model sees every message (no rules), so say what it would say about each one.
    for (const f of fixtures) {
      const jobRelated = f.expected.triage === "job_related";
      llm.register("triage", { messageId: f.id }, { id: f.id, jobRelated, confidence: 0.95 });
    }

    const run = await runEvalCases(llm, fixtures, { ownerTimezone: FIXTURE_TIMEZONE });
    const report = scoreEval(run.cases);

    expect(run.failedIds).toEqual([]);
    expect(run.cases.some((c) => c.fixture.expected.triage === "skipped")).toBe(false);
    expect(llm.calls.filter((c) => c.purpose === "triage")).toHaveLength(2); // 48 messages, batches of 25
    expect(llm.calls.filter((c) => c.purpose === "extract")).toHaveLength(40);
    expect(report.scored).toBe(48);
    expect(meetsBar(report)).toBe(true);
    expect(report.startIcs.total).toBe(4);
    expect(report.startText.total).toBe(4);
  });

  it("counts a failed triage batch and a failed extraction as misses", async () => {
    const fixtures = loadEmailFixtures()
      .filter((f) => f.expected.triage === "job_related")
      .slice(0, 3);
    const llm = FakeLlmProvider.fromFixtures({ emails: fixtures, leadBatches: [] });
    for (const f of fixtures) {
      llm.register("triage", { messageId: f.id }, { id: f.id, jobRelated: true, confidence: 0.9 });
    }
    llm.failNext("extract", new LlmError("upstream", "boom", { retryable: true }));

    const run = await runEvalCases(llm, fixtures, {
      ownerTimezone: FIXTURE_TIMEZONE,
      concurrency: 1,
    });
    expect(run.failedIds).toHaveLength(1);
    expect(run.cases.filter((c) => c.extraction === null)).toHaveLength(1);
    expect(scoreEval(run.cases).categoryAccuracy.hits).toBe(2);
  });
});
