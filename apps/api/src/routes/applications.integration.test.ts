import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ApplicationDetailSchema,
  ApplicationSummarySchema,
  InterviewSchema,
  PageSchema,
  type ApiErrorBody,
  type ApplicationDetail,
  type ApplicationStatus,
} from "@offerbound/contracts";
import { Prisma } from "@prisma/client";
import { buildTestApp, signIn } from "../../test/app.js";
import { resetDb, testPrisma } from "../../test/db.js";
import { withIntakeLock } from "../db/lock.js";
import { resolveCompanyForOwner } from "./applications.js";

const prisma = testPrisma();
const CSRF = { "x-offerbound-request": "1" };
// The test clock (test/app.ts): 2026-10-01T12:00:00.000Z, which is 06:00 on 2026-10-01 in Monterrey.
const NOW = new Date("2026-10-01T12:00:00.000Z");
const at = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);

const apps: FastifyInstance[] = [];
async function appWith() {
  const built = await buildTestApp();
  apps.push(built.app);
  const cookie = await signIn(built.app, built.deps);
  const call = (method: "GET" | "POST" | "PATCH", url: string, payload?: object) =>
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
async function seedCompany(name: string) {
  seq += 1;
  return prisma.company.create({
    data: { name, normalizedName: `${name.toLowerCase()}-${seq}`, createdSource: "manual" },
  });
}

type AppSeed = {
  company: string;
  title?: string;
  status?: ApplicationStatus;
  appliedAt?: Date | null;
  lastCompanyActivityAt?: Date | null;
  createdAt?: Date;
  followUpDue?: boolean;
  notes?: string | null;
};
async function seedApplication(seed: AppSeed) {
  const company = await seedCompany(seed.company);
  return prisma.application.create({
    data: {
      companyId: company.id,
      title: seed.title ?? "Staff Engineer",
      status: seed.status ?? "applied",
      statusChangedAt: at(-48),
      appliedAt: seed.appliedAt === undefined ? at(-72) : seed.appliedAt,
      lastCompanyActivityAt: seed.lastCompanyActivityAt ?? null,
      followUpDue: seed.followUpDue ?? false,
      notes: seed.notes ?? null,
      source: "manual",
      ...(seed.createdAt && { createdAt: seed.createdAt }),
    },
  });
}

const PageOfSummaries = PageSchema(ApplicationSummarySchema);
const errorOf = (body: string) => (JSON.parse(body) as ApiErrorBody).error;
const detailOf = (body: string): ApplicationDetail =>
  ApplicationDetailSchema.parse(JSON.parse(body));

describe("GET /applications", () => {
  it("lists with status[] multi-select, followUpDue, q on company or role, and cursor pagination", async () => {
    const { call } = await appWith();
    const acme = await seedApplication({ company: "Acme Robotics", title: "Platform Engineer" });
    const globex = await seedApplication({
      company: "Globex Labs",
      title: "Backend Engineer",
      status: "screening",
      followUpDue: true,
    });
    const initech = await seedApplication({
      company: "Initech",
      title: "Robotics Lead",
      status: "rejected",
    });
    const ids = (page: { items: { id: string }[] }) => page.items.map((i) => i.id).sort();

    // The exact query the web sends: repeated status, followUpDue=true, q, sort, limit.
    const multi = PageOfSummaries.parse(
      (
        await call(
          "GET",
          "/applications?status=applied&status=screening&sort=last_activity&limit=25",
        )
      ).json(),
    );
    expect(ids(multi)).toEqual([acme.id, globex.id].sort());
    expect(multi.nextCursor).toBeNull();

    // A single status value, and the bracketed spelling of the spec.
    const single = PageOfSummaries.parse(
      (await call("GET", "/applications?status=rejected")).json(),
    );
    expect(ids(single)).toEqual([initech.id]);
    const bracketed = PageOfSummaries.parse(
      (await call("GET", "/applications?status[]=rejected&status[]=screening")).json(),
    );
    expect(ids(bracketed)).toEqual([globex.id, initech.id].sort());

    const due = PageOfSummaries.parse((await call("GET", "/applications?followUpDue=true")).json());
    expect(due.items.map((i) => i.id)).toEqual([globex.id]);
    expect(due.items[0]).toMatchObject({ company: { name: "Globex Labs" }, followUpDue: true });

    // q matches the company or the role, ignoring case.
    const byRole = PageOfSummaries.parse((await call("GET", "/applications?q=ROBOTICS")).json());
    expect(ids(byRole)).toEqual([acme.id, initech.id].sort());
    const byCompany = PageOfSummaries.parse((await call("GET", "/applications?q=globex")).json());
    expect(ids(byCompany)).toEqual([globex.id]);
    const wildcard = PageOfSummaries.parse((await call("GET", "/applications?q=%25")).json());
    expect(wildcard.items).toEqual([]);

    // Pagination walks every row exactly once.
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 5; guard += 1) {
      const url: string = `/applications?limit=2${cursor ? `&cursor=${cursor}` : ""}`;
      const page = PageOfSummaries.parse((await call("GET", url)).json());
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);

    const bad = await call("GET", "/applications?status=hired");
    expect(bad.statusCode).toBe(400);
    expect(errorOf(bad.body).code).toBe("validation_failed");
    const badCursor = await call("GET", "/applications?cursor=nope");
    expect(badCursor.statusCode).toBe(400);
  });

  it("sorts by last activity by default (coalesce of last_company_activity_at, applied_at, created_at, descending), or by applied date or status", async () => {
    const { call } = await appWith();
    // Activity: replied (T-1h) > applied (T-10h) > created only (T-30h).
    const replied = await seedApplication({
      company: "Replied Co",
      status: "interviewing",
      appliedAt: at(-500),
      lastCompanyActivityAt: at(-1),
    });
    const appliedOnly = await seedApplication({
      company: "Applied Co",
      status: "applied",
      appliedAt: at(-10),
    });
    const createdOnly = await seedApplication({
      company: "Created Co",
      status: "offer",
      appliedAt: null,
      createdAt: at(-30),
    });
    const order = async (query: string) =>
      PageOfSummaries.parse((await call("GET", `/applications${query}`)).json()).items.map(
        (i) => i.id,
      );

    expect(await order("")).toEqual([replied.id, appliedOnly.id, createdOnly.id]);
    expect(await order("?sort=last_activity")).toEqual([
      replied.id,
      appliedOnly.id,
      createdOnly.id,
    ]);
    // Applied date, newest first; no applied date last.
    expect(await order("?sort=applied")).toEqual([appliedOnly.id, replied.id, createdOnly.id]);
    // Pipeline order: applied, interviewing, offer.
    expect(await order("?sort=status")).toEqual([appliedOnly.id, replied.id, createdOnly.id]);

    // Every sort pages without skipping or repeating a row.
    for (const sort of ["last_activity", "applied", "status"]) {
      const first = PageOfSummaries.parse(
        (await call("GET", `/applications?sort=${sort}&limit=2`)).json(),
      );
      expect(first.items).toHaveLength(2);
      const second = PageOfSummaries.parse(
        (await call("GET", `/applications?sort=${sort}&limit=2&cursor=${first.nextCursor}`)).json(),
      );
      expect([...first.items, ...second.items].map((i) => i.id)).toEqual(
        await order(`?sort=${sort}`),
      );
      expect(second.nextCursor).toBeNull();
    }
    // A cursor made for one sort is refused by another.
    const page = PageOfSummaries.parse((await call("GET", "/applications?limit=1")).json());
    const mismatched = await call(
      "GET",
      `/applications?sort=status&limit=1&cursor=${page.nextCursor}`,
    );
    expect(mismatched.statusCode).toBe(400);
  });

  it("each summary carries the earliest scheduled interview from now on as nextInterviewAt", async () => {
    const { call } = await appWith();
    const app = await seedApplication({ company: "Acme Robotics" });
    await prisma.interview.createMany({
      data: [
        { applicationId: app.id, kind: "technical", status: "scheduled", startsAt: at(48) },
        { applicationId: app.id, kind: "technical", status: "scheduled", startsAt: at(24) },
        { applicationId: app.id, kind: "technical", status: "scheduled", startsAt: at(-24) },
        { applicationId: app.id, kind: "technical", status: "cancelled", startsAt: at(2) },
      ],
    });
    const page = PageOfSummaries.parse((await call("GET", "/applications")).json());
    expect(page.items[0]?.nextInterviewAt).toBe(at(24).toISOString());
  });
});

describe("POST /applications", () => {
  it("creates a manual application, resolving the company by name, with an owner application_created event", async () => {
    const { call } = await appWith();
    const existing = await prisma.company.create({
      data: {
        name: "Acme Robotics, Inc.",
        normalizedName: "acme robotics",
        aliases: ["acme"],
        createdSource: "gmail",
      },
    });
    const body = {
      companyName: "ACME Robotics",
      title: "Platform Engineer",
      jobUrl: "https://jobs.acme.example/platform",
      status: "applied",
      appliedAt: "2026-09-30T15:00:00.000Z",
      notes: "Referred by a friend",
    };

    const res = await call("POST", "/applications", body);
    expect(res.statusCode).toBe(201);
    const detail = detailOf(res.body);
    // The existing company is reused (same normalised name), not duplicated.
    expect(detail.company).toEqual({ id: existing.id, name: "Acme Robotics, Inc." });
    expect(detail).toMatchObject({
      title: "Platform Engineer",
      status: "applied",
      source: "manual",
      version: 1,
      jobUrl: body.jobUrl,
      appliedAt: body.appliedAt,
      notes: body.notes,
      statusChangedAt: NOW.toISOString(),
      followUpDue: false,
      leadId: null,
    });
    expect(await prisma.company.count()).toBe(1);
    expect(detail.timeline).toHaveLength(1);
    expect(detail.timeline[0]).toMatchObject({
      type: "application_created",
      actor: "owner",
      toStatus: "applied",
      undoable: false,
      undoneAt: null,
    });

    // A company the owner has never mentioned is created, by alias too.
    const viaAlias = await call("POST", "/applications", {
      ...body,
      companyName: "acme",
      title: "SRE",
    });
    expect(detailOf(viaAlias.body).company.id).toBe(existing.id);
    const fresh = await call("POST", "/applications", {
      ...body,
      companyName: "Globex Labs",
      status: "offer",
      appliedAt: null,
      jobUrl: null,
      notes: null,
    });
    expect(fresh.statusCode).toBe(201);
    const created = detailOf(fresh.body);
    expect(created.company.name).toBe("Globex Labs");
    expect(created.status).toBe("offer");
    expect(created.timeline[0]?.toStatus).toBe("offer");
    const company = await prisma.company.findUniqueOrThrow({ where: { id: created.company.id } });
    expect(company).toMatchObject({ normalizedName: "globex labs", createdSource: "manual" });
  });

  it("rejects an invalid body", async () => {
    const { call } = await appWith();
    const res = await call("POST", "/applications", { companyName: " ", title: "x" });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res.body).code).toBe("validation_failed");
  });
});

describe("PATCH /applications/:id", () => {
  it("PATCH any field; a manual status change ignores the transition table and writes an owner status_changed event that isn't undoable", async () => {
    const { call } = await appWith();
    const app = await seedApplication({
      company: "Acme Robotics",
      status: "offer",
      followUpDue: false,
    });

    // Offer -> applied is not in any transition table; the owner can do it.
    const res = await call("PATCH", `/applications/${app.id}`, { version: 1, status: "applied" });
    expect(res.statusCode).toBe(200);
    const moved = detailOf(res.body);
    expect(moved).toMatchObject({
      status: "applied",
      version: 2,
      statusChangedAt: NOW.toISOString(),
    });
    expect(moved.timeline[0]).toMatchObject({
      type: "status_changed",
      actor: "owner",
      toStatus: "applied",
      undoable: false,
    });
    const event = await prisma.event.findFirstOrThrow({
      where: { applicationId: app.id, type: "status_changed" },
    });
    expect(event.data).toMatchObject({ fromStatus: "offer", toStatus: "applied" });
    expect(event.undoable).toBe(false);

    // Every other field, in one request.
    const all = await call("PATCH", `/applications/${app.id}`, {
      version: 2,
      title: "Principal Engineer",
      jobUrl: "https://jobs.acme.example/principal",
      appliedAt: "2026-09-15T10:00:00.000Z",
      notes: "Second round went well",
      locationText: "Monterrey, Mexico",
      country: "MX",
      workMode: "hybrid",
      compensationText: "USD 150k",
      sponsorshipText: "Not needed",
    });
    expect(all.statusCode).toBe(200);
    const full = detailOf(all.body);
    expect(full).toMatchObject({
      version: 3,
      title: "Principal Engineer",
      jobUrl: "https://jobs.acme.example/principal",
      appliedAt: "2026-09-15T10:00:00.000Z",
      notes: "Second round went well",
      locationText: "Monterrey, Mexico",
      country: "MX",
      workMode: "hybrid",
      compensationText: "USD 150k",
      sponsorshipText: "Not needed",
    });
    // Status didn't change: its timestamp stays.
    expect(full.statusChangedAt).toBe(NOW.toISOString());
    expect(full.timeline[0]).toMatchObject({
      type: "field_updated",
      actor: "owner",
      undoable: false,
    });
    // Notes are never quoted in the timeline.
    expect(JSON.stringify(full.timeline)).not.toContain("Second round");

    // Notes alone read as a note update.
    const note = detailOf(
      (await call("PATCH", `/applications/${app.id}`, { version: 3, notes: null })).body,
    );
    expect(note.timeline[0]?.type).toBe("note_updated");

    // A patch that changes nothing keeps the version and writes no event.
    const before = await prisma.event.count({ where: { applicationId: app.id } });
    const same = detailOf(
      (await call("PATCH", `/applications/${app.id}`, { version: 4, title: "Principal Engineer" }))
        .body,
    );
    expect(same.version).toBe(4);
    expect(await prisma.event.count({ where: { applicationId: app.id } })).toBe(before);
  });

  it("abandoning remembers the status before, and leaving Abandoned forgets it; terminal statuses clear the follow-up flag", async () => {
    const { call } = await appWith();
    const app = await seedApplication({
      company: "Acme Robotics",
      status: "screening",
      followUpDue: true,
    });
    const abandoned = detailOf(
      (await call("PATCH", `/applications/${app.id}`, { version: 1, status: "abandoned" })).body,
    );
    expect(abandoned).toMatchObject({ status: "abandoned", followUpDue: false });
    expect(abandoned.timeline[0]?.toStatus).toBe("abandoned");
    let row = await prisma.application.findUniqueOrThrow({ where: { id: app.id } });
    expect(row.statusBeforeAbandon).toBe("screening");
    expect(row.followUpDueSince).toBeNull();

    await call("PATCH", `/applications/${app.id}`, { version: 2, status: "interviewing" });
    row = await prisma.application.findUniqueOrThrow({ where: { id: app.id } });
    expect(row).toMatchObject({ status: "interviewing", statusBeforeAbandon: null });
  });

  it("a status PATCH records fromStatus and toStatus in the event data, the keys the pipeline and the timers read", async () => {
    const { call } = await appWith();
    const app = await seedApplication({ company: "Acme Robotics", status: "abandoned" });
    await call("PATCH", `/applications/${app.id}`, { version: 1, status: "screening" });
    await call("PATCH", `/applications/${app.id}`, { version: 2, status: "abandoned" });
    const events = await prisma.event.findMany({
      where: { applicationId: app.id, type: "status_changed" },
      orderBy: { createdAt: "asc" },
    });
    // Out of abandoned: the timers read this as a manual reopen.
    expect(events[0]?.data).toEqual({ fromStatus: "abandoned", toStatus: "screening" });
    expect(events[1]?.data).toEqual({ fromStatus: "screening", toStatus: "abandoned" });
    expect(events.every((e) => e.actor === "owner" && !e.undoable)).toBe(true);
  });

  it("PATCH companyName moves the application to the company with that name", async () => {
    const { call } = await appWith();
    const app = await seedApplication({ company: "Acme Robotics" });
    const globex = await prisma.company.create({
      data: { name: "Globex Labs", normalizedName: "globex labs", createdSource: "manual" },
    });
    const res = await call("PATCH", `/applications/${app.id}`, {
      version: 1,
      companyName: "Globex Labs, Inc.",
    });
    // Resolves by normalised name, as everywhere else.
    expect(res.statusCode).toBe(200);
    expect(detailOf(res.body).company.id).toBe(globex.id);

    const created = await call("PATCH", `/applications/${app.id}`, {
      version: 2,
      companyName: "Initech",
    });
    expect(detailOf(created.body).company.name).toBe("Initech");
  });

  it("PATCH with a stale version → 409 version_conflict with the current record", async () => {
    const { call } = await appWith();
    const app = await seedApplication({ company: "Acme Robotics", title: "Platform Engineer" });
    await call("PATCH", `/applications/${app.id}`, { version: 1, title: "Staff Engineer" });

    const res = await call("PATCH", `/applications/${app.id}`, { version: 1, title: "Intern" });
    expect(res.statusCode).toBe(409);
    const body = res.json<ApiErrorBody & { current: unknown }>();
    expect(body.error.code).toBe("version_conflict");
    const current = ApplicationDetailSchema.parse(body.current);
    expect(current).toMatchObject({ id: app.id, version: 2, title: "Staff Engineer" });
    expect((await prisma.application.findUniqueOrThrow({ where: { id: app.id } })).title).toBe(
      "Staff Engineer",
    );
  });

  it("an unknown or malformed id → 404; a bad body → 400", async () => {
    const { call } = await appWith();
    const unknown = await call("PATCH", "/applications/6f9619ff-8b86-4011-b42d-00c04fc964ff", {
      version: 1,
      title: "x",
    });
    expect(unknown.statusCode).toBe(404);
    expect(errorOf(unknown.body).code).toBe("not_found");
    expect((await call("PATCH", "/applications/not-a-uuid", { version: 1 })).statusCode).toBe(404);
    const app = await seedApplication({ company: "Acme Robotics" });
    const bad = await call("PATCH", `/applications/${app.id}`, { version: 1, status: "hired" });
    expect(bad.statusCode).toBe(400);
    expect((await call("PATCH", `/applications/${app.id}`, { title: "x" })).statusCode).toBe(400);
  });
});

describe("POST /applications/:id/follow-up-done", () => {
  it("follow-up-done clears the flag, sets follow_up_done_at, adds 1 to today's follow_ups and writes follow_up_done", async () => {
    const { call } = await appWith();
    const app = await seedApplication({ company: "Acme Robotics", followUpDue: true });
    await prisma.application.update({
      where: { id: app.id },
      data: { followUpDueSince: at(-24) },
    });
    // Today is 2026-10-01 in Monterrey; the counter already has a value.
    await prisma.dailyActivity.create({
      data: { day: new Date("2026-10-01T00:00:00.000Z"), followUps: 2, outreachCount: 1 },
    });

    const res = await call("POST", `/applications/${app.id}/follow-up-done`);
    expect(res.statusCode).toBe(200);
    const detail = detailOf(res.body);
    expect(detail).toMatchObject({ followUpDue: false, version: 2 });
    expect(detail.timeline[0]).toMatchObject({
      type: "follow_up_done",
      actor: "owner",
      undoable: false,
    });

    const row = await prisma.application.findUniqueOrThrow({ where: { id: app.id } });
    expect(row.followUpDoneAt?.toISOString()).toBe(NOW.toISOString());
    expect(row.followUpDueSince).toBeNull();
    const day = await prisma.dailyActivity.findUniqueOrThrow({
      where: { day: new Date("2026-10-01T00:00:00.000Z") },
    });
    expect(day).toMatchObject({ followUps: 3, outreachCount: 1 });

    // Pressing it again (a double tap) counts nothing more.
    const again = await call("POST", `/applications/${app.id}/follow-up-done`);
    expect(again.statusCode).toBe(200);
    expect(detailOf(again.body).version).toBe(2);
    expect(
      (await prisma.dailyActivity.findUniqueOrThrow({ where: { day: day.day } })).followUps,
    ).toBe(3);
    expect(await prisma.event.count({ where: { type: "follow_up_done" } })).toBe(1);
  });

  it("creates the day's row when there is none, and counts on the owner's local day", async () => {
    const { call } = await appWith();
    const app = await seedApplication({ company: "Acme Robotics", followUpDue: true });
    await call("POST", `/applications/${app.id}/follow-up-done`);
    const rows = await prisma.dailyActivity.findMany();
    expect(rows.map((r) => [r.day.toISOString(), r.followUps])).toEqual([
      ["2026-10-01T00:00:00.000Z", 1],
    ]);
  });

  it("an unknown id → 404", async () => {
    const { call } = await appWith();
    const res = await call(
      "POST",
      "/applications/6f9619ff-8b86-4011-b42d-00c04fc964ff/follow-up-done",
    );
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /applications/:id/interviews", () => {
  it("POST /applications/:id/interviews creates an interview", async () => {
    const { call } = await appWith();
    const app = await seedApplication({ company: "Acme Robotics", status: "screening" });
    const res = await call("POST", `/applications/${app.id}/interviews`, {
      kind: "technical",
      status: "scheduled",
      startsAt: "2026-10-05T16:00:00.000Z",
      endsAt: "2026-10-05T17:00:00.000Z",
      meetingUrl: "https://meet.acme.example/room",
      location: null,
      interviewers: ["Dana Example"],
      notes: "Prep system design",
    });
    expect(res.statusCode).toBe(201);
    const interview = InterviewSchema.parse(res.json());
    expect(interview).toMatchObject({
      applicationId: app.id,
      version: 1,
      kind: "technical",
      status: "scheduled",
      startsAt: "2026-10-05T16:00:00.000Z",
      endsAt: "2026-10-05T17:00:00.000Z",
      meetingUrl: "https://meet.acme.example/room",
      interviewers: ["Dana Example"],
      notes: "Prep system design",
    });

    const event = await prisma.event.findFirstOrThrow({
      where: { applicationId: app.id, type: "interview_created" },
    });
    expect(event).toMatchObject({ actor: "owner", undoable: false });
    // 2026-10-05T16:00Z is 10:00 in Monterrey; notes stay out of the timeline.
    expect(event.summary).toBe("Interview scheduled for Mon, Oct 5, 10:00");
    expect(JSON.stringify(event)).not.toContain("Prep system design");

    // It shows on the detail and as the application's next interview.
    const detail = detailOf((await call("GET", `/applications/${app.id}`)).body);
    expect(detail.interviews.map((i) => i.id)).toEqual([interview.id]);
    expect(detail.nextInterviewAt).toBe("2026-10-05T16:00:00.000Z");

    // No time yet: to schedule.
    const open = await call("POST", `/applications/${app.id}/interviews`, {
      kind: "recruiter_screen",
      status: "to_schedule",
      startsAt: null,
      endsAt: null,
      meetingUrl: null,
      location: null,
      interviewers: [],
      notes: null,
    });
    expect(open.statusCode).toBe(201);
    expect(
      (await prisma.event.findFirstOrThrow({ where: { summary: "Interview to schedule" } })).type,
    ).toBe("interview_created");
  });

  it("a scheduled interview needs a start, an end can't precede it, and an unknown application → 404", async () => {
    const { call } = await appWith();
    const app = await seedApplication({ company: "Acme Robotics" });
    const base = {
      kind: "technical",
      status: "scheduled",
      startsAt: null,
      endsAt: null,
      meetingUrl: null,
      location: null,
      interviewers: [],
      notes: null,
    };
    const noStart = await call("POST", `/applications/${app.id}/interviews`, base);
    expect(noStart.statusCode).toBe(400);
    expect(errorOf(noStart.body).fields).toEqual({ startsAt: "required_when_scheduled" });
    const backwards = await call("POST", `/applications/${app.id}/interviews`, {
      ...base,
      startsAt: "2026-10-05T16:00:00.000Z",
      endsAt: "2026-10-05T15:00:00.000Z",
    });
    expect(backwards.statusCode).toBe(400);
    expect(errorOf(backwards.body).fields).toEqual({ endsAt: "before_start" });
    const unknown = await call(
      "POST",
      "/applications/6f9619ff-8b86-4011-b42d-00c04fc964ff/interviews",
      {
        ...base,
        status: "to_schedule",
      },
    );
    expect(unknown.statusCode).toBe(404);
    expect(await prisma.interview.count()).toBe(0);
  });
});

describe("GET /applications/:id", () => {
  it("the detail has interviews, messages and the timeline; an unknown id → 404", async () => {
    const { call } = await appWith();
    const app = await seedApplication({
      company: "Acme Robotics",
      title: "Platform Engineer",
      status: "interviewing",
    });
    await prisma.application.update({
      where: { id: app.id },
      data: {
        jobUrl: "https://jobs.acme.example/platform",
        locationText: "Remote, Mexico",
        compensationText: "USD 120k",
        sponsorshipText: "None",
        notes: "Strong team",
        country: "MX",
        workMode: "remote",
      },
    });
    await prisma.gmailMessage.createMany({
      data: [
        {
          id: "m-old",
          threadId: "t1",
          internalDate: at(-60),
          direction: "inbound",
          labelIds: [],
          state: "applied",
          category: "application_confirmation",
          fromEmail: "jobs@acme.example",
          fromName: "Acme Jobs",
          subject: "We got your application",
          summary: "Application received",
          bodyText: "SECRET BODY",
          applicationId: app.id,
        },
        {
          id: "m-new",
          threadId: "t1",
          internalDate: at(-10),
          direction: "inbound",
          labelIds: [],
          state: "applied",
          category: "interview_invite",
          fromEmail: "dana@acme.example",
          fromName: "Dana Example",
          subject: "Interview",
          summary: "Invitation to interview",
          applicationId: app.id,
        },
        // Someone else's message is not listed.
        {
          id: "m-other",
          threadId: "t9",
          internalDate: at(-5),
          direction: "inbound",
          labelIds: [],
          state: "skipped",
        },
      ],
    });
    const later = await prisma.interview.create({
      data: { applicationId: app.id, kind: "technical", status: "scheduled", startsAt: at(48) },
    });
    const sooner = await prisma.interview.create({
      data: {
        applicationId: app.id,
        kind: "recruiter_screen",
        status: "scheduled",
        startsAt: at(24),
      },
    });
    const unscheduled = await prisma.interview.create({
      data: { applicationId: app.id, kind: "behavioral", status: "to_schedule" },
    });
    await prisma.event.createMany({
      data: [
        {
          applicationId: app.id,
          type: "application_created",
          actor: "system",
          occurredAt: at(-72),
          summary: "Application created",
          data: { toStatus: "applied" },
          undoable: true,
          undoneAt: at(-71),
        },
        {
          applicationId: app.id,
          type: "status_changed",
          actor: "system",
          occurredAt: at(-20),
          messageId: "m-new",
          summary: "Moved to Interviewing",
          data: { fromStatus: "applied", toStatus: "interviewing" },
          undoable: true,
        },
        {
          applicationId: app.id,
          type: "email_received",
          actor: "system",
          occurredAt: at(-10),
          summary: "Email from Acme Robotics",
          undoable: false,
        },
      ],
    });

    const res = await call("GET", `/applications/${app.id}`);
    expect(res.statusCode).toBe(200);
    const detail = detailOf(res.body);
    expect(detail).toMatchObject({
      id: app.id,
      title: "Platform Engineer",
      company: { name: "Acme Robotics" },
      jobUrl: "https://jobs.acme.example/platform",
      locationText: "Remote, Mexico",
      compensationText: "USD 120k",
      sponsorshipText: "None",
      notes: "Strong team",
      country: "MX",
      workMode: "remote",
      leadId: null,
      nextInterviewAt: at(24).toISOString(),
    });
    // Messages: internal_date descending; the body text is only fetched on demand.
    expect(detail.messages.map((m) => m.id)).toEqual(["m-new", "m-old"]);
    expect(detail.messages[1]).toEqual({
      id: "m-old",
      internalDate: at(-60).toISOString(),
      direction: "inbound",
      fromName: "Acme Jobs",
      fromEmail: "jobs@acme.example",
      subject: "We got your application",
      summary: "Application received",
      category: "application_confirmation",
    });
    expect(res.body).not.toContain("SECRET BODY");
    expect(new Set(detail.interviews.map((i) => i.id))).toEqual(
      new Set([later.id, sooner.id, unscheduled.id]),
    );
    expect(detail.interviews.map((i) => i.id)).toEqual([unscheduled.id, sooner.id, later.id]);
    // Timeline: newest first, with undoable, undoneAt and toStatus.
    expect(detail.timeline.map((t) => t.type)).toEqual([
      "email_received",
      "status_changed",
      "application_created",
    ]);
    expect(detail.timeline[1]).toMatchObject({
      messageId: "m-new",
      toStatus: "interviewing",
      undoable: true,
      undoneAt: null,
      actor: "system",
    });
    expect(detail.timeline[2]).toMatchObject({
      toStatus: "applied",
      undoable: true,
      undoneAt: at(-71).toISOString(),
    });
    expect(detail.timeline[0]?.toStatus).toBeNull();

    expect(
      (await call("GET", "/applications/6f9619ff-8b86-4011-b42d-00c04fc964ff")).statusCode,
    ).toBe(404);
    expect((await call("GET", "/applications/not-a-uuid")).statusCode).toBe(404);
  });
});

describe("POST /applications/:id/merge", () => {
  it("moves emails, interviews and timeline to the target, deletes the source and answers the target's detail", async () => {
    const { call } = await appWith();
    const batch = await prisma.intakeBatch.create({ data: { kind: "manual", counts: {} } });
    const lead = await prisma.lead.create({
      data: {
        companyId: (await seedCompany("Acme Robotics")).id,
        intakeBatchId: batch.id,
        title: "Platform Engineer",
        status: "applied",
        statusChangedAt: at(-80),
        pipelineState: "ready",
        foundAt: at(-90),
        source: "manual",
      },
    });
    const source = await seedApplication({
      company: "Acme Robotics Mexico",
      title: "Platform Engineer",
      status: "screening",
      lastCompanyActivityAt: at(-2),
      appliedAt: at(-100),
      followUpDue: false,
    });
    const target = await seedApplication({
      company: "Acme Robotics",
      title: "Platform Engineer",
      status: "applied",
      lastCompanyActivityAt: at(-30),
      followUpDue: true,
      notes: "Target note",
    });
    await prisma.application.update({
      where: { id: source.id },
      data: { leadId: lead.id, notes: "Source note", jobUrl: "https://jobs.acme.example/p" },
    });
    await prisma.lead.update({ where: { id: lead.id }, data: { applicationId: source.id } });
    await prisma.gmailMessage.create({
      data: {
        id: "m1",
        threadId: "t1",
        internalDate: at(-2),
        direction: "inbound",
        labelIds: [],
        state: "applied",
        applicationId: source.id,
      },
    });
    await prisma.threadLink.create({ data: { threadId: "t1", applicationId: source.id } });
    const interview = await prisma.interview.create({
      data: { applicationId: source.id, kind: "technical", status: "scheduled", startsAt: at(24) },
    });
    const sourceEvent = await prisma.event.create({
      data: {
        applicationId: source.id,
        type: "status_changed",
        actor: "system",
        occurredAt: at(-3),
        messageId: "m1",
        summary: "Moved to Screening",
        data: { toStatus: "screening" },
        changeSet: [],
        undoable: true,
      },
    });

    const res = await call("POST", `/applications/${source.id}/merge`, { intoId: target.id });
    expect(res.statusCode).toBe(200);
    const detail = detailOf(res.body);
    expect(detail.id).toBe(target.id);
    expect(detail.interviews.map((i) => i.id)).toEqual([interview.id]);
    expect(detail.messages.map((m) => m.id)).toEqual(["m1"]);
    expect(detail.nextInterviewAt).toBe(at(24).toISOString());
    expect(detail.timeline.map((t) => t.type)).toEqual(["merged", "status_changed"]);
    expect(detail.timeline[0]).toMatchObject({
      type: "merged",
      actor: "owner",
      toStatus: "applied",
      undoable: false,
    });
    // The target keeps its own fields, fills gaps and takes the later company activity.
    expect(detail).toMatchObject({
      version: 2,
      status: "applied",
      jobUrl: "https://jobs.acme.example/p",
      lastCompanyActivityAt: at(-2).toISOString(),
      appliedAt: at(-100).toISOString(),
      notes: "Target note\n\nSource note",
    });

    expect(await prisma.application.findUnique({ where: { id: source.id } })).toBeNull();
    expect(
      (await prisma.threadLink.findUniqueOrThrow({ where: { threadId: "t1" } })).applicationId,
    ).toBe(target.id);
    // Moved events can no longer be undone: the records they changed are gone.
    const moved = await prisma.event.findUniqueOrThrow({ where: { id: sourceEvent.id } });
    expect(moved).toMatchObject({ applicationId: target.id, undoable: false });
    // The source's lead goes back to shortlisted (TECHNICAL_SPEC §6.6).
    expect(await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).toMatchObject({
      status: "shortlisted",
      applicationId: null,
      // A stale lead tab must hit a version conflict (the lead changed under it).
      version: 2,
      updatedAt: NOW,
    });
  });

  it("refuses to merge an application into itself, into nothing, or with an unknown source", async () => {
    const { call } = await appWith();
    const a = await seedApplication({ company: "Acme Robotics" });
    const self = await call("POST", `/applications/${a.id}/merge`, { intoId: a.id });
    expect(self.statusCode).toBe(400);
    expect(errorOf(self.body).fields).toEqual({ intoId: "same_application" });
    const missingTarget = await call("POST", `/applications/${a.id}/merge`, {
      intoId: "6f9619ff-8b86-4011-b42d-00c04fc964ff",
    });
    expect(missingTarget.statusCode).toBe(404);
    const missingSource = await call(
      "POST",
      "/applications/6f9619ff-8b86-4011-b42d-00c04fc964ff/merge",
      {
        intoId: a.id,
      },
    );
    expect(missingSource.statusCode).toBe(404);
    expect((await call("POST", `/applications/${a.id}/merge`, {})).statusCode).toBe(400);
    expect(await prisma.application.count()).toBe(1);
  });
});

/** Holds the intake lock until `release()`; resolves once it is held. */
async function holdIntakeLock() {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held!: () => void;
  const isHeld = new Promise<void>((resolve) => {
    held = resolve;
  });
  const done = withIntakeLock(prisma, async () => {
    held();
    await released;
  });
  await isHeld;
  return { release, done };
}
const BLOCKED = Symbol("blocked");
const unlessBlocked = <T>(work: Promise<T>) =>
  Promise.race([work, new Promise<typeof BLOCKED>((r) => setTimeout(() => r(BLOCKED), 4_000))]);

describe("owner edits don't take the intake lock (TECHNICAL_SPEC §6.8)", () => {
  it("PATCH with companyName and follow-up-done go through while another writer holds the lock", async () => {
    const { call } = await appWith();
    const app = await seedApplication({ company: "Acme Robotics", followUpDue: true });
    const holder = await holdIntakeLock();
    try {
      const patched = await unlessBlocked(
        call("PATCH", `/applications/${app.id}`, { version: 1, companyName: "Initech" }),
      );
      expect(patched).not.toBe(BLOCKED);
      expect((patched as { statusCode: number }).statusCode).toBe(200);
      const followed = await unlessBlocked(call("POST", `/applications/${app.id}/follow-up-done`));
      expect(followed).not.toBe(BLOCKED);
      expect((followed as { statusCode: number }).statusCode).toBe(200);
    } finally {
      holder.release();
      await holder.done;
    }
    expect(
      (await prisma.company.findFirstOrThrow({ where: { name: "Initech" } })).createdSource,
    ).toBe("manual");
  });

  it("creating the company retries once when another writer created it first (unique violation)", async () => {
    // A client whose first company.create loses the race: the rival row appears, then P2002.
    let raced = false;
    const racing = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop !== "company") return Reflect.get(target, prop, receiver) as unknown;
        return new Proxy(target.company, {
          get(companies, method, r) {
            if (method !== "create") return Reflect.get(companies, method, r) as unknown;
            return async (args: Prisma.CompanyCreateArgs) => {
              if (!raced) {
                raced = true;
                await companies.create({
                  data: { name: "Initech Inc", normalizedName: "initech", createdSource: "gmail" },
                });
                throw new Prisma.PrismaClientKnownRequestError("unique", {
                  code: "P2002",
                  clientVersion: "test",
                });
              }
              return companies.create(args);
            };
          },
        });
      },
    });

    const company = await resolveCompanyForOwner(racing, "Initech", NOW);
    expect(raced).toBe(true);
    expect(company).toMatchObject({ name: "Initech Inc", normalizedName: "initech" });
    expect(await prisma.company.count()).toBe(1);
  });
});

describe("keyset ties", () => {
  it("pages rows with equal sort keys, and rows with no applied date, by id without skipping or repeating", async () => {
    const { call } = await appWith();
    const tie = at(-5);
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const row = await seedApplication({
        company: `Tie Co ${i}`,
        status: "applied",
        appliedAt: tie,
        lastCompanyActivityAt: tie,
      });
      ids.push(row.id);
    }
    for (let i = 0; i < 3; i += 1) {
      const row = await seedApplication({
        company: `No date ${i}`,
        status: "applied",
        appliedAt: null,
        createdAt: at(-20),
      });
      ids.push(row.id);
    }
    for (const sort of ["last_activity", "applied", "status"]) {
      const walked: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 10; guard += 1) {
        const url: string = `/applications?sort=${sort}&limit=1${cursor ? `&cursor=${cursor}` : ""}`;
        const page = PageOfSummaries.parse((await call("GET", url)).json());
        walked.push(...page.items.map((i) => i.id));
        cursor = page.nextCursor;
        if (cursor === null) break;
      }
      expect(walked, sort).toHaveLength(7);
      expect(new Set(walked).size, sort).toBe(7);
      expect([...walked].sort(), sort).toEqual([...ids].sort());
      // The same order as one big page.
      const whole = PageOfSummaries.parse((await call("GET", `/applications?sort=${sort}`)).json());
      expect(walked, sort).toEqual(whole.items.map((i) => i.id));
    }
  });
});

describe("timeline toStatus for system status events", () => {
  it("fills toStatus for abandoned and reopened events, from data or (abandoned) from the type", async () => {
    const { call } = await appWith();
    const app = await seedApplication({ company: "Acme Robotics", status: "screening" });
    await prisma.event.createMany({
      data: [
        {
          applicationId: app.id,
          type: "abandoned",
          actor: "system",
          occurredAt: at(-30),
          summary: "Abandoned: no reply",
          data: { fromStatus: "screening", toStatus: "abandoned" },
          undoable: true,
        },
        {
          applicationId: app.id,
          type: "reopened",
          actor: "system",
          occurredAt: at(-20),
          summary: "Reopened: Acme replied",
          data: { fromStatus: "abandoned", toStatus: "screening" },
          undoable: true,
        },
        // A writer that left the key out still reads as abandoned.
        {
          applicationId: app.id,
          type: "abandoned",
          actor: "system",
          occurredAt: at(-10),
          summary: "Abandoned: no reply",
          undoable: true,
        },
      ],
    });
    const detail = detailOf((await call("GET", `/applications/${app.id}`)).body);
    expect(detail.timeline.map((t) => [t.type, t.toStatus])).toEqual([
      ["abandoned", "abandoned"],
      ["reopened", "screening"],
      ["abandoned", "abandoned"],
    ]);
  });
});

describe("authentication", () => {
  it("every applications route answers 401 without a session", async () => {
    const { app } = await appWith();
    const id = "6f9619ff-8b86-4011-b42d-00c04fc964ff";
    const routes: [string, string][] = [
      ["GET", "/applications"],
      ["POST", "/applications"],
      ["GET", `/applications/${id}`],
      ["PATCH", `/applications/${id}`],
      ["POST", `/applications/${id}/follow-up-done`],
      ["POST", `/applications/${id}/interviews`],
      ["POST", `/applications/${id}/merge`],
    ];
    for (const [method, url] of routes) {
      const res = await app.inject({
        method: method as "GET" | "POST" | "PATCH",
        url: `/api/v1${url}`,
        headers: CSRF,
        payload: method === "GET" ? undefined : {},
      });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});
