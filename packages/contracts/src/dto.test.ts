import { describe, expect, it } from "vitest";
import {
  ApiErrorBodySchema,
  ApiErrorCodeSchema,
  ApplicationCreateSchema,
  ApplicationPatchSchema,
  DailyActivityBodySchema,
  EmailFixtureSchema,
  LeadPatchSchema,
  PageSchema,
  ParsedMessageSchema,
  ReviewResolveSchema,
  TodaySchema,
  TimelineEventSchema,
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
      undoable: true,
      undoneAt: null,
    };
    expect(TimelineEventSchema.parse(event)).toEqual(event);
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
