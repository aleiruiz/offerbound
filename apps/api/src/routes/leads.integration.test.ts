import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ApplicationDetailSchema,
  CompanySchema,
  LeadSchema,
  PageSchema,
  type ApiErrorBody,
  type Lead,
} from "@offerbound/contracts";
import { buildTestApp, signIn } from "../../test/app.js";
import { resetDb, testPrisma } from "../../test/db.js";
import type { RecordingQueue } from "../../test/queue.js";
import { QUEUES } from "../jobs/queues.js";

const prisma = testPrisma();
const CSRF = { "x-offerbound-request": "1" };
const NOW = new Date("2026-10-01T12:00:00.000Z");
const LeadPage = PageSchema(LeadSchema);

const apps: FastifyInstance[] = [];
async function appWith() {
  const built = await buildTestApp();
  apps.push(built.app);
  const cookie = await signIn(built.app, built.deps);
  const queue = built.deps.queue as RecordingQueue;
  const call = (method: "GET" | "POST" | "PATCH", url: string, payload?: object) =>
    built.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { cookie, ...(method === "GET" ? {} : CSRF) },
      ...(payload === undefined ? {} : { payload }),
    });
  return { ...built, queue, call };
}

beforeEach(async () => {
  await resetDb(prisma);
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

// --- helpers ------------------------------------------------------------------------------------

let counter = 0;

async function seedCompany(name: string) {
  return prisma.company.create({
    data: { name, normalizedName: name.toLowerCase(), createdSource: "manual" },
  });
}

async function seedBatch() {
  return prisma.intakeBatch.create({ data: { kind: "gmail_message", counts: {} } });
}

type LeadOver = Partial<Prisma.LeadUncheckedCreateInput>;

/** A ready, `new` lead of `company` with a distinct job key. */
async function seedLead(companyName: string, over: LeadOver = {}) {
  counter += 1;
  const company =
    (await prisma.company.findFirst({ where: { name: companyName } })) ??
    (await seedCompany(companyName));
  const batch = (await prisma.intakeBatch.findFirst()) ?? (await seedBatch());
  return prisma.lead.create({
    data: {
      companyId: company.id,
      intakeBatchId: batch.id,
      title: `Backend Engineer ${counter}`,
      jobUrl: `https://careers.example/jobs/${counter}`,
      jobKey: `key-${counter}`,
      status: "new",
      statusChangedAt: NOW,
      pipelineState: "ready",
      source: "gmail_alert",
      foundAt: NOW,
      ...over,
    },
  });
}

const errorOf = (body: string) => (JSON.parse(body) as ApiErrorBody).error;

// --- GET /leads ---------------------------------------------------------------------------------

describe("GET /leads", () => {
  it("New lists only ready leads, ordered by track priority, then fit score descending, then found_at newest", async () => {
    const { call } = await appWith();
    const at = (day: number) => new Date(Date.UTC(2026, 8, day, 9));
    const b90 = await seedLead("Beta", { track: "B", fitScore: 90, foundAt: at(10) });
    const a70Old = await seedLead("Alpha One", { track: "A", fitScore: 70, foundAt: at(1) });
    const a70New = await seedLead("Alpha Two", { track: "A", fitScore: 70, foundAt: at(5) });
    const a95 = await seedLead("Alpha Three", { track: "A", fitScore: 95, foundAt: at(2) });
    const none99 = await seedLead("Gamma", { track: null, fitScore: 99, foundAt: at(11) });
    // A track the owner no longer configures sorts with the leads that have none.
    const gone = await seedLead("Delta", { track: "Z", fitScore: 100, foundAt: at(12) });
    const unranked = await seedLead("Epsilon", { track: "A", fitScore: null, foundAt: at(13) });
    // Not listed: still being checked or ranked, and other statuses.
    await seedLead("Hidden One", { track: "A", fitScore: 100, pipelineState: "checking" });
    await seedLead("Hidden Two", { track: "A", fitScore: 100, pipelineState: "ranking" });
    await seedLead("Hidden Three", { status: "dismissed" });

    const res = await call("GET", "/leads?status=new");
    expect(res.statusCode).toBe(200);
    const page = LeadPage.parse(res.json());
    expect(page.nextCursor).toBeNull();
    expect(page.items.map((l) => l.id)).toEqual([
      a95.id,
      a70New.id,
      a70Old.id,
      unranked.id,
      b90.id,
      gone.id,
      none99.id,
    ]);
  });

  it("pages with a cursor in the same order, for both sorts", async () => {
    const { call } = await appWith();
    for (let i = 0; i < 7; i += 1) {
      await seedLead(`Co ${i}`, {
        track: i % 2 === 0 ? "A" : "B",
        fitScore: 50 + (i % 3),
        foundAt: new Date(Date.UTC(2026, 8, 1 + (i % 4))),
      });
    }
    for (const sort of ["track_fit", "newest"]) {
      const all = LeadPage.parse(
        (await call("GET", `/leads?status=new&sort=${sort}&limit=200`)).json(),
      );
      expect(all.items).toHaveLength(7);
      const walked: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query: string = `/leads?status=new&sort=${sort}&limit=3${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
        const page = LeadPage.parse((await call("GET", query)).json());
        walked.push(...page.items.map((l) => l.id));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor !== null);
      expect(pages).toBe(3);
      expect(walked).toEqual(all.items.map((l) => l.id));
    }
  });

  it("sort=newest orders by found date, newest first, with the id as tiebreak", async () => {
    const { call } = await appWith();
    const same = new Date(Date.UTC(2026, 8, 9));
    const old = await seedLead("Old Co", {
      track: "A",
      fitScore: 99,
      foundAt: new Date(Date.UTC(2026, 8, 1)),
    });
    const x = await seedLead("X Co", { track: "B", fitScore: 10, foundAt: same });
    const y = await seedLead("Y Co", { track: null, fitScore: null, foundAt: same });
    const fresh = await seedLead("Fresh Co", { foundAt: new Date(Date.UTC(2026, 8, 20)) });

    const page = LeadPage.parse((await call("GET", "/leads?status=new&sort=newest")).json());
    const tied = [x.id, y.id].sort().reverse();
    expect(page.items.map((l) => l.id)).toEqual([fresh.id, ...tied, old.id]);
  });

  it("refuses an unknown sort and a cursor from the other sort", async () => {
    const { call } = await appWith();
    for (let i = 0; i < 3; i += 1) await seedLead(`Co ${i}`);
    expect(errorOf((await call("GET", "/leads?sort=oldest")).body).code).toBe("validation_failed");
    expect((await call("GET", "/leads?sort=oldest")).statusCode).toBe(400);
    const first = LeadPage.parse((await call("GET", "/leads?limit=1")).json());
    expect(first.nextCursor).not.toBeNull();
    const cursor = encodeURIComponent(first.nextCursor ?? "");
    const wrong = await call("GET", `/leads?limit=1&sort=newest&cursor=${cursor}`);
    expect(wrong.statusCode).toBe(400);
    expect(errorOf(wrong.body).code).toBe("validation_failed");
    expect((await call("GET", "/leads?cursor=not-a-cursor")).statusCode).toBe(400);
    expect((await call("GET", "/leads?status=open")).statusCode).toBe(400);
  });

  it("filters by track and by q on company or title", async () => {
    const { call } = await appWith();
    const a = await seedLead("Northwind Labs", { track: "A", title: "Platform Engineer" });
    const b = await seedLead("Contoso", { track: "B", title: "Data Engineer" });
    const c = await seedLead("Fabrikam", { track: "A", title: "Northwind Integrations Lead" });
    await seedLead("Wide World", { track: "B", title: "Designer" });

    const ids = async (query: string) =>
      LeadPage.parse((await call("GET", `/leads?${query}`)).json())
        .items.map((l) => l.id)
        .sort();

    expect(await ids("status=new&track=B")).toHaveLength(2);
    expect(await ids("status=new&track=A")).toEqual([a.id, c.id].sort());
    expect(await ids("status=new&q=northwind")).toEqual([a.id, c.id].sort());
    expect(await ids("status=new&q=DATA%20ENGINEER")).toEqual([b.id]);
    expect(await ids("status=new&track=A&q=northwind&limit=1")).toHaveLength(1);
    // % and _ in q are literal characters.
    expect(await ids("status=new&q=%25")).toEqual([]);
  });

  it("the Lead DTO carries compensation.isEstimate and basis", async () => {
    const { call } = await appWith();
    await seedLead("Northwind Labs", {
      track: "A",
      fitScore: 88,
      compMin: "90000.00",
      compMax: "120000",
      compCurrency: "USD",
      compPeriod: "year",
      compIsEstimate: true,
      compBasis: "Median for senior backend roles in the region",
      gaps: ["Kubernetes"],
    });
    const page = LeadPage.parse((await call("GET", "/leads?status=new")).json());
    const lead = page.items[0] as Lead;
    expect(lead.compensation).toEqual({
      min: 90000,
      max: 120000,
      currency: "USD",
      period: "year",
      isEstimate: true,
      basis: "Median for senior backend roles in the region",
    });
    expect(lead.company.name).toBe("Northwind Labs");
    expect(lead.gaps).toEqual(["Kubernetes"]);
    expect(lead.foundAt).toBe(NOW.toISOString());
  });

  it("answers 401 without a session", async () => {
    const { app } = await appWith();
    const res = await app.inject({ method: "GET", url: "/api/v1/leads" });
    expect(res.statusCode).toBe(401);
  });
});

// --- POST /leads --------------------------------------------------------------------------------

describe("POST /leads", () => {
  const body = {
    companyName: "Northwind Labs",
    title: "Staff Platform Engineer",
    jobUrl: "https://careers.example/northwind/platform",
    locationText: "Remote, Mexico",
    country: "MX",
    workMode: "remote",
    compensationText: null,
    notes: "Heard about it from a friend",
  };

  it("creates a manual lead that skips the company-seen rule and starts checking", async () => {
    const { call, queue } = await appWith();
    // Northwind is already known through an earlier lead.
    await seedLead("Northwind Labs", { title: "Older lead" });

    const res = await call("POST", "/leads", body);
    expect(res.statusCode).toBe(201);
    const lead = LeadSchema.parse(res.json());
    expect(lead.status).toBe("new");
    expect(lead.suppressedReason).toBeNull();
    expect(lead.source).toBe("manual");
    expect(lead.company.name).toBe("Northwind Labs");
    expect(lead.notes).toBe("Heard about it from a friend");

    const row = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(row.pipelineState).toBe("checking");
    expect(row.companyId).toBe((await prisma.company.findFirstOrThrow()).id);
    expect(await prisma.company.count()).toBe(1);
    const batch = await prisma.intakeBatch.findUniqueOrThrow({ where: { id: row.intakeBatchId } });
    expect(batch.kind).toBe("manual");

    const checks = queue.sent.filter((s) => s.name === QUEUES.leadsCheck);
    expect(checks).toHaveLength(1);
    expect(checks[0]?.data).toEqual({ leadId: lead.id, batchId: batch.id });

    const events = await prisma.event.findMany({ where: { leadId: lead.id } });
    expect(events.map((e) => [e.type, e.actor, e.undoable])).toEqual([
      ["lead_created", "owner", false],
    ]);
  });

  it("creates the company when it is new", async () => {
    const { call } = await appWith();
    const res = await call("POST", "/leads", { ...body, companyName: "Fabrikam Systems Inc." });
    expect(res.statusCode).toBe(201);
    const company = await prisma.company.findFirstOrThrow();
    expect(company.name).toBe("Fabrikam Systems Inc.");
    expect(company.createdSource).toBe("manual");
  });

  it("refuses a posting that is already a lead, and rolls back", async () => {
    const { call } = await appWith();
    expect((await call("POST", "/leads", body)).statusCode).toBe(201);
    const again = await call("POST", "/leads", body);
    expect(again.statusCode).toBe(400);
    expect(JSON.parse(again.body)).toMatchObject({
      error: { code: "validation_failed", fields: { jobUrl: "already_exists" } },
    });
    expect(await prisma.lead.count()).toBe(1);
    expect(await prisma.intakeBatch.count()).toBe(1);
  });

  it("validates the body", async () => {
    const { call } = await appWith();
    expect((await call("POST", "/leads", { ...body, companyName: " " })).statusCode).toBe(400);
    expect((await call("POST", "/leads", { ...body, jobUrl: "ftp://x.example" })).statusCode).toBe(
      400,
    );
  });

  it("still answers 201 when the check job cannot be queued; the sweep sends it later", async () => {
    const { call, queue } = await appWith();
    queue.failSendWith = new Error("queue down");
    const res = await call("POST", "/leads", body);
    expect(res.statusCode).toBe(201);
    expect(await prisma.lead.count({ where: { pipelineState: "checking" } })).toBe(1);
  });
});

// --- PATCH /leads/:id ---------------------------------------------------------------------------

describe("PATCH /leads/:id", () => {
  it("shortlists, dismisses with a reason and returns to new; a stale version → 409 version_conflict with the current record", async () => {
    const { call } = await appWith();
    const seeded = await seedLead("Northwind Labs", { notes: "keep" });

    const shortlisted = await call("PATCH", `/leads/${seeded.id}`, {
      version: seeded.version,
      status: "shortlisted",
    });
    expect(shortlisted.statusCode).toBe(200);
    const s = LeadSchema.parse(shortlisted.json());
    expect(s.status).toBe("shortlisted");
    expect(s.version).toBe(seeded.version + 1);
    expect(s.dismissedReason).toBeNull();

    const dismissed = LeadSchema.parse(
      (
        await call("PATCH", `/leads/${seeded.id}`, {
          version: s.version,
          status: "dismissed",
          dismissedReason: "salary_too_low",
        })
      ).json(),
    );
    expect(dismissed.status).toBe("dismissed");
    expect(dismissed.dismissedReason).toBe("salary_too_low");

    // Dismissed → new (the web's Reconsider on a dismissed lead).
    const back = LeadSchema.parse(
      (
        await call("PATCH", `/leads/${seeded.id}`, { version: dismissed.version, status: "new" })
      ).json(),
    );
    expect(back.status).toBe("new");
    expect(back.dismissedReason).toBeNull();
    const row = await prisma.lead.findUniqueOrThrow({ where: { id: seeded.id } });
    expect(row.statusChangedAt.getTime()).toBe(NOW.getTime());

    // The first version is stale now.
    const stale = await call("PATCH", `/leads/${seeded.id}`, {
      version: seeded.version,
      status: "dismissed",
    });
    expect(stale.statusCode).toBe(409);
    const body = JSON.parse(stale.body) as { error: { code: string }; current: unknown };
    expect(body.error.code).toBe("version_conflict");
    expect(LeadSchema.parse(body.current)).toEqual(back);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: seeded.id } })).status).toBe("new");
  });

  it("edits notes alone, and clearing them stores null", async () => {
    const { call } = await appWith();
    const seeded = await seedLead("Northwind Labs");
    const noted = LeadSchema.parse(
      (await call("PATCH", `/leads/${seeded.id}`, { version: 1, notes: "Call Monday" })).json(),
    );
    expect(noted.notes).toBe("Call Monday");
    expect(noted.status).toBe("new");
    const cleared = LeadSchema.parse(
      (await call("PATCH", `/leads/${seeded.id}`, { version: noted.version, notes: null })).json(),
    );
    expect(cleared.notes).toBeNull();
  });

  it("changes nothing for an empty patch", async () => {
    const { call } = await appWith();
    const seeded = await seedLead("Northwind Labs");
    const res = await call("PATCH", `/leads/${seeded.id}`, { version: 1 });
    expect(res.statusCode).toBe(200);
    expect(LeadSchema.parse(res.json()).version).toBe(1);
  });

  it("refuses a dismissed reason unless the lead ends up dismissed", async () => {
    const { call } = await appWith();
    const seeded = await seedLead("Northwind Labs");
    const res = await call("PATCH", `/leads/${seeded.id}`, {
      version: 1,
      status: "shortlisted",
      dismissedReason: "nope",
    });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res.body).code).toBe("validation_failed");
  });

  it("a converted lead → 409; a suppressed lead is reconsidered, not patched", async () => {
    const { call } = await appWith();
    const converted = await seedLead("Northwind Labs", { status: "applied" });
    const res = await call("PATCH", `/leads/${converted.id}`, { version: 1, status: "new" });
    expect(res.statusCode).toBe(409);
    expect(errorOf(res.body).code).toBe("version_conflict");

    const suppressed = await seedLead("Contoso", {
      status: "suppressed",
      suppressedReason: "company_already_seen",
    });
    const sup = await call("PATCH", `/leads/${suppressed.id}`, { version: 1, status: "new" });
    expect(sup.statusCode).toBe(400);
    expect(errorOf(sup.body).code).toBe("validation_failed");
  });

  it("answers 404 for an unknown lead, a malformed id, and a lead that is still being checked", async () => {
    const { call } = await appWith();
    const missing = "00000000-0000-4000-8000-000000000000";
    expect((await call("PATCH", `/leads/${missing}`, { version: 1 })).statusCode).toBe(404);
    expect((await call("PATCH", "/leads/nope", { version: 1 })).statusCode).toBe(404);
    const checking = await seedLead("Northwind Labs", { pipelineState: "checking" });
    expect(
      (await call("PATCH", `/leads/${checking.id}`, { version: 1, status: "dismissed" }))
        .statusCode,
    ).toBe(404);
  });

  it("does not accept applied as a status", async () => {
    const { call } = await appWith();
    const seeded = await seedLead("Northwind Labs");
    const res = await call("PATCH", `/leads/${seeded.id}`, { version: 1, status: "applied" });
    expect(res.statusCode).toBe(400);
  });
});

// --- POST /leads/:id/mark-applied ---------------------------------------------------------------

describe("POST /leads/:id/mark-applied", () => {
  it("mark-applied converts the lead and returns the application, whose timeline has an undoable lead_converted event", async () => {
    const { call } = await appWith();
    const message = await prisma.gmailMessage.create({
      data: {
        id: "m-1",
        threadId: "t-1",
        internalDate: NOW,
        direction: "inbound",
        labelIds: [],
        toEmails: [],
      },
    });
    const lead = await seedLead("Northwind Labs", {
      status: "shortlisted",
      track: "A",
      fitScore: 91,
      workMode: "remote",
      country: "MX",
      locationText: "Remote, Mexico",
      compensationText: "USD 100k",
      sponsorshipText: "n/a",
      sourceMessageId: message.id,
    });
    await prisma.threadLink.create({ data: { threadId: "t-1", leadId: lead.id } });

    const res = await call("POST", `/leads/${lead.id}/mark-applied`);
    expect(res.statusCode).toBe(201);
    const application = ApplicationDetailSchema.parse(res.json());
    expect(application).toMatchObject({
      title: lead.title,
      status: "applied",
      appliedAt: NOW.toISOString(),
      statusChangedAt: NOW.toISOString(),
      source: "lead_conversion",
      leadId: lead.id,
      company: { name: "Northwind Labs" },
      jobUrl: lead.jobUrl,
      workMode: "remote",
      country: "MX",
      locationText: "Remote, Mexico",
      followUpDue: false,
      interviews: [],
      messages: [],
    });

    const after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after).toMatchObject({
      status: "applied",
      applicationId: application.id,
      version: lead.version + 1,
    });
    const row = await prisma.application.findUniqueOrThrow({ where: { id: application.id } });
    expect(row.jobKey).toBe(lead.jobKey);
    expect(row.version).toBe(1);
    // The lead's threads belong to the application too.
    expect(await prisma.threadLink.findUniqueOrThrow({ where: { threadId: "t-1" } })).toMatchObject(
      {
        applicationId: application.id,
        leadId: lead.id,
      },
    );

    // The timeline carries one undoable lead_converted event.
    const converted = application.timeline.filter((e) => e.type === "lead_converted");
    expect(converted).toHaveLength(1);
    expect(converted[0]).toMatchObject({
      actor: "owner",
      undoable: true,
      undoneAt: null,
      toStatus: "applied",
      occurredAt: NOW.toISOString(),
    });

    // Its change set is what undo needs: the application it created, the lead as it was before.
    const event = await prisma.event.findUniqueOrThrow({ where: { id: converted[0]?.id ?? "" } });
    expect(event).toMatchObject({
      type: "lead_converted",
      actor: "owner",
      undoable: true,
      applicationId: application.id,
      leadId: lead.id,
      companyId: lead.companyId,
    });
    const entries = event.changeSet as {
      entity: string;
      id: string;
      created: boolean;
      before: Record<string, unknown> | null;
      after: Record<string, unknown>;
      versionAfter: number | null;
    }[];
    const byEntity = (entity: string) => entries.find((e) => e.entity === entity);
    expect(entries).toHaveLength(3);
    expect(byEntity("application")).toMatchObject({
      id: application.id,
      created: true,
      before: null,
      versionAfter: 1,
      after: { status: "applied", source: "lead_conversion", leadId: lead.id },
    });
    expect(byEntity("lead")).toMatchObject({
      id: lead.id,
      created: false,
      versionAfter: lead.version + 1,
      before: {
        status: "shortlisted",
        applicationId: null,
        statusChangedAt: NOW.toISOString(),
        suppressedReason: null,
      },
      after: { status: "applied", applicationId: application.id },
    });
    expect(byEntity("thread_link")).toMatchObject({
      id: "t-1",
      created: false,
      before: { applicationId: null },
      after: { applicationId: application.id },
    });
  });

  it("converts a suppressed lead and records its reason so undo can restore it", async () => {
    const { call } = await appWith();
    const lead = await seedLead("Northwind Labs", {
      status: "suppressed",
      suppressedReason: "company_already_seen",
    });
    const res = await call("POST", `/leads/${lead.id}/mark-applied`);
    expect(res.statusCode).toBe(201);
    const after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.status).toBe("applied");
    expect(after.suppressedReason).toBeNull();
    const event = await prisma.event.findFirstOrThrow({ where: { type: "lead_converted" } });
    const lead_ = (event.changeSet as { entity: string; before: Record<string, unknown> }[]).find(
      (e) => e.entity === "lead",
    );
    expect(lead_?.before).toMatchObject({
      status: "suppressed",
      suppressedReason: "company_already_seen",
    });
  });

  it("a lead that is already applied → 409 version_conflict with the current lead; nothing is created twice", async () => {
    const { call } = await appWith();
    const lead = await seedLead("Northwind Labs");
    expect((await call("POST", `/leads/${lead.id}/mark-applied`)).statusCode).toBe(201);
    const again = await call("POST", `/leads/${lead.id}/mark-applied`);
    expect(again.statusCode).toBe(409);
    const body = JSON.parse(again.body) as { error: { code: string }; current: unknown };
    expect(body.error.code).toBe("version_conflict");
    expect(LeadSchema.parse(body.current)).toMatchObject({ id: lead.id, status: "applied" });
    expect(await prisma.application.count()).toBe(1);
    expect(await prisma.event.count({ where: { type: "lead_converted" } })).toBe(1);
  });

  it("two requests at once create one application", async () => {
    const { call } = await appWith();
    const lead = await seedLead("Northwind Labs");
    const results = await Promise.all([
      call("POST", `/leads/${lead.id}/mark-applied`),
      call("POST", `/leads/${lead.id}/mark-applied`),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(await prisma.application.count()).toBe(1);
  });

  it("keeps the application when another one already holds the posting's job key", async () => {
    const { call } = await appWith();
    const lead = await seedLead("Northwind Labs", { jobKey: "dup-key" });
    const company = await prisma.company.findFirstOrThrow();
    await prisma.application.create({
      data: {
        companyId: company.id,
        title: "Same posting, applied by email",
        jobKey: "dup-key",
        status: "applied",
        statusChangedAt: NOW,
        source: "gmail",
      },
    });
    const res = await call("POST", `/leads/${lead.id}/mark-applied`);
    expect(res.statusCode).toBe(201);
    expect(await prisma.application.count()).toBe(2);
  });

  it("answers 404 for an unknown lead and for one still being checked", async () => {
    const { call } = await appWith();
    expect(
      (await call("POST", "/leads/00000000-0000-4000-8000-000000000000/mark-applied")).statusCode,
    ).toBe(404);
    const checking = await seedLead("Northwind Labs", { pipelineState: "checking" });
    expect((await call("POST", `/leads/${checking.id}/mark-applied`)).statusCode).toBe(404);
  });
});

// --- POST /leads/:id/reconsider -----------------------------------------------------------------

describe("POST /leads/:id/reconsider", () => {
  it("reconsider moves a suppressed lead to new and sends it to checking if it was never checked", async () => {
    const { call, queue } = await appWith();
    const never = await seedLead("Northwind Labs", {
      status: "suppressed",
      suppressedReason: "company_already_seen",
      verification: "pending",
    });
    const res = await call("POST", `/leads/${never.id}/reconsider`);
    expect(res.statusCode).toBe(200);
    const lead = LeadSchema.parse(res.json());
    expect(lead).toMatchObject({
      status: "new",
      suppressedReason: null,
      version: never.version + 1,
    });
    const row = await prisma.lead.findUniqueOrThrow({ where: { id: never.id } });
    expect(row.pipelineState).toBe("checking");
    expect(row.statusChangedAt.getTime()).toBe(NOW.getTime());
    const checks = queue.sent.filter((s) => s.name === QUEUES.leadsCheck);
    expect(checks.map((c) => c.data)).toEqual([{ leadId: never.id, batchId: never.intakeBatchId }]);
  });

  it("a suppressed lead that was checked goes straight back to new, ready, with no job", async () => {
    const { call, queue } = await appWith();
    const checked = await seedLead("Contoso", {
      status: "suppressed",
      suppressedReason: "ineligible",
      verification: "verified",
      verifiedAt: NOW,
      rankedAt: NOW,
      fitScore: 40,
    });
    const res = await call("POST", `/leads/${checked.id}/reconsider`);
    expect(res.statusCode).toBe(200);
    const row = await prisma.lead.findUniqueOrThrow({ where: { id: checked.id } });
    expect(row).toMatchObject({ status: "new", pipelineState: "ready", suppressedReason: null });
    expect(queue.sent).toEqual([]);
    const list = LeadPage.parse((await call("GET", "/leads?status=new")).json());
    expect(list.items.map((l) => l.id)).toEqual([checked.id]);
  });

  it("a lead that is not suppressed → 409 version_conflict with the current lead", async () => {
    const { call } = await appWith();
    const lead = await seedLead("Northwind Labs", { status: "shortlisted" });
    const res = await call("POST", `/leads/${lead.id}/reconsider`);
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body) as { error: { code: string }; current: unknown };
    expect(body.error.code).toBe("version_conflict");
    expect(LeadSchema.parse(body.current).status).toBe("shortlisted");
  });

  it("answers 404 for an unknown lead", async () => {
    const { call } = await appWith();
    expect(
      (await call("POST", "/leads/00000000-0000-4000-8000-000000000000/reconsider")).statusCode,
    ).toBe(404);
  });
});

// --- POST /leads/rerank -------------------------------------------------------------------------

describe("POST /leads/rerank", () => {
  it("rerank {scope:'new'} puts new leads back in ranking and returns 202", async () => {
    const { call, queue } = await appWith();
    const a = await seedLead("Alpha", { track: "A", fitScore: 80, rankedAt: NOW });
    const b = await seedLead("Beta", { track: "B", fitScore: 60, rankedAt: NOW });
    const shortlisted = await seedLead("Gamma", { status: "shortlisted" });
    const checking = await seedLead("Delta", { pipelineState: "checking" });
    const dismissed = await seedLead("Epsilon", { status: "dismissed" });

    const res = await call("POST", "/leads/rerank", { scope: "new" });
    expect(res.statusCode).toBe(202);

    const states = async (ids: string[]) =>
      (await prisma.lead.findMany({ where: { id: { in: ids } }, orderBy: { id: "asc" } }))
        .map((l) => [l.id, l.pipelineState, l.version] as const)
        .sort();
    expect(await states([a.id, b.id])).toEqual(
      [
        [a.id, "ranking", a.version + 1],
        [b.id, "ranking", b.version + 1],
      ].sort(),
    );
    // Other statuses, and a lead still being checked, are left alone.
    expect(await states([shortlisted.id, checking.id, dismissed.id])).toEqual(
      [
        [shortlisted.id, "ready", 1],
        [checking.id, "checking", 1],
        [dismissed.id, "ready", 1],
      ].sort(),
    );
    // Ranked leads stay out of the list while they wait.
    const list = LeadPage.parse((await call("GET", "/leads?status=new")).json());
    expect(list.items).toEqual([]);

    // One job, whatever the number of leads.
    expect(queue.sent.filter((s) => s.name === QUEUES.leadsRank)).toHaveLength(1);
  });

  it("sends no job when there is nothing to rank", async () => {
    const { call, queue } = await appWith();
    const res = await call("POST", "/leads/rerank", { scope: "new" });
    expect(res.statusCode).toBe(202);
    expect(queue.sent).toEqual([]);
  });

  it("puts the leads back when the job cannot be queued, and says so", async () => {
    const { call, queue } = await appWith();
    const lead = await seedLead("Alpha", { track: "A", fitScore: 80 });
    queue.failSendWith = new Error("queue down");
    const res = await call("POST", "/leads/rerank", { scope: "new" });
    expect(res.statusCode).toBe(500);
    const row = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(row.pipelineState).toBe("ready");
  });

  it("refuses another scope", async () => {
    const { call } = await appWith();
    expect((await call("POST", "/leads/rerank", { scope: "all" })).statusCode).toBe(400);
    expect((await call("POST", "/leads/rerank", {})).statusCode).toBe(400);
  });

  it("is not mistaken for a lead id", async () => {
    const { call } = await appWith();
    // POST /leads/rerank must reach the rerank route, never `/leads/:id/...` or a 404.
    expect((await call("POST", "/leads/rerank", { scope: "new" })).statusCode).toBe(202);
  });
});

// --- PATCH /companies/:id -----------------------------------------------------------------------

describe("PATCH /companies/:id", () => {
  it("PATCH /companies/:id updates name, aliases and groupId with version", async () => {
    const { call } = await appWith();
    const root = await seedCompany("Northwind Holdings");
    const company = await seedCompany("Northwind Labs");

    const res = await call("PATCH", `/companies/${company.id}`, {
      version: company.version,
      name: "Northwind Labs Ltd.",
      aliases: ["NW Labs", "  nw   labs ", "Northwind Research", "", "Northwind Labs"],
      groupId: root.id,
    });
    expect(res.statusCode).toBe(200);
    const dto = CompanySchema.parse(res.json());
    expect(dto).toMatchObject({
      id: company.id,
      version: company.version + 1,
      name: "Northwind Labs Ltd.",
      groupId: root.id,
    });
    // Aliases are stored normalised, once each, and never repeat the company's own name.
    expect(dto.aliases).toEqual(["nw labs", "northwind research"]);

    const row = await prisma.company.findUniqueOrThrow({ where: { id: company.id } });
    expect(row.normalizedName).toBe("northwind labs");
    expect(row.name).toBe("Northwind Labs Ltd.");

    // Leaving the group.
    const left = CompanySchema.parse(
      (
        await call("PATCH", `/companies/${company.id}`, { version: dto.version, groupId: null })
      ).json(),
    );
    expect(left.groupId).toBeNull();
    expect(left.name).toBe("Northwind Labs Ltd.");
  });

  it("a stale version → 409 version_conflict with the current company", async () => {
    const { call } = await appWith();
    const company = await seedCompany("Northwind Labs");
    expect(
      (await call("PATCH", `/companies/${company.id}`, { version: 1, name: "Northwind" }))
        .statusCode,
    ).toBe(200);
    const stale = await call("PATCH", `/companies/${company.id}`, { version: 1, name: "Other" });
    expect(stale.statusCode).toBe(409);
    const body = JSON.parse(stale.body) as { error: { code: string }; current: unknown };
    expect(body.error.code).toBe("version_conflict");
    expect(CompanySchema.parse(body.current)).toMatchObject({ name: "Northwind", version: 2 });
  });

  it("groups under the root of the group named, and moves the company's own members along", async () => {
    const { call } = await appWith();
    const root = await seedCompany("Globex");
    const member = await seedCompany("Globex Labs");
    await prisma.company.update({ where: { id: member.id }, data: { groupId: root.id } });
    const lonely = await seedCompany("Initech");
    const child = await seedCompany("Initech Cloud");
    await prisma.company.update({ where: { id: child.id }, data: { groupId: lonely.id } });

    // Naming a member picks its root.
    const joined = CompanySchema.parse(
      (await call("PATCH", `/companies/${lonely.id}`, { version: 1, groupId: member.id })).json(),
    );
    expect(joined.groupId).toBe(root.id);
    // Initech was a root with a member; that member follows to the new root.
    expect((await prisma.company.findUniqueOrThrow({ where: { id: child.id } })).groupId).toBe(
      root.id,
    );
  });

  it("refuses itself as the group, an unknown group, a taken name and an empty body", async () => {
    const { call } = await appWith();
    const a = await seedCompany("Alpha");
    const b = await seedCompany("Beta");
    const patch = (payload: object) => call("PATCH", `/companies/${a.id}`, payload);

    const self = await patch({ version: 1, groupId: a.id });
    expect(self.statusCode).toBe(400);
    const unknown = await patch({ version: 1, groupId: "00000000-0000-4000-8000-000000000000" });
    expect(unknown.statusCode).toBe(400);
    const taken = await patch({ version: 1, name: "BETA" });
    expect(taken.statusCode).toBe(400);
    expect(JSON.parse(taken.body)).toMatchObject({
      error: { code: "validation_failed", fields: { name: "already_exists" } },
    });
    expect((await patch({ name: "Gamma" })).statusCode).toBe(400);
    expect((await patch({ version: 1, name: " " })).statusCode).toBe(400);
    expect((await prisma.company.findUniqueOrThrow({ where: { id: b.id } })).name).toBe("Beta");
    expect((await prisma.company.findUniqueOrThrow({ where: { id: a.id } })).version).toBe(1);
  });

  it("answers 404 for an unknown company", async () => {
    const { call } = await appWith();
    expect(
      (await call("PATCH", "/companies/00000000-0000-4000-8000-000000000000", { version: 1 }))
        .statusCode,
    ).toBe(404);
    expect((await call("PATCH", "/companies/nope", { version: 1 })).statusCode).toBe(404);
  });
});
