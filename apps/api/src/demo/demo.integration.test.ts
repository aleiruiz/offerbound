import type { FastifyInstance } from "fastify";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ApplicationDetailSchema,
  PageSchema,
  TodaySchema,
  LeadSchema,
  ApplicationSummarySchema,
  MeSchema,
  type ApplicationDetail,
} from "@offerbound/contracts";
import { EnvError, loadEnv } from "../config/env.js";
import { HANDLERS } from "../jobs/handlers.js";
import { QUEUES } from "../jobs/queues.js";
import { searchRunHandler } from "../leads/search.js";
import { buildTestApp, signIn } from "../../test/app.js";
import { buildDemoApp, buildDemoDeps, demoWorkerCtx } from "../../test/demo.js";
import { resetDb, testPrisma } from "../../test/db.js";
import { DEMO_RULES, demoRuleKey } from "./guard.js";
import { resetDemo } from "./reset.js";
import { loadSeed } from "./seed.js";
import { simulateEmail } from "./simulate.js";

const prisma = testPrisma();
const CSRF = { "x-offerbound-request": "1" };
const NOW = new Date("2026-11-02T10:00:00.000Z");
const HOUR = 3_600_000;

const apps: FastifyInstance[] = [];
async function demo() {
  const built = await buildDemoApp();
  apps.push(built.app);
  await resetDemo(built.deps, built.deps.clock());
  const call = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: object) =>
    built.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: method === "GET" ? {} : CSRF,
      ...(payload === undefined ? {} : { payload }),
    });
  const get = async <T>(url: string): Promise<T> => (await call("GET", url)).json<T>();
  const applicationByCompany = async (company: string): Promise<ApplicationDetail> => {
    const page = await get<{ items: { id: string; company: { name: string } }[] }>(
      "/applications?limit=200",
    );
    const found = page.items.find((a) => a.company.name === company);
    if (!found) throw new Error(`no application at ${company}`);
    return ApplicationDetailSchema.parse(await get(`/applications/${found.id}`));
  };
  return { ...built, call, get, applicationByCompany };
}

beforeEach(async () => {
  await resetDb(prisma);
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("demo mode", () => {
  it("demo boot with OPENAI_API_KEY set → EnvError forbidden", () => {
    // AC-16.1
    const base = {
      APP_MODE: "demo",
      PUBLIC_BASE_URL: "https://demo.offerbound.example",
      DATABASE_URL: "postgresql://offerbound:local-dev-only@localhost:5432/offerbound_demo",
    };
    let error: unknown;
    try {
      loadEnv({ ...base, OPENAI_API_KEY: "sk-test" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EnvError);
    expect((error as EnvError).forbidden).toEqual(["OPENAI_API_KEY"]);
    // An empty value carries no secret: it counts as unset.
    expect(loadEnv({ ...base, OPENAI_API_KEY: "" }).mode).toBe("demo");
  });

  it("GET /me in demo → { mode: 'demo', email: null } without a session", async () => {
    // AC-16.2
    const { call } = await demo();
    const response = await call("GET", "/me");
    expect(response.statusCode).toBe(200);
    const me = MeSchema.parse(response.json());
    expect(me).toMatchObject({ mode: "demo", email: null, onboardingCompleted: true });
    // Every page works without signing in.
    for (const url of [
      "/today",
      "/applications",
      "/leads",
      "/interviews?range=upcoming",
      "/review-items",
      "/settings",
      "/search/runs",
      "/cv",
      "/nav-counts",
    ]) {
      expect((await call("GET", url)).statusCode, url).toBe(200);
    }
  });

  it("serves the seeded pages with fictional data", async () => {
    const { get } = await demo();
    const today = TodaySchema.parse(await get("/today"));
    expect(today.followUpsDue.length).toBeGreaterThan(0);
    expect(today.upcomingInterviews.length).toBeGreaterThan(0);
    expect(today.topLeads.length).toBeGreaterThan(0);

    const applications = PageSchema(ApplicationSummarySchema).parse(
      await get("/applications?limit=200"),
    );
    expect(applications.items.length).toBe(loadSeed().applications.length);
    const leads = PageSchema(LeadSchema).parse(await get("/leads?limit=200"));
    expect(leads.items.map((l) => l.status).sort()).toEqual(
      expect.arrayContaining(["new", "shortlisted", "dismissed"]),
    );
    // Interviews keep the time of day the seed gives them in the owner's zone (10:00, 09:00).
    const local = (iso: string | null) =>
      DateTime.fromISO(iso ?? "", { zone: "America/Monterrey" }).toFormat("HH:mm");
    const hours = today.upcomingInterviews
      .map((i) => local(i.startsAt))
      .filter((h) => h !== "Invalid DateTime");
    expect(hours.sort()).toEqual(["09:00", "10:00"]);
    // The interviews that lie ahead are ahead of the clock the test set.
    const dated = today.upcomingInterviews.filter((i) => i.startsAt !== null);
    expect(dated.length).toBeGreaterThan(0);
    for (const interview of dated) {
      expect(Date.parse(interview.startsAt as string)).toBeGreaterThan(NOW.getTime());
    }
  });
});

describe("resetDemo", () => {
  it("reset shifts the seed so the newest event happened within the last hour", async () => {
    const deps = buildDemoDeps();
    await resetDemo(deps, NOW);
    const newest = await prisma.event.aggregate({ _max: { occurredAt: true } });
    const age = NOW.getTime() - (newest._max.occurredAt?.getTime() ?? 0);
    expect(age).toBeGreaterThan(0);
    expect(age).toBeLessThanOrEqual(HOUR);

    // A reset a day later moves everything a day on.
    const later = new Date(NOW.getTime() + 24 * HOUR);
    await resetDemo(deps, later);
    const newestLater = await prisma.event.aggregate({ _max: { occurredAt: true } });
    expect(
      (newestLater._max.occurredAt?.getTime() ?? 0) - (newest._max.occurredAt?.getTime() ?? 0),
    ).toBe(24 * HOUR);
  });

  it("empties every application table before it seeds, and starts the mailbox over", async () => {
    const { app, deps, call } = await demo();
    await prisma.company.create({
      data: { name: "Visitor Co", normalizedName: "visitor co", createdSource: "manual" },
    });
    await call("POST", "/demo/simulate-email");
    expect(await prisma.gmailMessage.count()).toBeGreaterThan(6);

    await resetDemo(deps, deps.clock());
    expect(await prisma.company.count({ where: { name: "Visitor Co" } })).toBe(0);
    expect(await prisma.gmailMessage.count()).toBe(loadSeed().messages.length);
    // The first email is next again.
    const again = await app.inject({
      method: "POST",
      url: "/api/v1/demo/simulate-email",
      headers: CSRF,
    });
    expect(again.json<{ messageId: string }>().messageId).toBe(loadSeed().mailbox.order[0]);
  });

  it("refuses to run on a private instance", async () => {
    const { deps } = await buildTestApp();
    await expect(resetDemo(deps, NOW)).rejects.toThrow(/demo mode/);
  });

  it("the demo.reset job resets the demo", async () => {
    const ctx = demoWorkerCtx();
    const handler = HANDLERS[QUEUES.demoReset];
    expect(handler).toBeDefined();
    await handler?.(ctx, { data: {}, retryCount: 0, retryLimit: 1 });
    expect(await prisma.application.count()).toBe(loadSeed().applications.length);
  });
});

describe("Simulate an incoming email", () => {
  it("simulate-email changes an application's status and adds a timeline entry", async () => {
    // AC-16.4
    const { call, applicationByCompany } = await demo();
    // The second email in the walk is the offer from Arbor Analytics.
    const before = await applicationByCompany("Arbor Analytics");
    expect(before.status).toBe("interviewing");

    const first = await call("POST", "/demo/simulate-email");
    expect(first.statusCode).toBe(202);
    const second = await call("POST", "/demo/simulate-email");
    expect(second.statusCode).toBe(202);
    expect(second.json<{ messageId: string }>().messageId).toBe("offer-arbor-analytics");

    const after = await applicationByCompany("Arbor Analytics");
    expect(after.status).toBe("offer");
    expect(after.timeline.length).toBe(before.timeline.length + 1);
    const entry = after.timeline[0];
    expect(entry).toMatchObject({
      type: "status_changed",
      toStatus: "offer",
      messageId: "offer-arbor-analytics",
      undoable: true,
    });
    expect(Date.parse(entry?.occurredAt ?? "")).toBe(NOW.getTime());
    // The email itself is readable.
    const message = await call("GET", "/messages/offer-arbor-analytics");
    expect(message.json<{ subject: string }>().subject).toContain("Offer");
  });

  it("the first email moves the interview, and the new time lies ahead", async () => {
    const { call, applicationByCompany } = await demo();
    const before = await applicationByCompany("Quarry AI");
    const response = await call("POST", "/demo/simulate-email");
    expect(response.json<{ messageId: string }>().messageId).toBe("reschedule-ics-quarry-ai");
    const after = await applicationByCompany("Quarry AI");
    expect(after.interviews).toHaveLength(1);
    expect(after.interviews[0]?.startsAt).not.toBe(before.interviews[0]?.startsAt);
    expect(Date.parse(after.interviews[0]?.startsAt ?? "")).toBeGreaterThan(NOW.getTime());
    expect(after.timeline[0]?.summary).toMatch(/^Interview rescheduled to /);
  });

  it("walks through every email and starts over with the same emails, without failures", async () => {
    const { call, get } = await demo();
    const order = loadSeed().mailbox.order;
    const ids: string[] = [];
    for (let i = 0; i < order.length + 3; i += 1) {
      const response = await call("POST", "/demo/simulate-email");
      expect(response.statusCode).toBe(202);
      ids.push(response.json<{ messageId: string }>().messageId);
    }
    expect(ids.slice(0, order.length)).toEqual(order);
    expect(ids.slice(order.length)).toEqual(order.slice(0, 3).map((id) => `${id}~2`));

    const states = await prisma.gmailMessage.groupBy({ by: ["state"], _count: { _all: true } });
    const byState = Object.fromEntries(states.map((s) => [s.state, s._count._all]));
    expect(byState.failed ?? 0).toBe(0);
    expect(byState.discovered ?? 0).toBe(0);
    expect(byState.job_related ?? 0).toBe(0);
    expect(byState.extracted ?? 0).toBe(0);
    // The ambiguous Driftwood email waits for a decision.
    const review = await get<{ items: { kind: string }[] }>("/review-items");
    expect(review.items.map((i) => i.kind)).toContain("ambiguous_match");
    // The recruiter and the job alert brought leads; the screen at Ironbark Labs an application.
    expect(
      await prisma.lead.count({ where: { source: { in: ["gmail_recruiter", "gmail_alert"] } } }),
    ).toBeGreaterThan(0);
    expect(await prisma.company.count({ where: { name: "Ironbark Labs" } })).toBe(1);
  });

  it("reprocessing a simulated message in the worker gives the same dates the simulation did", async () => {
    // The API process simulates; the worker is another process with its own mailbox and model.
    const { call, deps, applicationByCompany } = await demo();
    const simulated = await call("POST", "/demo/simulate-email");
    const id = simulated.json<{ messageId: string }>().messageId;
    expect(id).toBe("reschedule-ics-quarry-ai");
    const before = await prisma.gmailMessage.findUniqueOrThrow({ where: { id } });
    const interview = (await applicationByCompany("Quarry AI")).interviews[0];

    const reprocess = await call("POST", `/messages/${id}/reprocess`);
    expect(reprocess.statusCode).toBe(202);
    expect(deps.queue.sent.some((job) => job.name === QUEUES.emailExtract)).toBe(true);

    const worker = demoWorkerCtx(buildDemoDeps(deps.clock()));
    await HANDLERS[QUEUES.emailExtract]?.(worker, {
      data: { messageId: id },
      retryCount: 0,
      retryLimit: 4,
    });
    const after = await prisma.gmailMessage.findUniqueOrThrow({ where: { id } });
    expect(after.state).toBe("extracted");
    expect(after.extraction).toEqual(before.extraction);
    expect(after.bodyText).toBe(before.bodyText);
    expect(JSON.stringify(after.icsEvents)).toBe(JSON.stringify(before.icsEvents));

    // Applying it again leaves the interview where the simulation put it.
    await HANDLERS[QUEUES.emailApply]?.(worker, { data: {}, retryCount: 0, retryLimit: 3 });
    expect((await applicationByCompany("Quarry AI")).interviews[0]?.startsAt).toBe(
      interview?.startsAt,
    );
  });

  it("does nothing on a private instance: the route does not exist", async () => {
    const { app, deps } = await buildTestApp();
    const cookie = await signIn(app, deps);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/demo/simulate-email",
      headers: { cookie, ...CSRF },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("refuses to simulate on a private instance", async () => {
    const { deps } = await buildTestApp();
    await expect(simulateEmail({ ...deps, log: demoWorkerCtx().log })).rejects.toThrow(/demo mode/);
  });
});

describe("Run search now", () => {
  it("Run search now returns synthetic leads through the real intake", async () => {
    // AC-16.5
    const { call, get, deps } = await demo();
    const before = PageSchema(LeadSchema).parse(await get("/leads?status=new&limit=200")).items;

    const started = await call("POST", "/search/run");
    expect(started.statusCode).toBe(202);
    const { id } = started.json<{ id: string }>();
    // The worker's half: the search job, with the same fixture model and local link check.
    const ctx = demoWorkerCtx(deps);
    await searchRunHandler(ctx, { data: { runId: id } });

    const runs = await get<{ id: string; status: string; accepted: number }[]>("/search/runs");
    const run = runs.find((r) => r.id === id);
    expect(run?.status).toBe("succeeded");
    expect(run?.accepted).toBeGreaterThan(0);

    const after = PageSchema(LeadSchema).parse(await get("/leads?status=new&limit=200")).items;
    const fresh = after.filter((l) => !before.some((b) => b.id === l.id));
    expect(fresh.length).toBeGreaterThan(0);
    // First batch of fixtures/leads, stored as ranked, verified leads from the search agent.
    expect(fresh.map((l) => l.company.name)).toContain("Aldermoor Systems");
    expect(fresh.every((l) => l.source === "search_agent" && l.verification === "verified")).toBe(
      true,
    );
    expect(fresh.every((l) => l.fitScore !== null)).toBe(true);
    // The real intake ran: the job keys are stored.
    expect(
      await prisma.lead.count({ where: { jobKey: { not: null }, source: "search_agent" } }),
    ).toBeGreaterThan(before.length);

    // The next press hands out the next batch.
    const second = await call("POST", "/search/run");
    await searchRunHandler(ctx, { data: { runId: second.json<{ id: string }>().id } });
    const names = (await prisma.lead.findMany({ include: { company: true } })).map(
      (l) => l.company.name,
    );
    expect(names).toContain("Kingfisher Travel");
  });
});

describe("the read-only guard", () => {
  const blocked: [string, string, object][] = [
    ["POST", "/cv", {}],
    ["POST", "/cv/retry-profile", {}],
    [
      "POST",
      "/leads",
      {
        companyName: "Visitor Co",
        title: "Engineer",
        jobUrl: null,
        locationText: null,
        country: null,
        workMode: "remote",
        compensationText: null,
        notes: "hello",
      },
    ],
    [
      "POST",
      "/applications",
      {
        companyName: "Visitor Co",
        title: "Engineer",
        jobUrl: null,
        status: "applied",
        appliedAt: null,
        notes: null,
      },
    ],
    [
      "POST",
      "/applications/00000000-0000-4000-8000-000000000000/interviews",
      {
        kind: "other",
        status: "scheduled",
        startsAt: null,
        endsAt: null,
        meetingUrl: null,
        location: null,
        interviewers: [],
        notes: "hello",
      },
    ],
    ["PUT", "/settings", {}],
    ["POST", "/data/purge-email-content", { confirm: "DELETE" }],
    ["POST", "/import/sheet/preview", {}],
    ["POST", "/import/sheet/commit", { previewId: "x" }],
    ["POST", "/leads/import/preview", { text: "hello" }],
    ["POST", "/leads/import/commit", { previewId: "x", keepRowIds: [] }],
    ["POST", "/gmail/start", {}],
    ["POST", "/gmail/sync", {}],
    ["POST", "/gmail/disconnect", {}],
  ];

  it.each(blocked)("%s %s → 403 demo_read_only", async (method, url, payload) => {
    const { call } = await demo();
    const response = await call(method as "POST" | "PUT", url, payload);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "demo_read_only" } });
  });

  it("the free-text routes → 403 demo_read_only", async () => {
    // AC-16.6, first half. Free text in a PATCH, however small.
    const { call: callBlocked, applicationByCompany: appBlocked, get: getBlocked } = await demo();
    const app = await appBlocked("Northwind Robotics");
    for (const patch of [
      { notes: "hello" },
      { title: "CEO" },
      { companyName: "Evil Inc" },
      { jobUrl: "https://evil.example" },
      { locationText: "here" },
      { status: "offer", notes: "mixed" },
    ]) {
      const response = await callBlocked("PATCH", `/applications/${app.id}`, {
        version: app.version,
        ...patch,
      });
      expect(response.statusCode, JSON.stringify(patch)).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: "demo_read_only" } });
    }
    const interview = (await appBlocked("Arbor Analytics")).interviews[0];
    for (const patch of [
      { notes: "x" },
      { location: "x" },
      { interviewers: ["x"] },
      { meetingUrl: "https://x.example" },
    ]) {
      const response = await callBlocked("PATCH", `/interviews/${interview?.id}`, {
        version: interview?.version,
        ...patch,
      });
      expect(response.statusCode, JSON.stringify(patch)).toBe(403);
    }
    const leads = (
      await getBlocked<{ items: { id: string; version: number; status: string }[] }>(
        "/leads?status=new",
      )
    ).items;
    const lead = leads[0];
    expect(
      (await callBlocked("PATCH", `/leads/${lead?.id}`, { version: lead?.version, notes: "hi" }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await callBlocked("PATCH", `/leads/${lead?.id}`, {
          version: lead?.version,
          status: "dismissed",
          dismissedReason: "spam link",
        })
      ).statusCode,
    ).toBe(403);
    const company = await prisma.company.findFirstOrThrow({ where: { name: "Quarry AI" } });
    expect(
      (
        await callBlocked("PATCH", `/companies/${company.id}`, {
          version: company.version,
          name: "Evil Inc",
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await callBlocked("PATCH", `/companies/${company.id}`, {
          version: company.version,
          aliases: ["x"],
        })
      ).statusCode,
    ).toBe(403);
  });

  it("status changes, shortlist, dismiss, undo and review actions work", async () => {
    // AC-16.6, second half.
    const { call, get, applicationByCompany } = await demo();
    const app = await applicationByCompany("Northwind Robotics");
    const interview = (await applicationByCompany("Arbor Analytics")).interviews[0];
    const leads = (
      await get<{ items: { id: string; version: number; status: string }[] }>("/leads?status=new")
    ).items;
    const lead = leads[0];

    // Status change.
    const moved = await call("PATCH", `/applications/${app.id}`, {
      version: app.version,
      status: "screening",
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ status: "screening" });
    // Interview: mark completed.
    expect(
      (
        await call("PATCH", `/interviews/${interview?.id}`, {
          version: interview?.version,
          status: "completed",
        })
      ).statusCode,
    ).toBe(200);
    // Shortlist, dismiss without a reason, and back to new.
    expect(lead).toBeDefined();
    const shortlisted = await call("PATCH", `/leads/${lead?.id}`, {
      version: lead?.version,
      status: "shortlisted",
    });
    expect(shortlisted.statusCode).toBe(200);
    const next = leads[1];
    const dismissed = await call("PATCH", `/leads/${next?.id}`, {
      version: next?.version,
      status: "dismissed",
    });
    expect(dismissed.statusCode).toBe(200);
    const back = await call("PATCH", `/leads/${next?.id}`, {
      version: dismissed.json<{ version: number }>().version,
      status: "new",
    });
    expect(back.statusCode).toBe(200);
    // Mark applied, follow-up done, daily counter, rerank.
    const third = leads[2];
    expect((await call("POST", `/leads/${third?.id}/mark-applied`)).statusCode).toBe(201);
    expect((await call("POST", `/applications/${app.id}/follow-up-done`)).statusCode).toBe(200);
    expect(
      (await call("POST", "/daily-activity", { kind: "outreach", amount: 1 })).statusCode,
    ).toBe(200);
    expect((await call("POST", "/leads/rerank", { scope: "new" })).statusCode).toBe(202);

    // Undo: the simulated email's event can be undone.
    await call("POST", "/demo/simulate-email");
    await call("POST", "/demo/simulate-email");
    const arbor = await applicationByCompany("Arbor Analytics");
    const offer = arbor.timeline.find((e) => e.type === "status_changed" && e.toStatus === "offer");
    expect(offer?.undoable).toBe(true);
    const undone = await call("POST", `/events/${offer?.id}/undo`);
    expect(undone.statusCode).toBe(200);
    expect((await applicationByCompany("Arbor Analytics")).status).toBe("interviewing");

    // Review actions: the ambiguous email, then a decision.
    for (let i = 0; i < 3; i += 1) await call("POST", "/demo/simulate-email");
    const review = await get<{ items: { id: string; kind: string }[] }>("/review-items");
    const item = review.items.find((i) => i.kind === "ambiguous_match");
    expect(item).toBeDefined();
    // Free text stays closed.
    for (const body of [
      { action: "edit_apply", edits: { summary: "hello" } },
      { action: "apply", edits: { summary: "hello" } },
    ]) {
      expect(
        (await call("POST", `/review-items/${item?.id}/resolve`, body)).statusCode,
        JSON.stringify(body),
      ).toBe(403);
    }
    const resolved = await call("POST", `/review-items/${item?.id}/resolve`, { action: "dismiss" });
    expect(resolved.statusCode).toBe(200);
  });

  it("every mutating route of a demo instance has a rule", async () => {
    const routes: { method: string; url: string }[] = [];
    const built = await buildTestApp(buildDemoDeps(), {
      onRoute: (route) => routes.push(route),
    });
    apps.push(built.app);
    const mutating = routes.filter((r) => ["POST", "PUT", "PATCH", "DELETE"].includes(r.method));
    expect(mutating.length).toBeGreaterThan(20);
    const unclassified = mutating
      .map((r) => demoRuleKey(r.method, r.url))
      .filter((key) => !(key in DEMO_RULES));
    expect(unclassified).toEqual([]);
    // And every rule belongs to a route (a removed route leaves no stale rule).
    const known = new Set(mutating.map((r) => demoRuleKey(r.method, r.url)));
    const stale = Object.keys(DEMO_RULES).filter((key) => !known.has(key));
    // The auth routes and the private-only routes are not in the demo.
    expect(stale).toEqual([]);
  });
});

describe("the demo rate limit", () => {
  it("the 31st mutation in a minute → 429", async () => {
    // AC-16.7
    const { call } = await demo();
    for (let i = 1; i <= 30; i += 1) {
      const response = await call("POST", "/daily-activity", { kind: "outreach", amount: 1 });
      expect(response.statusCode, `request ${i}`).toBe(200);
    }
    const limited = await call("POST", "/daily-activity", { kind: "outreach", amount: 1 });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: { code: "rate_limited" } });
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    // Reads are not counted.
    expect((await call("GET", "/today")).statusCode).toBe(200);
  });

  it("blocked mutations count too", async () => {
    const { call } = await demo();
    for (let i = 0; i < 30; i += 1) await call("POST", "/leads", {});
    expect(
      (await call("POST", "/daily-activity", { kind: "outreach", amount: 1 })).statusCode,
    ).toBe(429);
  });

  it("a private instance has no mutation limit of 30", async () => {
    const { app, deps } = await buildTestApp();
    const cookie = await signIn(app, deps);
    for (let i = 0; i < 31; i += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/daily-activity",
        headers: { cookie, ...CSRF },
        payload: { kind: "outreach", amount: 1 },
      });
      expect(response.statusCode).toBe(200);
    }
    await app.close();
  });
});
