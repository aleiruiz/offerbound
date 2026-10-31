import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ApplicationDetailSchema,
  ImportSummarySchema,
  LeadSchema,
  MeSchema,
  NavCountsSchema,
  ReviewItemSchema,
  SettingsSchema,
  SheetPreviewSchema,
  SyncStatusSchema,
  TodaySchema,
  type Lead,
  type ReviewItem,
  type Settings,
} from "@offerbound/contracts";
import { z } from "zod";
import { buildTestApp, testEnv } from "../../test/app.js";
import { resetDb, testPrisma } from "../../test/db.js";
import type { FakeGoogleAuthClient } from "../../test/fake-google.js";
import { drainPipeline } from "../../test/pipeline.js";
import type { RecordingQueue } from "../../test/queue.js";
import type { WorkerCtx } from "../deps.js";
import { FIXTURE_OWNER_EMAIL, loadEmailFixtures } from "../fixtures/emails.js";
import { loadLeadBatches } from "../fixtures/leads.js";
import { FakeGmailClient, fakeGmailFactory } from "../gmail/fake-client.js";
import { runIncrementalSync } from "../gmail/sync.js";
import { QUEUES } from "../jobs/queues.js";
import type { LinkFetcher } from "../leads/ssrf.js";
import { FakeLlmProvider } from "../llm/fake-provider.js";

/**
 * The owner's first run, end to end through the HTTP API (TECHNICAL_SPEC §15, DECISIONS I-8 and
 * I-9). One app and one worker share the database, the fake Gmail mailbox, the fixture model and
 * the job queue, and each step builds on the one before, the way the owner walks through it:
 *
 *   sign in → connect Gmail → Start syncing → sign in again mid-setup → the backfill lands →
 *   review queue → spreadsheet import (twice) → search brief → finish setup → leads → new mail.
 *
 * The per-module integration tests cover each endpoint's errors. This one checks that the steps
 * fit together: what one screen leaves behind is what the next one reads. All data is fictional.
 */

const prisma = testPrisma();
const CSRF = { "x-offerbound-request": "1" };
const NOW = new Date("2026-10-01T12:00:00.000Z");

/** The owner's mailbox on day one: a few threads of every kind the pipeline handles. */
const MAILBOX = [
  "confirm-lever-kestrel-pay",
  "confirm-ashby-quarry-ai",
  "decoy-bank-fernhill",
  "invite-link-kestrel-pay",
  "invite-ics-quarry-ai-technical",
  "alert-linkedin-five-jobs",
  "reject-lowconf-kittiwake-systems",
];
/** Mail that arrives after setup, through the incremental sync. */
const LATER = ["reject-lever-kestrel-pay"];

const fixtures = loadEmailFixtures();
const fixture = (id: string) => {
  const found = fixtures.find((f) => f.id === id);
  if (!found) throw new Error(`no fixture ${id}`);
  return found;
};

/**
 * The fixture model. A backfill triages the whole backlog before it applies any of it, so the
 * messages the rules would decide from thread links learned earlier reach the model instead; the
 * model says what the fixture expects for those (see fixtures.integration.test.ts).
 */
function fakeModel(): FakeLlmProvider {
  const llm = FakeLlmProvider.fromFixtures({ emails: fixtures, leadBatches: loadLeadBatches() });
  for (const id of [...MAILBOX, ...LATER]) {
    const f = fixture(id);
    if (f.llm.triage === null && f.expected.triage === "job_related") {
      llm.register("triage", { messageId: f.id }, { id: f.id, jobRelated: true, confidence: 0.95 });
    }
  }
  return llm;
}

/** Every job link is a live posting. */
const verifiedPage: LinkFetcher = (url) =>
  Promise.resolve({
    status: 200,
    finalUrl: url,
    contentType: "text/html",
    body: "<html><body><h1>Open role</h1><p>We are hiring. Apply now.</p></body></html>",
  });

const mailbox = new FakeGmailClient(MAILBOX.map(fixture));

let app: FastifyInstance;
let google: FakeGoogleAuthClient;
let queue: RecordingQueue;
let worker: WorkerCtx;
let cookie = "";

beforeAll(async () => {
  await resetDb(prisma);
  const built = await buildTestApp({
    env: testEnv({ OWNER_EMAIL: FIXTURE_OWNER_EMAIL, GMAIL_BACKFILL_SINCE: "2026-09-01" }),
    clock: () => NOW,
    gmail: fakeGmailFactory(mailbox),
    llm: fakeModel(),
    fetchLink: verifiedPage,
  });
  app = built.app;
  google = built.deps.google as FakeGoogleAuthClient;
  google.identity = { ...google.identity, email: FIXTURE_OWNER_EMAIL };
  queue = built.deps.queue as RecordingQueue;
  worker = { ...built.deps, log: pino({ level: "silent" }) };
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

// --- Requests, the way the web client sends them ---

async function get<T>(url: string, schema: z.ZodType<T>): Promise<T> {
  const res = await app.inject({ method: "GET", url: `/api/v1${url}`, headers: { cookie } });
  expect(res.statusCode, `GET ${url}: ${res.body}`).toBe(200);
  return schema.parse(res.json());
}

function send(method: "POST" | "PUT" | "PATCH", url: string, payload?: object) {
  return app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { ...CSRF, cookie },
    ...(payload === undefined ? {} : { payload }),
  });
}

/** The Google sign-in, from the *Continue with Google* button to the callback's redirect. */
async function signInWithGoogle(): Promise<string> {
  const start = await app.inject({ method: "GET", url: "/api/v1/auth/google/start" });
  expect(start.statusCode).toBe(302);
  const oauth = start.cookies.find((c) => c.name === "ob_oauth");
  const state = google.authUrls.at(-1)?.state;
  if (!oauth || !state) throw new Error("start did not set the oauth cookie");
  const done = await app.inject({
    method: "GET",
    url: `/api/v1/auth/google/callback?${new URLSearchParams({ code: "auth-code", state }).toString()}`,
    headers: { cookie: `ob_oauth=${oauth.value}` },
  });
  expect(done.statusCode).toBe(302);
  const session = done.cookies.find((c) => c.name === "ob_session");
  if (!session) throw new Error("the callback set no session");
  cookie = `ob_session=${session.value}`;
  return done.headers.location as string;
}

function uploadSheet(content: string) {
  const boundary = "----offerbound-journey-boundary";
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="applications.csv"\r\n` +
        "Content-Type: text/csv\r\n\r\n",
    ),
    Buffer.from(content),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.inject({
    method: "POST",
    url: "/api/v1/import/sheet/preview",
    headers: { ...CSRF, cookie, "content-type": `multipart/form-data; boundary=${boundary}` },
    payload,
  });
}

const page = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });
const ApplicationListSchema = page(
  z.object({
    id: z.string(),
    status: z.string(),
    title: z.string(),
    company: z.object({ name: z.string() }),
  }),
);

async function applicationsByCompany(): Promise<Map<string, { id: string; status: string }>> {
  const list = await get("/applications?limit=100", ApplicationListSchema);
  return new Map(list.items.map((a) => [a.company.name, a]));
}

/** The owner's spreadsheet, as exported from their tracker. */
const SHEET = [
  "Company,Role,Country,City / modality,Date applied,Status,Salary,Sponsorship / relocation,Job link,Notes",
  // Gmail already found this one; the sheet words the role a little differently.
  "Quarry AI,Machine Learning Engineer,Mexico,Remote,2026-09-08,Applied,,,,",
  // The same posting Gmail found, by the exact title.
  `Kestrel Pay,"Senior Backend Engineer, Ledger",Mexico,Remote,2026-09-03,Applied,,,,`,
  // Only the sheet knows about this one.
  "Saltwind Labs,Platform Engineer,Mexico,Remote,2026-09-20,Applied,,,,",
].join("\n");

describe("the owner's first run", () => {
  it("1. an unknown visitor is sent to sign in", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/me" });
    expect(res.statusCode).toBe(401);
  });

  it("2. signing in with Google connects Gmail and opens onboarding, with nothing synced yet", async () => {
    expect(await signInWithGoogle()).toBe("/onboarding");

    const me = await get("/me", MeSchema);
    expect(me).toMatchObject({ email: FIXTURE_OWNER_EMAIL, onboardingCompleted: false });

    const status = await get("/gmail/status", SyncStatusSchema);
    expect(status).toMatchObject({ connection: "active", started: false });
    expect(status.backfill.state).toBe("not_started");
    expect(await prisma.gmailMessage.count()).toBe(0);
  });

  it("3. Start syncing begins the backfill and schedules the sync; a second press is refused", async () => {
    const res = await send("POST", "/gmail/start");
    expect(res.statusCode).toBe(202);
    expect(SyncStatusSchema.parse(res.json())).toMatchObject({ started: true });
    expect(queue.sentNames).toContain(QUEUES.gmailBackfill);
    expect(queue.schedules.map((s) => s.name)).toContain(QUEUES.gmailSync);

    const again = await send("POST", "/gmail/start");
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: { code: "already_running" } });
  });

  it("4. signing in again mid-setup comes back to onboarding with the sync still started", async () => {
    expect(await signInWithGoogle()).toBe("/onboarding");
    const status = await get("/gmail/status", SyncStatusSchema);
    expect(status.started).toBe(true);
    // The step the web client keys its progress on: Start syncing is done on the server.
    expect(status.backfill.state).toBe("running");
  });

  it("5. the backfill fills applications, interviews, leads and the review queue", async () => {
    await drainPipeline(worker);

    const status = await get("/gmail/status", SyncStatusSchema);
    expect(status.backfill.state).toBe("done");
    expect(status.queue).toMatchObject({ discovered: 0, jobRelated: 0, failed: 0 });

    const apps = await applicationsByCompany();
    expect([...apps.keys()].sort()).toEqual(["Kestrel Pay", "Quarry AI"]);
    expect(apps.get("Kestrel Pay")?.status).toBe("interviewing");
    expect(apps.get("Quarry AI")?.status).toBe("interviewing");

    const leads = await get("/leads?status=new&limit=100", page(LeadSchema));
    // The LinkedIn alert's five postings, each checked live and ranked.
    expect(leads.items.map((l) => l.company.name).sort()).toEqual([
      "Cedar Health",
      "Foxglove Data",
      "Lattice Mobility",
      "Orbital Freight Labs",
      "Pinecrest Pharma",
    ]);

    // The bank email is not job mail: nothing came of it.
    expect(
      await prisma.gmailMessage.findUniqueOrThrow({ where: { id: "decoy-bank-fernhill" } }),
    ).toMatchObject({ state: "triaged_out", applicationId: null });

    const review = await get("/review-items", page(ReviewItemSchema));
    expect(review.items.map((item) => item.kind)).toEqual(["low_confidence"]);
    expect(review.items[0]?.message?.id).toBe("reject-lowconf-kittiwake-systems");

    const nav = await get("/nav-counts", NavCountsSchema);
    expect(nav).toMatchObject({ openApplications: 2, openReview: 1 });
    expect(nav.newLeads).toBe(leads.items.length);
  });

  it("6. running the pipeline again changes nothing", async () => {
    const before = await counts();
    await drainPipeline(worker);
    expect(await counts()).toEqual(before);
  });

  it("7. resolving the review item empties the queue and Today agrees", async () => {
    const [item] = (await get("/review-items", page(ReviewItemSchema))).items as [ReviewItem];
    const res = await send("POST", `/review-items/${item.id}/resolve`, { action: "dismiss" });
    expect(res.statusCode, res.body).toBe(200);

    expect((await get("/review-items", page(ReviewItemSchema))).items).toEqual([]);
    const today = await get("/today", TodaySchema);
    expect(today.review.open).toBe(0);
    expect(today.sync.started).toBe(true);
    expect(today.pipeline.byStatus.interviewing).toBe(2);
  });

  it("8. the spreadsheet import skips what Gmail already found and adds the rest", async () => {
    const res = await uploadSheet(SHEET);
    expect(res.statusCode, res.body).toBe(200);
    const preview = SheetPreviewSchema.parse(res.json());
    expect(preview.totalRows).toBe(3);
    expect(preview.existingMatches).toBe(2);
    expect(preview.errors).toEqual([]);

    const commit = await send("POST", "/import/sheet/commit", { previewId: preview.previewId });
    expect(commit.statusCode, commit.body).toBe(201);
    expect(ImportSummarySchema.parse(commit.json())).toMatchObject({
      applicationsCreated: 1,
      skippedExisting: 2,
      errorRows: 0,
    });

    const apps = await applicationsByCompany();
    expect([...apps.keys()].sort()).toEqual(["Kestrel Pay", "Quarry AI", "Saltwind Labs"]);
    // The import did not move what Gmail had already moved further along.
    expect(apps.get("Quarry AI")?.status).toBe("interviewing");
  });

  it("9. importing the same file again adds nothing", async () => {
    const res = await uploadSheet(SHEET);
    expect(res.statusCode, res.body).toBe(200);
    const preview = SheetPreviewSchema.parse(res.json());
    expect(preview.existingMatches).toBe(3);

    const commit = await send("POST", "/import/sheet/commit", { previewId: preview.previewId });
    expect(commit.statusCode, commit.body).toBe(201);
    expect(ImportSummarySchema.parse(commit.json())).toMatchObject({
      applicationsCreated: 0,
      leadsCreated: 0,
      skippedExisting: 3,
    });
    expect((await applicationsByCompany()).size).toBe(3);
  });

  it("10. the search brief is saved and read back", async () => {
    const settings = await get("/settings", SettingsSchema);
    const next: Settings = {
      ...settings,
      search: { ...settings.search, brief: "Senior backend roles, remote from Mexico." },
    };
    const res = await send("PUT", "/settings", next);
    expect(res.statusCode, res.body).toBe(200);
    expect((await get("/settings", SettingsSchema)).search.brief).toBe(
      "Senior backend roles, remote from Mexico.",
    );
  });

  it("11. finishing setup sends the next sign-in to Today", async () => {
    const res = await send("POST", "/onboarding/complete");
    expect(res.statusCode).toBe(200);
    expect(MeSchema.parse(res.json()).onboardingCompleted).toBe(true);
    expect(await signInWithGoogle()).toBe("/today");
  });

  it("12. a lead is shortlisted, then marked applied, and becomes an application", async () => {
    const leads = await get("/leads?status=new&limit=100", page(LeadSchema));
    const lead = leads.items.find((l) => l.company.name === "Lattice Mobility") as Lead;
    expect(lead).toBeDefined();

    const shortlisted = await send("PATCH", `/leads/${lead.id}`, {
      version: lead.version,
      status: "shortlisted",
    });
    expect(shortlisted.statusCode, shortlisted.body).toBe(200);
    const current = LeadSchema.parse(shortlisted.json());
    expect(current.status).toBe("shortlisted");

    // A second tab still holding the old version is told what changed.
    const stale = await send("PATCH", `/leads/${lead.id}`, {
      version: lead.version,
      status: "dismissed",
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: "version_conflict" } });

    const applied = await send("POST", `/leads/${lead.id}/mark-applied`);
    expect(applied.statusCode, applied.body).toBe(201);
    const detail = ApplicationDetailSchema.parse(applied.json());
    expect(detail).toMatchObject({ status: "applied", leadId: lead.id, title: lead.title });

    expect((await applicationsByCompany()).get(lead.company.name)?.id).toBe(detail.id);
    const converted = await get("/leads?limit=200", page(LeadSchema));
    expect(converted.items.find((l) => l.id === lead.id)?.status).toBe("applied");
  });

  it("13. new mail after setup moves an application, and the move can be undone", async () => {
    for (const id of LATER) mailbox.add(fixture(id));
    await runIncrementalSync(worker);
    await drainPipeline(worker);

    const kestrel = (await applicationsByCompany()).get("Kestrel Pay");
    if (!kestrel) throw new Error("no Kestrel Pay application");
    expect(kestrel.status).toBe("rejected");

    const detail = await get(`/applications/${kestrel.id}`, ApplicationDetailSchema);
    const rejection = detail.timeline.find((entry) => entry.toStatus === "rejected");
    expect(rejection).toMatchObject({ messageId: "reject-lever-kestrel-pay", undoable: true });
    const undo = await send("POST", `/events/${rejection?.id}/undo`);
    expect(undo.statusCode, undo.body).toBe(200);
    expect((await applicationsByCompany()).get("Kestrel Pay")?.status).toBe("interviewing");
    const after = await get(`/applications/${kestrel.id}`, ApplicationDetailSchema);
    expect(after.timeline.find((entry) => entry.id === rejection?.id)?.undoneAt).not.toBeNull();
  });
});

async function counts() {
  return {
    messages: await prisma.gmailMessage.count(),
    applications: await prisma.application.count(),
    leads: await prisma.lead.count(),
    interviews: await prisma.interview.count(),
    events: await prisma.event.count(),
    reviewItems: await prisma.reviewItem.count(),
  };
}
