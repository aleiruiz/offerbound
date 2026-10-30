import { describe, expect, it } from "vitest";
import type { EmailCategory, Extraction, IcsEvent, InterviewKind } from "@offerbound/contracts";
import { planInterviewUpsert } from "./interview-upsert.js";
import type { InterviewRef } from "./plan.js";

const APP = { id: "a1" } as const;
const NEW_APP = { ref: "new:application" } as const;

const iv = (over: Partial<InterviewRef> & { id: string }): InterviewRef => ({
  version: 3,
  kind: "technical",
  status: "scheduled",
  startsAt: new Date("2026-11-05T16:00:00.000Z"),
  icsUid: null,
  ...over,
});

const ics = (over: Partial<IcsEvent> = {}): IcsEvent => ({
  uid: null,
  method: "REQUEST",
  start: null,
  end: null,
  timezone: null,
  summary: null,
  location: null,
  url: null,
  descriptionLink: null,
  organizer: null,
  ...over,
});

const interview = (
  over: Partial<NonNullable<Extraction["interview"]>> = {},
): NonNullable<Extraction["interview"]> => ({
  kind: "technical",
  startsAt: null,
  endsAt: null,
  timezone: null,
  meetingUrl: null,
  schedulingUrl: null,
  location: null,
  interviewers: [],
  ...over,
});

const ext = (category: EmailCategory, iw: Extraction["interview"] = interview()): Extraction => ({
  category,
  confidence: 0.95,
  company: { name: "Northwind Labs", websiteDomain: null },
  role: { title: "Backend Engineer", seniority: null },
  jobUrl: null,
  contact: null,
  interview: iw,
  assessment: null,
  leads: [],
  summary: "summary",
  language: "en",
});

describe("planInterviewUpsert", () => {
  it("an ics UID equal to an interview's ics_uid updates that interview; METHOD:CANCEL → cancel_interview", () => {
    const existing = [
      iv({ id: "i-other", icsUid: "uid-other" }),
      iv({ id: "i-1", icsUid: "uid-1", version: 7 }),
    ];
    const moved = planInterviewUpsert(
      existing,
      ext("interview_reschedule", interview({ startsAt: "2026-11-09T10:00:00-06:00" })),
      [
        ics({
          uid: "uid-1",
          start: "2026-11-10T17:00:00.000Z",
          end: "2026-11-10T18:00:00.000Z",
          timezone: "America/Monterrey",
          location: "Room 4",
          url: "https://meet.example/abc",
        }),
      ],
      "interview_reschedule",
      APP,
    );
    expect(moved).toEqual({
      op: "upsert_interview",
      application: APP,
      interviewId: "i-1",
      expectedVersion: 7,
      ref: "i-1",
      fields: {
        kind: "technical",
        status: "scheduled",
        startsAt: new Date("2026-11-10T17:00:00.000Z"),
        endsAt: new Date("2026-11-10T18:00:00.000Z"),
        timezoneHint: "America/Monterrey",
        meetingUrl: "https://meet.example/abc",
        schedulingUrl: null,
        location: "Room 4",
        interviewers: [],
        icsUid: "uid-1",
      },
    });

    const cancelled = planInterviewUpsert(
      existing,
      ext("interview_cancellation", null),
      [ics({ uid: "uid-1", method: "CANCEL" })],
      "interview_cancellation",
      APP,
    );
    expect(cancelled).toEqual({ op: "cancel_interview", interviewId: "i-1", expectedVersion: 7 });
  });

  it("a cancel method on the calendar wins even when the category says invite", () => {
    const op = planInterviewUpsert(
      [iv({ id: "i-1", icsUid: "u" })],
      ext("interview_invite"),
      [ics({ uid: "u", method: "CANCEL" })],
      "interview_invite",
      APP,
    );
    expect(op).toMatchObject({ op: "cancel_interview", interviewId: "i-1" });
  });

  it("a reschedule without a UID updates the next scheduled or to_schedule interview of the same kind, else the next upcoming of any kind, else creates one", () => {
    const existing = [
      iv({ id: "i-late", kind: "technical", startsAt: new Date("2026-11-20T16:00:00Z") }),
      iv({ id: "i-sd", kind: "system_design", startsAt: new Date("2026-11-03T16:00:00Z") }),
      iv({ id: "i-soon", kind: "technical", startsAt: new Date("2026-11-08T16:00:00Z") }),
      iv({ id: "i-done", kind: "technical", status: "completed" }),
    ];
    const resched = (kind: InterviewKind, list: InterviewRef[]) =>
      planInterviewUpsert(
        list,
        ext("interview_reschedule", interview({ kind, startsAt: "2026-12-01T10:00:00-06:00" })),
        [],
        "interview_reschedule",
        APP,
      );

    // Same kind: the earliest of the technical ones, not the system design one.
    expect(resched("technical", existing)).toMatchObject({
      op: "upsert_interview",
      interviewId: "i-soon",
      expectedVersion: 3,
    });
    // A to_schedule interview of the same kind counts, after the scheduled ones.
    expect(
      resched("behavioral", [
        iv({ id: "i-ts", kind: "behavioral", status: "to_schedule", startsAt: null }),
        iv({ id: "i-x", kind: "technical", startsAt: new Date("2026-11-03T16:00:00Z") }),
      ]),
    ).toMatchObject({ interviewId: "i-ts" });
    // No interview of that kind: the next upcoming of any kind.
    expect(resched("onsite_loop", existing)).toMatchObject({ interviewId: "i-sd" });
    // Nothing upcoming at all (only completed or cancelled): create.
    const created = resched("technical", [
      iv({ id: "i-done", status: "completed" }),
      iv({ id: "i-gone", status: "cancelled" }),
    ]);
    expect(created).toMatchObject({
      op: "upsert_interview",
      interviewId: null,
      expectedVersion: null,
      ref: "new:interview",
      fields: { status: "scheduled", startsAt: new Date("2026-12-01T16:00:00.000Z") },
    });
  });

  it("a cancellation without a match changes nothing", () => {
    expect(
      planInterviewUpsert(
        [],
        ext("interview_cancellation", null),
        [],
        "interview_cancellation",
        APP,
      ),
    ).toBeNull();
    expect(
      planInterviewUpsert(
        [iv({ id: "i-done", status: "completed" }), iv({ id: "i-gone", status: "cancelled" })],
        ext("interview_cancellation", null),
        [ics({ uid: "unknown", method: "CANCEL" })],
        "interview_cancellation",
        APP,
      ),
    ).toBeNull();
  });

  it("a cancellation without a UID cancels the next upcoming interview of that kind, else of any kind", () => {
    const existing = [
      iv({ id: "i-t", kind: "technical", startsAt: new Date("2026-11-08T16:00:00Z") }),
      iv({ id: "i-b", kind: "behavioral", startsAt: new Date("2026-11-04T16:00:00Z") }),
    ];
    expect(
      planInterviewUpsert(
        existing,
        ext("interview_cancellation", interview({ kind: "technical" })),
        [],
        "interview_cancellation",
        APP,
      ),
    ).toEqual({ op: "cancel_interview", interviewId: "i-t", expectedVersion: 3 });
    expect(
      planInterviewUpsert(
        existing,
        ext("interview_cancellation", null),
        [],
        "interview_cancellation",
        APP,
      ),
    ).toEqual({ op: "cancel_interview", interviewId: "i-b", expectedVersion: 3 });
  });

  it("a cancellation of an interview that is already cancelled changes nothing", () => {
    expect(
      planInterviewUpsert(
        [iv({ id: "i-1", icsUid: "u", status: "cancelled" })],
        ext("interview_cancellation", null),
        [ics({ uid: "u", method: "CANCEL" })],
        "interview_cancellation",
        APP,
      ),
    ).toBeNull();
  });

  it("an invite fills an existing to_schedule interview of the same kind", () => {
    const existing = [
      iv({ id: "i-sd", kind: "system_design", status: "to_schedule", startsAt: null }),
      iv({ id: "i-ts", kind: "technical", status: "to_schedule", startsAt: null, version: 2 }),
    ];
    const op = planInterviewUpsert(
      existing,
      ext("interview_invite", interview({ kind: "technical", interviewers: ["Dana Park"] })),
      [ics({ uid: "new-uid", start: "2026-11-12T15:00:00.000Z", end: "2026-11-12T16:00:00.000Z" })],
      "interview_invite",
      APP,
    );
    expect(op).toMatchObject({
      op: "upsert_interview",
      interviewId: "i-ts",
      expectedVersion: 2,
      fields: {
        status: "scheduled",
        startsAt: new Date("2026-11-12T15:00:00.000Z"),
        icsUid: "new-uid",
        interviewers: ["Dana Park"],
      },
    });
  });

  it("an invite with no interview to fill creates one: scheduled with a time, to_schedule with the link otherwise", () => {
    const withTime = planInterviewUpsert(
      [iv({ id: "i-old", kind: "technical", status: "scheduled" })],
      ext(
        "interview_invite",
        interview({ kind: "behavioral", startsAt: "2026-11-12T09:00:00-06:00" }),
      ),
      [],
      "interview_invite",
      NEW_APP,
    );
    expect(withTime).toMatchObject({
      op: "upsert_interview",
      application: NEW_APP,
      interviewId: null,
      expectedVersion: null,
      ref: "new:interview",
      fields: {
        kind: "behavioral",
        status: "scheduled",
        startsAt: new Date("2026-11-12T15:00:00Z"),
      },
    });

    const noTime = planInterviewUpsert(
      [],
      ext(
        "interview_invite",
        interview({ kind: "recruiter_screen", schedulingUrl: "https://cal.example/pick" }),
      ),
      [],
      "interview_invite",
      NEW_APP,
    );
    expect(noTime).toMatchObject({
      interviewId: null,
      fields: {
        kind: "recruiter_screen",
        status: "to_schedule",
        startsAt: null,
        endsAt: null,
        schedulingUrl: "https://cal.example/pick",
      },
    });
  });

  it("calendar times override the extracted ones; the extraction fills what the calendar lacks", () => {
    const op = planInterviewUpsert(
      [],
      ext(
        "interview_invite",
        interview({
          startsAt: "2026-11-12T09:00:00-06:00",
          endsAt: "2026-11-12T10:00:00-06:00",
          timezone: "America/Mexico_City",
          meetingUrl: "https://meet.example/from-text",
          location: "Remote",
        }),
      ),
      [
        ics({
          start: "2026-11-13T15:30:00.000Z",
          end: "2026-11-13T16:15:00.000Z",
          timezone: "UTC",
        }),
      ],
      "interview_invite",
      APP,
    );
    expect(op).toMatchObject({
      fields: {
        startsAt: new Date("2026-11-13T15:30:00.000Z"),
        endsAt: new Date("2026-11-13T16:15:00.000Z"),
        timezoneHint: "UTC",
        meetingUrl: "https://meet.example/from-text",
        location: "Remote",
      },
    });
  });

  it("is null for categories that are not about an interview", () => {
    for (const category of ["rejection", "offer", "assessment", "candidate_outbound"] as const) {
      expect(planInterviewUpsert([], ext(category), [], category, APP)).toBeNull();
    }
  });

  it("treats an unparseable time as unknown", () => {
    const op = planInterviewUpsert(
      [],
      ext("interview_invite", interview({ startsAt: "next Tuesday" })),
      [],
      "interview_invite",
      APP,
    );
    expect(op).toMatchObject({ fields: { startsAt: null, status: "to_schedule" } });
  });
});
