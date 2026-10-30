import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  InterviewSchema,
  InterviewWithApplicationSchema,
  PageSchema,
  type ApiErrorBody,
  type InterviewWithApplication,
} from "@offerbound/contracts";
import { buildTestApp, signIn } from "../../test/app.js";
import { resetDb, testPrisma } from "../../test/db.js";
import { countUpcomingInterviews } from "./interviews.js";

const prisma = testPrisma();
const CSRF = { "x-offerbound-request": "1" };
// The test clock (test/app.ts): 2026-10-01T12:00:00.000Z.
const NOW = new Date("2026-10-01T12:00:00.000Z");
const at = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);

const apps: FastifyInstance[] = [];
async function appWith() {
  const built = await buildTestApp();
  apps.push(built.app);
  const cookie = await signIn(built.app, built.deps);
  const call = (method: "GET" | "PATCH", url: string, payload?: object) =>
    built.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { cookie, ...(method === "GET" ? {} : CSRF) },
      ...(payload ? { payload } : {}),
    });
  return { ...built, cookie, call };
}

beforeEach(async () => {
  await resetDb(prisma);
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

let seq = 0;
async function seedApplication(companyName: string, title = "Staff Engineer") {
  seq += 1;
  const company = await prisma.company.create({
    data: {
      name: companyName,
      normalizedName: `${companyName.toLowerCase()}-${seq}`,
      createdSource: "manual",
    },
  });
  return prisma.application.create({
    data: {
      companyId: company.id,
      title,
      status: "interviewing",
      statusChangedAt: at(-48),
      appliedAt: at(-72),
      source: "manual",
    },
  });
}

type InterviewSeed = {
  applicationId: string;
  status: "to_schedule" | "scheduled" | "completed" | "cancelled";
  startsAt?: Date | null;
  endsAt?: Date | null;
  kind?: "recruiter_screen" | "technical";
  notes?: string | null;
  createdAt?: Date;
};
function seedInterview(seed: InterviewSeed) {
  return prisma.interview.create({
    data: {
      applicationId: seed.applicationId,
      kind: seed.kind ?? "technical",
      status: seed.status,
      startsAt: seed.startsAt ?? null,
      endsAt: seed.endsAt ?? null,
      notes: seed.notes ?? null,
      ...(seed.createdAt && { createdAt: seed.createdAt }),
    },
  });
}

const PageOfInterviews = PageSchema(InterviewWithApplicationSchema);
const errorOf = (body: string) => (JSON.parse(body) as ApiErrorBody).error;

describe("GET /interviews", () => {
  it("upcoming lists to_schedule first, then scheduled interviews from now on, ascending, each with its application summary", async () => {
    const { call } = await appWith();
    const acme = await seedApplication("Acme Robotics", "Platform Engineer");
    const globex = await seedApplication("Globex Labs");
    const later = await seedInterview({
      applicationId: acme.id,
      status: "scheduled",
      startsAt: at(72),
    });
    const soon = await seedInterview({
      applicationId: globex.id,
      status: "scheduled",
      startsAt: at(2),
    });
    const toSchedule = await seedInterview({ applicationId: acme.id, status: "to_schedule" });
    // Not upcoming: already over, cancelled, completed.
    await seedInterview({ applicationId: acme.id, status: "scheduled", startsAt: at(-5) });
    await seedInterview({ applicationId: acme.id, status: "cancelled", startsAt: at(30) });
    await seedInterview({ applicationId: acme.id, status: "completed", startsAt: at(-30) });

    const res = await call("GET", "/interviews?range=upcoming");
    expect(res.statusCode).toBe(200);
    const page = PageOfInterviews.parse(res.json());
    expect(page.nextCursor).toBeNull();
    expect(page.items.map((i) => i.id)).toEqual([toSchedule.id, soon.id, later.id]);

    const [first, second] = page.items as [InterviewWithApplication, InterviewWithApplication];
    expect(first.startsAt).toBeNull();
    expect(first.application).toMatchObject({
      id: acme.id,
      company: { name: "Acme Robotics" },
      title: "Platform Engineer",
      status: "interviewing",
      // Acme's next scheduled interview, not the to_schedule one.
      nextInterviewAt: at(72).toISOString(),
    });
    expect(second.application).toMatchObject({
      company: { name: "Globex Labs" },
      nextInterviewAt: at(2).toISOString(),
    });
    expect(second.startsAt).toBe(at(2).toISOString());
  });

  it("an interview that starts exactly now is still upcoming", async () => {
    const { call } = await appWith();
    const app = await seedApplication("Acme Robotics");
    const row = await seedInterview({ applicationId: app.id, status: "scheduled", startsAt: NOW });
    const page = PageOfInterviews.parse((await call("GET", "/interviews?range=upcoming")).json());
    expect(page.items.map((i) => i.id)).toEqual([row.id]);
  });

  it("past lists completed, cancelled and earlier interviews, descending", async () => {
    const { call } = await appWith();
    const app = await seedApplication("Acme Robotics");
    const oldest = await seedInterview({
      applicationId: app.id,
      status: "completed",
      startsAt: at(-100),
    });
    const newest = await seedInterview({
      applicationId: app.id,
      status: "scheduled",
      startsAt: at(-1),
    });
    const middle = await seedInterview({
      applicationId: app.id,
      status: "cancelled",
      startsAt: at(-50),
    });
    // Cancelled interviews are past whatever their time: one still ahead, and one that never got a
    // time (it sorts by when it was created).
    const cancelledAhead = await seedInterview({
      applicationId: app.id,
      status: "cancelled",
      startsAt: at(30),
    });
    const cancelledUnscheduled = await seedInterview({
      applicationId: app.id,
      status: "cancelled",
      createdAt: at(-20),
    });
    // Not past: still ahead, or still to be scheduled.
    await seedInterview({ applicationId: app.id, status: "scheduled", startsAt: at(5) });
    await seedInterview({ applicationId: app.id, status: "to_schedule" });

    const page = PageOfInterviews.parse((await call("GET", "/interviews?range=past")).json());
    expect(page.items.map((i) => i.id)).toEqual([
      cancelledAhead.id,
      newest.id,
      cancelledUnscheduled.id,
      middle.id,
      oldest.id,
    ]);
    // ...and a cancelled interview is never upcoming.
    const upcoming = PageOfInterviews.parse(
      (await call("GET", "/interviews?range=upcoming")).json(),
    );
    expect(upcoming.items.map((i) => i.status).sort()).toEqual(["scheduled", "to_schedule"]);
    expect(await countUpcomingInterviews(prisma, NOW)).toBe(2);
  });

  it("pages with a cursor and never repeats or skips a row", async () => {
    const { call } = await appWith();
    const app = await seedApplication("Acme Robotics");
    const ids: string[] = [];
    ids.push((await seedInterview({ applicationId: app.id, status: "to_schedule" })).id);
    for (const hours of [1, 2, 2, 3, 4]) {
      ids.push(
        (await seedInterview({ applicationId: app.id, status: "scheduled", startsAt: at(hours) }))
          .id,
      );
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = `/interviews?range=upcoming&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const page = PageOfInterviews.parse((await call("GET", query)).json());
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(pages).toBe(3);
    expect([...seen].sort()).toEqual([...ids].sort());
    expect(new Set(seen).size).toBe(ids.length);
    expect(seen[0]).toBe(ids[0]);
  });

  it("countUpcomingInterviews counts exactly the upcoming list, so the nav badge agrees", async () => {
    const { call } = await appWith();
    const app = await seedApplication("Acme Robotics");
    await seedInterview({ applicationId: app.id, status: "to_schedule" });
    await seedInterview({ applicationId: app.id, status: "scheduled", startsAt: at(1) });
    await seedInterview({ applicationId: app.id, status: "scheduled", startsAt: at(400) });
    await seedInterview({ applicationId: app.id, status: "scheduled", startsAt: at(-1) });
    await seedInterview({ applicationId: app.id, status: "cancelled", startsAt: at(2) });
    await seedInterview({ applicationId: app.id, status: "completed", startsAt: at(-9) });
    const page = PageOfInterviews.parse((await call("GET", "/interviews?range=upcoming")).json());
    expect(await countUpcomingInterviews(prisma, NOW)).toBe(3);
    expect(page.items).toHaveLength(3);
  });

  it("rejects a missing or unknown range, a bad limit and a bad cursor", async () => {
    const { call } = await appWith();
    for (const url of [
      "/interviews",
      "/interviews?range=soon",
      "/interviews?range=past&limit=0",
      "/interviews?range=past&limit=201",
      "/interviews?range=past&cursor=nonsense",
    ]) {
      const res = await call("GET", url);
      expect(res.statusCode, url).toBe(400);
      expect(errorOf(res.body).code).toBe("validation_failed");
    }
  });

  it("requires a session", async () => {
    const { app } = await appWith();
    const res = await app.inject({ method: "GET", url: "/api/v1/interviews?range=past" });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res.body).code).toBe("unauthenticated");
  });
});

describe("PATCH /interviews/:id", () => {
  it("PATCH updates prep notes, times, kind or status with version; stale → 409", async () => {
    const { call } = await appWith();
    const app = await seedApplication("Acme Robotics");
    const row = await seedInterview({
      applicationId: app.id,
      status: "to_schedule",
      kind: "recruiter_screen",
    });

    // Prep notes.
    let res = await call("PATCH", `/interviews/${row.id}`, {
      version: 1,
      notes: "Review the platform roadmap",
    });
    expect(res.statusCode).toBe(200);
    expect(InterviewSchema.parse(res.json())).toMatchObject({
      id: row.id,
      version: 2,
      notes: "Review the platform roadmap",
      status: "to_schedule",
    });

    // Times and status together.
    res = await call("PATCH", `/interviews/${row.id}`, {
      version: 2,
      status: "scheduled",
      startsAt: "2026-10-05T15:00:00-06:00",
      endsAt: "2026-10-05T16:00:00-06:00",
    });
    expect(res.statusCode).toBe(200);
    expect(InterviewSchema.parse(res.json())).toMatchObject({
      version: 3,
      status: "scheduled",
      startsAt: "2026-10-05T21:00:00.000Z",
      endsAt: "2026-10-05T22:00:00.000Z",
    });

    // Kind, link, location and interviewers; an omitted field is left alone.
    res = await call("PATCH", `/interviews/${row.id}`, {
      version: 3,
      kind: "system_design",
      meetingUrl: "https://meet.example/abc",
      location: "Video call",
      interviewers: ["Ana Torres", "Luis Vega"],
    });
    expect(res.statusCode).toBe(200);
    expect(InterviewSchema.parse(res.json())).toMatchObject({
      version: 4,
      kind: "system_design",
      meetingUrl: "https://meet.example/abc",
      location: "Video call",
      interviewers: ["Ana Torres", "Luis Vega"],
      notes: "Review the platform roadmap",
      startsAt: "2026-10-05T21:00:00.000Z",
    });

    // Clearing a nullable field with null.
    res = await call("PATCH", `/interviews/${row.id}`, { version: 4, notes: null });
    expect(InterviewSchema.parse(res.json()).notes).toBeNull();

    // A stale version → 409 with the record as it is now, and nothing is written.
    res = await call("PATCH", `/interviews/${row.id}`, { version: 2, notes: "Lost update" });
    expect(res.statusCode).toBe(409);
    const body = res.json<ApiErrorBody & { current: unknown }>();
    expect(body.error.code).toBe("version_conflict");
    expect(InterviewSchema.parse(body.current)).toMatchObject({
      id: row.id,
      version: 5,
      notes: null,
    });
    const stored = await prisma.interview.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored.version).toBe(5);
    expect(stored.notes).toBeNull();
  });

  it("writes one owner event per change that cannot be undone, without the notes text", async () => {
    const { call } = await appWith();
    const app = await seedApplication("Acme Robotics");
    const row = await seedInterview({
      applicationId: app.id,
      status: "scheduled",
      startsAt: at(24),
    });

    await call("PATCH", `/interviews/${row.id}`, { version: 1, notes: "secret prep plan" });
    await call("PATCH", `/interviews/${row.id}`, {
      version: 2,
      startsAt: at(48).toISOString(),
    });
    await call("PATCH", `/interviews/${row.id}`, { version: 3, status: "cancelled" });
    await call("PATCH", `/interviews/${row.id}`, { version: 4, status: "completed" });

    const events = await prisma.event.findMany({
      where: { applicationId: app.id },
      orderBy: { createdAt: "asc" },
    });
    expect(events.map((e) => e.type)).toEqual([
      "note_updated",
      "interview_updated",
      "interview_cancelled",
      "interview_completed",
    ]);
    expect(events.map((e) => (e.data as { fields: string[] }).fields)).toEqual([
      ["notes"],
      ["startsAt"],
      ["status"],
      ["status"],
    ]);
    for (const event of events) {
      expect(event).toMatchObject({ actor: "owner", undoable: false, occurredAt: NOW });
      expect(event.data).toMatchObject({ interviewId: row.id });
      expect(event.changeSet).toBeNull();
      expect(JSON.stringify(event)).not.toContain("secret prep plan");
    }
  });

  it("a patch that changes nothing keeps the version and writes no event", async () => {
    const { call } = await appWith();
    const app = await seedApplication("Acme Robotics");
    const row = await seedInterview({
      applicationId: app.id,
      status: "scheduled",
      startsAt: at(24),
      notes: "same",
    });
    const res = await call("PATCH", `/interviews/${row.id}`, {
      version: 1,
      notes: "same",
      status: "scheduled",
    });
    expect(res.statusCode).toBe(200);
    expect(InterviewSchema.parse(res.json()).version).toBe(1);
    expect(await prisma.event.count()).toBe(0);
  });

  it("answers 404 for an unknown interview and 400 for an invalid body", async () => {
    const { call } = await appWith();
    const app = await seedApplication("Acme Robotics");
    const row = await seedInterview({ applicationId: app.id, status: "to_schedule" });

    let res = await call("PATCH", "/interviews/6f1f3b0e-6a53-4a39-a4f6-7a8f6e0d3c11", {
      version: 1,
      notes: "x",
    });
    expect(res.statusCode).toBe(404);
    expect(errorOf(res.body).code).toBe("not_found");

    res = await call("PATCH", "/interviews/not-a-uuid", { version: 1, notes: "x" });
    expect(res.statusCode).toBe(404);

    // No version.
    res = await call("PATCH", `/interviews/${row.id}`, { notes: "x" });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res.body).fields).toHaveProperty("version");

    // A time without an offset, an unknown kind.
    for (const body of [
      { version: 1, startsAt: "2026-10-05T15:00:00" },
      { version: 1, kind: "coffee_chat" },
    ]) {
      res = await call("PATCH", `/interviews/${row.id}`, body);
      expect(res.statusCode).toBe(400);
      expect(errorOf(res.body).code).toBe("validation_failed");
    }
  });

  it("refuses a scheduled interview with no start and an end before the start, without writing", async () => {
    const { call } = await appWith();
    const app = await seedApplication("Acme Robotics");
    const row = await seedInterview({ applicationId: app.id, status: "to_schedule" });

    let res = await call("PATCH", `/interviews/${row.id}`, { version: 1, status: "scheduled" });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res.body).fields).toHaveProperty("startsAt");

    res = await call("PATCH", `/interviews/${row.id}`, {
      version: 1,
      startsAt: "2026-10-05T16:00:00Z",
      endsAt: "2026-10-05T15:00:00Z",
    });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res.body).fields).toHaveProperty("endsAt");

    expect((await prisma.interview.findUniqueOrThrow({ where: { id: row.id } })).version).toBe(1);
  });

  it("moves an interview between the lists when its status or time changes", async () => {
    const { call } = await appWith();
    const app = await seedApplication("Acme Robotics");
    const row = await seedInterview({
      applicationId: app.id,
      status: "scheduled",
      startsAt: at(24),
    });
    const ids = async (range: string) =>
      PageOfInterviews.parse((await call("GET", `/interviews?range=${range}`)).json()).items.map(
        (i) => i.id,
      );
    expect(await ids("upcoming")).toEqual([row.id]);
    await call("PATCH", `/interviews/${row.id}`, { version: 1, status: "completed" });
    expect(await ids("upcoming")).toEqual([]);
    expect(await ids("past")).toEqual([row.id]);
  });
});
