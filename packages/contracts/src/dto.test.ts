import { describe, expect, it } from "vitest";
import {
  ApiErrorBodySchema,
  ApiErrorCodeSchema,
  ApplicationCreateSchema,
  ApplicationMergeSchema,
  ApplicationPatchSchema,
  CvProfileSchema,
  CompanyPatchSchema,
  CvUploadFailedSchema,
  DailyActivityBodySchema,
  EmailFixtureSchema,
  InterviewWithApplicationSchema,
  LeadPatchSchema,
  LeadRerankSchema,
  LeadsQuerySchema,
  PageSchema,
  ParsedMessageSchema,
  ReviewResolveSchema,
  SearchRunsSchema,
  ReportCommitBodySchema,
  ReportCommitResultSchema,
  ReportPreviewBodySchema,
  ReportPreviewSchema,
  MAX_REPORT_CHARS,
  SheetCommitBodySchema,
  TodaySchema,
  TimelineEventSchema,
  UndoResultSchema,
  type EmailFixture,
} from "./index.js";
import { z } from "zod";

describe("request bodies", () => {
  it("rejects a daily-activity amount of 0 or 241", () => {
    const parse = (amount: number): boolean =>
      DailyActivityBodySchema.safeParse({ kind: "outreach", amount }).success;
    expect(parse(0)).toBe(false);
    expect(parse(241)).toBe(false);
    expect(parse(1)).toBe(true);
    expect(parse(240)).toBe(true);
    expect(DailyActivityBodySchema.safeParse({ kind: "prep_minutes", amount: 1.5 }).success).toBe(
      false,
    );
    expect(DailyActivityBodySchema.safeParse({ kind: "follow_ups", amount: 1 }).success).toBe(
      false,
    );
  });

  it("requires version on patches and allows every editable field to be omitted", () => {
    expect(ApplicationPatchSchema.safeParse({}).success).toBe(false);
    expect(ApplicationPatchSchema.parse({ version: 3 })).toEqual({ version: 3 });
    expect(ApplicationPatchSchema.parse({ version: 3, status: "withdrawn" }).status).toBe(
      "withdrawn",
    );
    expect(LeadPatchSchema.safeParse({ status: "applied", version: 1 }).success).toBe(false);
    expect(
      LeadPatchSchema.safeParse({ status: "dismissed", dismissedReason: "x", version: 1 }).success,
    ).toBe(true);
  });

  it("reads the leads query: sort defaults to track_fit, limit to 50, and unknown values are refused", () => {
    expect(LeadsQuerySchema.parse({})).toEqual({ sort: "track_fit", limit: 50 });
    expect(LeadsQuerySchema.parse({ status: "new", sort: "newest", limit: "25" })).toMatchObject({
      status: "new",
      sort: "newest",
      limit: 25,
    });
    expect(LeadsQuerySchema.parse({ q: "  " })).toEqual({ sort: "track_fit", limit: 50 });
    expect(LeadsQuerySchema.parse({ q: " acme " }).q).toBe("acme");
    expect(LeadsQuerySchema.safeParse({ sort: "oldest" }).success).toBe(false);
    expect(LeadsQuerySchema.safeParse({ limit: "201" }).success).toBe(false);
    expect(LeadsQuerySchema.safeParse({ status: "open" }).success).toBe(false);
  });

  it("re-ranks only the new leads, and a company patch needs its version", () => {
    expect(LeadRerankSchema.safeParse({ scope: "new" }).success).toBe(true);
    expect(LeadRerankSchema.safeParse({ scope: "all" }).success).toBe(false);
    expect(CompanyPatchSchema.safeParse({ name: "Northwind Labs" }).success).toBe(false);
    expect(CompanyPatchSchema.safeParse({ version: 1, name: " " }).success).toBe(false);
    expect(CompanyPatchSchema.parse({ version: 1, groupId: null })).toEqual({
      version: 1,
      groupId: null,
    });
  });

  it("lets an application patch rename the company, but not to an empty name", () => {
    expect(
      ApplicationPatchSchema.parse({ version: 1, companyName: "Northwind Labs" }).companyName,
    ).toBe("Northwind Labs");
    expect(ApplicationPatchSchema.safeParse({ version: 1, companyName: "  " }).success).toBe(false);
  });

  it("creates an application with nullable optional fields present", () => {
    const body = {
      companyName: "Northwind Labs",
      title: "Backend Engineer",
      jobUrl: null,
      status: "applied",
      appliedAt: "2026-10-29T18:00:00.000Z",
      notes: null,
    };
    expect(ApplicationCreateSchema.parse(body)).toEqual(body);
    expect(ApplicationCreateSchema.safeParse({ ...body, companyName: "" }).success).toBe(false);
    expect(
      ApplicationCreateSchema.safeParse({ ...body, jobUrl: "javascript:alert(1)" }).success,
    ).toBe(false);
  });

  it("validates review actions", () => {
    expect(ReviewResolveSchema.safeParse({ action: "attach", applicationId: "a1" }).success).toBe(
      true,
    );
    expect(
      ReviewResolveSchema.safeParse({ action: "edit_apply", edits: { confidence: 0.9 } }).success,
    ).toBe(true);
    expect(ReviewResolveSchema.safeParse({ action: "explode" }).success).toBe(false);
  });
});

describe("response shapes", () => {
  it("wraps items in a page", () => {
    const page = PageSchema(z.string());
    expect(page.parse({ items: ["a"], nextCursor: null })).toEqual({
      items: ["a"],
      nextCursor: null,
    });
    expect(page.safeParse({ items: ["a"] }).success).toBe(false);
  });

  it("parses a timeline event", () => {
    const event = {
      id: "e1",
      type: "status_changed",
      occurredAt: "2026-10-29T18:00:00.000Z",
      actor: "system",
      summary: "Moved to Interviewing",
      messageId: null,
      toStatus: "interviewing",
      undoable: true,
      undoneAt: null,
    };
    expect(TimelineEventSchema.parse(event)).toEqual(event);
    expect(TimelineEventSchema.parse({ ...event, toStatus: null }).toStatus).toBeNull();
    expect(TimelineEventSchema.safeParse({ ...event, toStatus: "paused" }).success).toBe(false);
    const withoutStatus: Partial<typeof event> = { ...event };
    delete withoutStatus.toStatus;
    expect(TimelineEventSchema.safeParse(withoutStatus).success).toBe(false);
  });

  it("reuses InterviewWithApplication for Today's upcoming interviews", () => {
    expect(TodaySchema.shape.upcomingInterviews.element).toBe(InterviewWithApplicationSchema);
  });

  it("keeps Today's pipeline counts exhaustive over application statuses", () => {
    expect(TodaySchema.shape.pipeline.shape.byStatus.safeParse({ applied: 1 }).success).toBe(false);
  });

  it("knows every error code from TECHNICAL_SPEC §10", () => {
    for (const code of [
      "validation_failed",
      "unauthenticated",
      "not_owner",
      "csrf_header_missing",
      "demo_read_only",
      "not_found",
      "version_conflict",
      "changed_since",
      "already_running",
      "duplicate_import",
      "not_connected",
      "too_large",
      "cv_no_text",
      "unsupported_file",
      "rate_limited",
      "internal_error",
      "upstream_error",
      "not_ready",
    ]) {
      expect(ApiErrorCodeSchema.safeParse(code).success, code).toBe(true);
    }
    expect(ApiErrorCodeSchema.safeParse("teapot").success).toBe(false);
    expect(
      ApiErrorBodySchema.parse({
        error: {
          code: "validation_failed",
          message: "Bad",
          fields: { "timers.abandonDays": "Too low" },
        },
      }).error.fields,
    ).toEqual({ "timers.abandonDays": "Too low" });
    expect(
      ApiErrorBodySchema.parse({ error: { code: "not_found", message: "Missing" } }).error.code,
    ).toBe("not_found");
  });
});

describe("mail and fixtures", () => {
  it("parses a message with a calendar event", () => {
    const parsed = {
      headers: {
        from: "Dana <dana@northwind-labs.example>",
        fromName: "Dana",
        fromEmail: "dana@northwind-labs.example",
        to: ["owner@owner.example"],
        cc: [],
        subject: "Interview",
        date: "Tue, 27 Oct 2026 10:00:00 -0600",
        listId: null,
      },
      textBody: "Hello",
      icsEvents: [
        {
          uid: "u1",
          method: "REQUEST",
          start: "2026-11-03T20:00:00.000Z",
          end: "2026-11-03T20:30:00.000Z",
          timezone: "America/New_York",
          summary: "Screen",
          location: null,
          url: null,
          descriptionLink: null,
          organizer: null,
        },
      ],
    };
    expect(ParsedMessageSchema.parse(parsed)).toEqual(parsed);
  });

  it("accepts a fixture with llm.triage null and llm.extraction null", () => {
    const fixture: EmailFixture = {
      id: "m-001",
      threadId: "t-001",
      internalDate: "2026-10-20T15:00:00.000Z",
      labels: ["INBOX"],
      headers: {
        from: "Bank <alerts@bank.example>",
        to: ["owner@owner.example"],
        subject: "Your statement is ready",
        date: "Tue, 20 Oct 2026 09:00:00 -0600",
      },
      snippet: "Your statement is ready",
      bodyText: "Your statement is ready.",
      demo: false,
      expected: {
        triage: "skipped",
        category: null,
        company: null,
        role: null,
        outcome: "skipped",
      },
      llm: { triage: null, extraction: null },
    };
    expect(EmailFixtureSchema.parse(fixture)).toEqual(fixture);
    expect(
      EmailFixtureSchema.safeParse({
        ...fixture,
        expected: { ...fixture.expected, outcome: "done" },
      }).success,
    ).toBe(false);
  });
});

describe("onboarding request and response shapes", () => {
  it("POST /import/sheet/commit takes only the preview id", () => {
    expect(SheetCommitBodySchema.parse({ previewId: "p1" })).toEqual({ previewId: "p1" });
    expect(SheetCommitBodySchema.safeParse({}).success).toBe(false);
  });

  it("the report import takes text, then a preview id with at least one kept row", () => {
    expect(MAX_REPORT_CHARS).toBe(50_000);
    // A text over the cap is the route's 413, so the schema itself accepts it.
    expect(
      ReportPreviewBodySchema.safeParse({ text: "x".repeat(MAX_REPORT_CHARS + 1) }).success,
    ).toBe(true);
    expect(ReportPreviewBodySchema.safeParse({}).success).toBe(false);
    expect(ReportCommitBodySchema.parse({ previewId: "p1", keepRowIds: ["r1"] })).toEqual({
      previewId: "p1",
      keepRowIds: ["r1"],
    });
    expect(ReportCommitBodySchema.safeParse({ previewId: "p1", keepRowIds: [] }).success).toBe(
      false,
    );
    expect(ReportCommitResultSchema.parse({ batchId: "b1" })).toEqual({ batchId: "b1" });
    expect(
      ReportPreviewSchema.safeParse({
        previewId: "p1",
        expiresAt: "2026-10-01T13:00:00.000Z",
        rows: [],
      }).success,
    ).toBe(true);
  });

  it("POST /cv answers 201 with a bare profile, or 202 with profileStatus failed and no profile", () => {
    const profile = {
      headline: "Full-stack engineer",
      yearsExperience: 8,
      coreSkills: ["TypeScript"],
      secondarySkills: [],
      domains: [],
      recentRoles: [{ title: "Engineer", company: "Tidewater Labs", years: "2020-2024" }],
      leadership: null,
      languages: ["English"],
      location: null,
      workAuthorization: null,
    };
    expect(CvProfileSchema.parse(profile).headline).toBe("Full-stack engineer");
    expect(CvUploadFailedSchema.parse({ profileStatus: "failed", profile: null })).toEqual({
      profileStatus: "failed",
      profile: null,
    });
    expect(CvUploadFailedSchema.safeParse({ profileStatus: "ok", profile: null }).success).toBe(
      false,
    );
    expect(CvUploadFailedSchema.safeParse({ profileStatus: "failed", profile }).success).toBe(
      false,
    );
  });
});

describe("application merge and undo", () => {
  it("POST /applications/:id/merge takes { intoId }; POST /events/:id/undo answers { undone: true }", () => {
    expect(ApplicationMergeSchema.parse({ intoId: "a2" })).toEqual({ intoId: "a2" });
    expect(ApplicationMergeSchema.safeParse({}).success).toBe(false);
    expect(ApplicationMergeSchema.safeParse({ intoId: "" }).success).toBe(false);
    expect(UndoResultSchema.parse({ undone: true })).toEqual({ undone: true });
    expect(UndoResultSchema.safeParse({ undone: false }).success).toBe(false);
  });
});

describe("search runs", () => {
  const run = {
    id: "r1",
    trigger: "manual",
    status: "running",
    startedAt: "2026-10-30T13:00:00Z",
    finishedAt: null,
    rounds: 1,
    returned: 12,
    accepted: 9,
    suppressed: 2,
    duplicates: 1,
    dead: 0,
    webSearchCalls: 30,
    costMicros: null,
    error: null,
  };

  it("GET /search/runs answers with a plain list of runs", () => {
    expect(SearchRunsSchema.parse([run])).toHaveLength(1);
    expect(SearchRunsSchema.parse([])).toEqual([]);
    expect(SearchRunsSchema.safeParse({ items: [run], nextCursor: null }).success).toBe(false);
  });
});
