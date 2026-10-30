import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SyncStatusSchema, TodaySchema } from "@offerbound/contracts";
import type { z } from "zod";
import { buildTestApp } from "../../test/app.js";
import { resetDb, testPrisma } from "../../test/db.js";
import { emailFixture } from "../../test/gmail.js";
import type { FakeGoogleAuthClient } from "../../test/fake-google.js";
import { drainPipeline } from "../../test/pipeline.js";
import type { RecordingQueue } from "../../test/queue.js";
import type { WorkerCtx } from "../deps.js";
import { GmailAuthError, type GmailClientFactory } from "../gmail/client.js";
import { FakeGmailClient } from "../gmail/fake-client.js";
import { runIncrementalSync } from "../gmail/sync.js";
import { QUEUES } from "../jobs/queues.js";

/**
 * Gmail access over the owner's weeks with Offerbound, end to end through the HTTP API
 * (AC-2.3 to 2.8, TECHNICAL_SPEC §13): Google stops honouring the grant, the owner sees why and
 * signs in again, and syncing resumes where it stopped; then the owner disconnects and connects
 * again. Each step builds on the one before. All data is fictional.
 */

const prisma = testPrisma();
const CSRF = { "x-offerbound-request": "1" };
const NOW = new Date("2026-10-01T12:00:00.000Z");

const mailbox = new FakeGmailClient([emailFixture("m-1", "2026-09-10T10:00:00.000Z")]);
/** While set, every Gmail call fails the way a revoked grant does. */
let grantRevoked = false;
const gmail: GmailClientFactory = () =>
  grantRevoked ? Promise.reject(new GmailAuthError("invalid_grant")) : Promise.resolve(mailbox);

let app: FastifyInstance;
let google: FakeGoogleAuthClient;
let queue: RecordingQueue;
let worker: WorkerCtx;
let cookie = "";

beforeAll(async () => {
  await resetDb(prisma);
  const built = await buildTestApp({ clock: () => NOW, gmail });
  app = built.app;
  google = built.deps.google as FakeGoogleAuthClient;
  queue = built.deps.queue as RecordingQueue;
  worker = { ...built.deps, log: pino({ level: "silent" }) };
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function get<T>(url: string, schema: z.ZodType<T>): Promise<T> {
  const res = await app.inject({ method: "GET", url: `/api/v1${url}`, headers: { cookie } });
  expect(res.statusCode, `GET ${url}: ${res.body}`).toBe(200);
  return schema.parse(res.json());
}

const post = (url: string) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, headers: { ...CSRF, cookie } });

async function signInWithGoogle(): Promise<string> {
  const start = await app.inject({ method: "GET", url: "/api/v1/auth/google/start" });
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
  if (session) cookie = `ob_session=${session.value}`;
  return done.headers.location as string;
}

const isScheduled = () => queue.schedules.some((s) => s.name === QUEUES.gmailSync);

describe("Gmail access, lost and restored", () => {
  it("1. the owner connects, starts syncing and the first mail is in", async () => {
    await signInWithGoogle();
    expect((await post("/gmail/start")).statusCode).toBe(202);
    await drainPipeline(worker);

    const status = await get("/gmail/status", SyncStatusSchema);
    expect(status).toMatchObject({ connection: "active", started: true, lastError: null });
    expect(status.backfill.state).toBe("done");
    expect(isScheduled()).toBe(true);
    expect(await prisma.gmailMessage.count()).toBe(1);
  });

  it("2. when Google stops honouring the grant, the sync stops and Today says why", async () => {
    grantRevoked = true;
    await runIncrementalSync(worker);

    const status = await get("/gmail/status", SyncStatusSchema);
    expect(status.connection).toBe("needs_reauth");
    expect(status.lastError).not.toBeNull();
    expect(isScheduled()).toBe(false);

    // Today carries the same status, which is what the reconnect banner reads.
    expect((await get("/today", TodaySchema)).sync.connection).toBe("needs_reauth");
  });

  it("3. Sync now cannot help until the owner reconnects", async () => {
    const res = await post("/gmail/sync");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: "not_connected" } });
  });

  it("4. signing in again restores the connection and the schedule, and new mail arrives", async () => {
    grantRevoked = false;
    await signInWithGoogle();

    const status = await get("/gmail/status", SyncStatusSchema);
    expect(status).toMatchObject({ connection: "active", started: true });
    expect(isScheduled()).toBe(true);

    mailbox.add(emailFixture("m-2", "2026-09-30T10:00:00.000Z"));
    await runIncrementalSync(worker);
    expect(await prisma.gmailMessage.count()).toBe(2);
    expect((await get("/gmail/status", SyncStatusSchema)).lastError).toBeNull();
  });

  it("5. disconnecting revokes the grant and stops the sync; the records stay", async () => {
    const res = await post("/gmail/disconnect");
    expect(res.statusCode).toBe(204);
    expect(google.revoked.length).toBeGreaterThan(0);
    expect(isScheduled()).toBe(false);
    expect((await get("/gmail/status", SyncStatusSchema)).connection).toBe("disconnected");
    expect(await prisma.gmailMessage.count()).toBe(2);
  });

  it("6. connecting again picks the sync up without a second Start syncing", async () => {
    await signInWithGoogle();
    const status = await get("/gmail/status", SyncStatusSchema);
    expect(status).toMatchObject({ connection: "active", started: true });
    expect(isScheduled()).toBe(true);
  });
});
