import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DailyCountsSchema,
  NavCountsSchema,
  TodaySchema,
  type ApiErrorBody,
  type Today,
} from "@offerbound/contracts";
import { buildTestApp, signIn } from "../../test/app.js";
import { resetDb, testPrisma } from "../../test/db.js";

const prisma = testPrisma();
const CSRF = { "x-offerbound-request": "1" };
// 23:30 on 2026-10-29 in Monterrey (UTC-6) is already 2026-10-30 in UTC.
const NOW = new Date("2026-10-30T05:30:00.000Z");
// The owner-local day 2026-10-29 is [2026-10-29T06:00Z, 2026-10-30T06:00Z).
const DAY_START = new Date("2026-10-29T06:00:00.000Z");
const at = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);

const apps: FastifyInstance[] = [];
async function appWith() {
  const built = await buildTestApp({ clock: () => NOW });
  apps.push(built.app);
  const cookie = await signIn(built.app, built.deps);
  const call = (method: "GET" | "POST", url: string, payload?: object) =>
    built.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { cookie, ...(method === "GET" ? {} : CSRF) },
      ...(payload ? { payload } : {}),
    });
  const today = async (): Promise<Today> => {
    const res = await call("GET", "/today");
    expect(res.statusCode).toBe(200);
    return TodaySchema.parse(res.json());
  };
  return { ...built, cookie, call, today };
}

beforeEach(async () => {
  await resetDb(prisma);
  batchId = undefined;
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

// --- seeding -------------------------------------------------------------------------------------

let seq = 0;
async function seedCompany(name: string) {
  seq += 1;
  return prisma.company.create({
    data: { name, normalizedName: `${name.toLowerCase()}-${seq}`, createdSource: "manual" },
  });
}

type AppSeed = {
  company?: string;
  title?: string;
  status?:
    | "applied"
    | "screening"
    | "assessment"
    | "interviewing"
    | "offer"
    | "accepted"
    | "rejected"
    | "withdrawn"
    | "abandoned";
  appliedAt?: Date | null;
  followUpDue?: boolean;
  followUpDueSince?: Date | null;
};
async function seedApplication(seed: AppSeed = {}) {
  const company = await seedCompany(seed.company ?? `Company ${seq + 1}`);
  return prisma.application.create({
    data: {
      companyId: company.id,
      title: seed.title ?? "Staff Engineer",
      status: seed.status ?? "applied",
      statusChangedAt: at(-48),
      appliedAt: seed.appliedAt === undefined ? at(-72) : seed.appliedAt,
      followUpDue: seed.followUpDue ?? false,
      followUpDueSince: seed.followUpDueSince ?? null,
      source: "manual",
    },
  });
}

let batchId: string | undefined;
type LeadSeed = {
  title?: string;
  status?: "new" | "shortlisted" | "dismissed" | "applied" | "suppressed";
  pipelineState?: "checking" | "ranking" | "ready";
  track?: string | null;
  fitScore?: number | null;
  foundAt?: Date;
};
async function seedLead(seed: LeadSeed = {}) {
  const company = await seedCompany(`Lead company ${seq + 1}`);
  batchId ??= (await prisma.intakeBatch.create({ data: { kind: "manual", counts: {} } })).id;
  return prisma.lead.create({
    data: {
      companyId: company.id,
      intakeBatchId: batchId,
      title: seed.title ?? "Platform Engineer",
      status: seed.status ?? "new",
      ...(seed.status === "suppressed" && { suppressedReason: "company_already_seen" as const }),
      statusChangedAt: at(-1),
      pipelineState: seed.pipelineState ?? "ready",
      track: seed.track === undefined ? "A" : seed.track,
      fitScore: seed.fitScore === undefined ? 70 : seed.fitScore,
      source: "manual",
      foundAt: seed.foundAt ?? at(-1),
    },
  });
}

let msgSeq = 0;
async function seedMessage(
  applicationId: string | null,
  over: {
    direction?: "inbound" | "outbound";
    category?:
      | "application_confirmation"
      | "rejection"
      | "interview_invite"
      | "status_update_other"
      | "candidate_outbound"
      | null;
  } = {},
) {
  msgSeq += 1;
  return prisma.gmailMessage.create({
    data: {
      id: `msg-${msgSeq}`,
      threadId: `thr-${msgSeq}`,
      internalDate: at(-10),
      direction: over.direction ?? "inbound",
      labelIds: [],
      state: "applied",
      category: over.category === undefined ? "status_update_other" : over.category,
      applicationId,
      subject: `Subject ${msgSeq}`,
      fromName: "Recruiter",
      fromEmail: "jobs@quarry.example",
      summary: `Summary ${msgSeq}`,
    },
  });
}

// --- GET /today ----------------------------------------------------------------------------------

describe("GET /today", () => {
  it("an application applied at 23:30 local counts in today's applications", async () => {
    const { today } = await appWith();
    await seedApplication({ appliedAt: NOW }); // 23:30 local, 05:30Z next day
    await seedApplication({ appliedAt: DAY_START }); // local midnight: the first instant of today
    await seedApplication({ appliedAt: new Date(DAY_START.getTime() - 1) }); // 23:59:59.999 yesterday
    await seedApplication({ appliedAt: new Date("2026-10-30T06:00:00.000Z") }); // tomorrow
    await seedApplication({ appliedAt: null });

    const result = await today();
    expect(result.date).toBe("2026-10-29");
    expect(result.counts.applications).toBe(2);
  });

  it("new leads today exclude suppressed ones", async () => {
    const { today } = await appWith();
    await seedLead({ foundAt: at(-1) });
    await seedLead({ foundAt: DAY_START, status: "shortlisted" });
    await seedLead({ foundAt: at(-2), status: "suppressed" });
    await seedLead({ foundAt: at(-30) }); // yesterday
    await seedLead({ foundAt: at(-1), pipelineState: "checking" }); // not shown anywhere yet

    expect((await today()).counts.newLeads).toBe(2);
  });

  it("follow-ups due are oldest first; interviews cover the next 7 days", async () => {
    const { today } = await appWith();
    const newer = await seedApplication({
      company: "Newer Co",
      followUpDue: true,
      followUpDueSince: at(-24),
    });
    const older = await seedApplication({
      company: "Older Co",
      followUpDue: true,
      followUpDueSince: at(-96),
    });
    await seedApplication({ company: "Not Due Co", followUpDue: false });

    const inThree = await prisma.interview.create({
      data: { applicationId: newer.id, kind: "technical", status: "scheduled", startsAt: at(72) },
    });
    const tomorrow = await prisma.interview.create({
      data: {
        applicationId: older.id,
        kind: "recruiter_screen",
        status: "scheduled",
        startsAt: at(20),
      },
    });
    const toSchedule = await prisma.interview.create({
      data: { applicationId: older.id, kind: "behavioral", status: "to_schedule" },
    });
    const edge = await prisma.interview.create({
      data: { applicationId: newer.id, kind: "other", status: "scheduled", startsAt: at(24 * 7) },
    });
    // Out: beyond 7 days, already over, cancelled.
    await prisma.interview.createMany({
      data: [
        {
          applicationId: newer.id,
          kind: "technical",
          status: "scheduled",
          startsAt: at(24 * 7 + 1),
        },
        { applicationId: newer.id, kind: "technical", status: "scheduled", startsAt: at(-3) },
        { applicationId: newer.id, kind: "technical", status: "cancelled", startsAt: at(30) },
        { applicationId: newer.id, kind: "technical", status: "completed", startsAt: at(-30) },
      ],
    });

    const result = await today();
    expect(result.followUpsDue.map((a) => a.id)).toEqual([older.id, newer.id]);
    expect(result.followUpsDue[0]).toMatchObject({
      company: { name: "Older Co" },
      followUpDue: true,
      nextInterviewAt: at(20).toISOString(),
    });
    expect(result.upcomingInterviews.map((i) => i.id)).toEqual([
      toSchedule.id,
      tomorrow.id,
      inThree.id,
      edge.id,
    ]);
    expect(result.upcomingInterviews[1]?.application).toMatchObject({
      id: older.id,
      company: { name: "Older Co" },
    });
  });

  it("the response rate counts applications with an inbound message whose category isn't application_confirmation", async () => {
    const { today } = await appWith();
    const replied = await seedApplication();
    const repliedTwice = await seedApplication();
    const onlyConfirmation = await seedApplication();
    const onlyOutbound = await seedApplication();
    await seedApplication(); // no messages at all
    await seedMessage(replied.id, { category: "interview_invite" });
    await seedMessage(repliedTwice.id, { category: "rejection" });
    await seedMessage(repliedTwice.id, { category: "status_update_other" });
    await seedMessage(onlyConfirmation.id, { category: "application_confirmation" });
    await seedMessage(onlyConfirmation.id, {
      direction: "outbound",
      category: "status_update_other",
    });
    await seedMessage(onlyOutbound.id, { direction: "outbound", category: "candidate_outbound" });

    const result = await today();
    expect(result.pipeline.responseRate).toBeCloseTo(2 / 5);
    expect(result.pipeline.responseRate).toBeGreaterThanOrEqual(0);
    expect(result.pipeline.responseRate).toBeLessThanOrEqual(1);
  });

  it("the interview rate counts an application rejected after an interview", async () => {
    const { today } = await appWith();
    // Still at Screening or later.
    await seedApplication({ status: "screening" });
    await seedApplication({ status: "offer" });
    // Rejected after an interview: the history says so (the importer and the pipeline write `toStatus`).
    const rejectedAfter = await seedApplication({ status: "rejected" });
    await prisma.event.create({
      data: {
        applicationId: rejectedAfter.id,
        type: "status_changed",
        actor: "system",
        summary: "Moved to Interviewing",
        data: { fromStatus: "applied", toStatus: "interviewing" },
        undoable: true,
      },
    });
    // Rejected straight from Applied.
    const rejectedEarly = await seedApplication({ status: "rejected" });
    await prisma.event.create({
      data: {
        applicationId: rejectedEarly.id,
        type: "status_changed",
        actor: "system",
        summary: "Rejected",
        data: { fromStatus: "applied", toStatus: "rejected" },
        undoable: true,
      },
    });
    // A status change that was undone does not count.
    const undone = await seedApplication({ status: "applied" });
    await prisma.event.create({
      data: {
        applicationId: undone.id,
        type: "status_changed",
        actor: "system",
        summary: "Moved to Screening",
        data: { toStatus: "screening" },
        undoable: true,
        undoneAt: at(-1),
      },
    });
    await seedApplication({ status: "applied" });

    const result = await today();
    // 3 of 6 applications reached Screening or later.
    expect(result.pipeline.interviewRate).toBeCloseTo(3 / 6);
    expect(result.pipeline.byStatus).toMatchObject({
      screening: 1,
      offer: 1,
      rejected: 2,
      applied: 2,
      assessment: 0,
      interviewing: 0,
    });
  });

  it("rates are 0 with no applications, and the pipeline lists every status", async () => {
    const { today } = await appWith();
    const result = await today();
    expect(result.pipeline.responseRate).toBe(0);
    expect(result.pipeline.interviewRate).toBe(0);
    expect(Object.keys(result.pipeline.byStatus).sort()).toEqual(
      [
        "abandoned",
        "accepted",
        "applied",
        "assessment",
        "interviewing",
        "offer",
        "rejected",
        "screening",
        "withdrawn",
      ].sort(),
    );
  });

  it("topLeads is at most 5 New ready leads in track, fit score, found date order", async () => {
    const { today } = await appWith();
    const a70 = await seedLead({ track: "A", fitScore: 70, foundAt: at(-5) });
    const a90 = await seedLead({ track: "A", fitScore: 90, foundAt: at(-9) });
    const a70Newer = await seedLead({ track: "A", fitScore: 70, foundAt: at(-2) });
    const b95 = await seedLead({ track: "B", fitScore: 95 });
    const noTrack = await seedLead({ track: null, fitScore: 99 });
    // Out: not New, not ready, or beyond the fifth.
    await seedLead({ track: "A", fitScore: 100, status: "shortlisted" });
    await seedLead({ track: "A", fitScore: 100, pipelineState: "ranking" });
    await seedLead({ track: null, fitScore: 10 });

    const result = await today();
    expect(result.topLeads.map((l) => l.id)).toEqual([
      a90.id,
      a70Newer.id,
      a70.id,
      b95.id,
      noTrack.id,
    ]);
    expect(result.topLeads[0]).toMatchObject({ track: "A", fitScore: 90, status: "new" });
  });

  it("review is the open count and the newest 3 open items", async () => {
    const { today } = await appWith();
    const app = await seedApplication();
    const message = await seedMessage(app.id, { category: "rejection" });
    const kinds = [
      "low_confidence",
      "ambiguous_match",
      "unexpected_transition",
      "low_confidence",
    ] as const;
    const ids: string[] = [];
    for (const [index, kind] of kinds.entries()) {
      const item = await prisma.reviewItem.create({
        data: {
          kind,
          messageId: index === 3 ? message.id : null,
          applicationId: app.id,
          confidence: 0.55,
          reasons: [`Reason ${index}`],
          createdAt: at(-10 + index),
        },
      });
      ids.push(item.id);
    }
    await prisma.reviewItem.create({
      data: { kind: "extraction_failed", state: "resolved", resolvedAt: at(-1) },
    });

    const result = await today();
    expect(result.review.open).toBe(4);
    expect(result.review.first.map((r) => r.id)).toEqual([ids[3], ids[2], ids[1]]);
    expect(result.review.first[0]).toMatchObject({
      state: "open",
      proposal: { description: "Reason 3" },
    });
    expect(result.review.first[0]?.confidence).toBeCloseTo(0.55, 5);
    expect(result.review.first[0]?.message).toMatchObject({
      id: message.id,
      direction: "inbound",
      category: "rejection",
      subject: message.subject,
    });
    expect(result.review.first[1]?.message).toBeNull();
  });

  it("reports the daily counts, the targets and the sync status", async () => {
    const { today } = await appWith();
    await prisma.dailyActivity.create({
      data: {
        day: new Date("2026-10-29T00:00:00.000Z"),
        outreachCount: 2,
        prepMinutes: 45,
        followUps: 1,
      },
    });
    // Yesterday's row is not today's.
    await prisma.dailyActivity.create({
      data: {
        day: new Date("2026-10-28T00:00:00.000Z"),
        outreachCount: 9,
        prepMinutes: 9,
        followUps: 9,
      },
    });
    const result = await today();
    expect(result.counts).toMatchObject({ outreach: 2, prepMinutes: 45, followUps: 1 });
    expect(result.targets.applications).toEqual({ min: 8, max: 12 });
    expect(result.sync.connection).toBe("not_connected");
  });

  it("requires a session", async () => {
    const { app } = await appWith();
    const res = await app.inject({ method: "GET", url: "/api/v1/today" });
    expect(res.statusCode).toBe(401);
  });
});

// --- POST /daily-activity ------------------------------------------------------------------------

describe("POST /daily-activity", () => {
  it("POST /daily-activity outreach +1 twice → 2; prep 15 then 30 → 45; amount 0 → 400", async () => {
    const { call } = await appWith();
    let res = await call("POST", "/daily-activity", { kind: "outreach", amount: 1 });
    expect(res.statusCode).toBe(200);
    expect(DailyCountsSchema.parse(res.json())).toEqual({
      date: "2026-10-29",
      outreach: 1,
      prepMinutes: 0,
      followUps: 0,
    });
    res = await call("POST", "/daily-activity", { kind: "outreach", amount: 1 });
    expect(DailyCountsSchema.parse(res.json()).outreach).toBe(2);

    await call("POST", "/daily-activity", { kind: "prep_minutes", amount: 15 });
    res = await call("POST", "/daily-activity", { kind: "prep_minutes", amount: 30 });
    expect(DailyCountsSchema.parse(res.json())).toMatchObject({ outreach: 2, prepMinutes: 45 });

    for (const body of [
      { kind: "outreach", amount: 0 },
      { kind: "outreach", amount: 241 },
      { kind: "prep_minutes", amount: 1.5 },
      { kind: "emails", amount: 1 },
      {},
    ]) {
      res = await call("POST", "/daily-activity", body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json<ApiErrorBody>().error.code).toBe("validation_failed");
    }
    // The refused bodies changed nothing, and the counts landed on the owner-local day.
    const rows = await prisma.dailyActivity.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outreachCount: 2, prepMinutes: 45, followUps: 0 });
    expect(rows[0]?.day.toISOString()).toBe("2026-10-29T00:00:00.000Z");
  });

  it("concurrent taps are all counted", async () => {
    const { call } = await appWith();
    await Promise.all(
      Array.from({ length: 8 }, () =>
        call("POST", "/daily-activity", { kind: "outreach", amount: 1 }),
      ),
    );
    const res = await call("POST", "/daily-activity", { kind: "outreach", amount: 1 });
    expect(DailyCountsSchema.parse(res.json()).outreach).toBe(9);
  });

  it("keeps the follow-ups the pipeline counted", async () => {
    const { call } = await appWith();
    await prisma.dailyActivity.create({
      data: { day: new Date("2026-10-29T00:00:00.000Z"), followUps: 3 },
    });
    const res = await call("POST", "/daily-activity", { kind: "outreach", amount: 1 });
    expect(DailyCountsSchema.parse(res.json())).toMatchObject({ outreach: 1, followUps: 3 });
  });

  it("needs the CSRF header", async () => {
    const { app, cookie } = await appWith();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/daily-activity",
      headers: { cookie },
      payload: { kind: "outreach", amount: 1 },
    });
    expect(res.statusCode).toBe(403);
  });
});

// --- GET /nav-counts -----------------------------------------------------------------------------

describe("GET /nav-counts", () => {
  it("GET /nav-counts → { openApplications, newLeads, upcomingInterviews, openReview }", async () => {
    const { call } = await appWith();
    // Open: applied, screening, assessment, interviewing, offer.
    const open = await seedApplication({ status: "interviewing" });
    await seedApplication({ status: "applied" });
    await seedApplication({ status: "offer" });
    for (const status of ["rejected", "withdrawn", "abandoned", "accepted"] as const) {
      await seedApplication({ status });
    }
    // New leads that are ready, whenever they were found.
    await seedLead({ foundAt: at(-100) });
    await seedLead();
    await seedLead({ status: "shortlisted" });
    await seedLead({ pipelineState: "ranking" });
    // Upcoming interviews: the whole Upcoming set, with no 7-day window.
    await prisma.interview.createMany({
      data: [
        { applicationId: open.id, kind: "technical", status: "to_schedule" },
        { applicationId: open.id, kind: "technical", status: "scheduled", startsAt: at(24 * 30) },
        { applicationId: open.id, kind: "technical", status: "scheduled", startsAt: at(-2) },
        { applicationId: open.id, kind: "technical", status: "cancelled", startsAt: at(5) },
      ],
    });
    // Review: open items only.
    await prisma.reviewItem.createMany({
      data: [
        { kind: "low_confidence" },
        { kind: "ambiguous_match" },
        { kind: "extraction_failed", state: "resolved", resolvedAt: at(-1) },
      ],
    });

    const res = await call("GET", "/nav-counts");
    expect(res.statusCode).toBe(200);
    expect(NavCountsSchema.parse(res.json())).toEqual({
      openApplications: 3,
      newLeads: 2,
      upcomingInterviews: 2,
      openReview: 2,
    });
  });

  it("all zeros on an empty database", async () => {
    const { call } = await appWith();
    const res = await call("GET", "/nav-counts");
    expect(NavCountsSchema.parse(res.json())).toEqual({
      openApplications: 0,
      newLeads: 0,
      upcomingInterviews: 0,
      openReview: 0,
    });
  });

  it("requires a session", async () => {
    const { app } = await appWith();
    const res = await app.inject({ method: "GET", url: "/api/v1/nav-counts" });
    expect(res.statusCode).toBe(401);
  });
});
