import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SyncStatusSchema, type ApiErrorBody } from "@offerbound/contracts";
import { encryptToken } from "../auth/crypto.js";
import { createBoss } from "../jobs/boss.js";
import { PgBossQueue } from "../jobs/queues.js";
import { FakeGmailClient, fakeGmailFactory } from "../gmail/fake-client.js";
import { startWorker } from "../worker.js";
import { buildTestApp, signIn, testEnv } from "../../test/app.js";
import { resetDb, testPrisma } from "../../test/db.js";
import { emailFixture, seedConnection, seedStartedConnection } from "../../test/gmail.js";
import { RecordingQueue } from "../../test/queue.js";
import type { FakeGoogleAuthClient } from "../../test/fake-google.js";
import { testWorkerCtx } from "../../test/worker.js";

const prisma = testPrisma();
const CSRF = { "x-offerbound-request": "1" };

const apps: FastifyInstance[] = [];
async function appWith(...args: Parameters<typeof buildTestApp>) {
  const built = await buildTestApp(...args);
  apps.push(built.app);
  const cookie = await signIn(built.app, built.deps);
  const queue = built.deps.queue as RecordingQueue;
  const google = built.deps.google as FakeGoogleAuthClient;
  const call = (method: "GET" | "POST", url: string) =>
    built.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { cookie, ...(method === "POST" ? CSRF : {}) },
    });
  return { ...built, cookie, queue, google, call };
}

beforeEach(async () => {
  await resetDb(prisma);
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const connectionRow = () => prisma.gmailConnection.findUniqueOrThrow({ where: { id: 1 } });
const errorCode = (body: string) => (JSON.parse(body) as ApiErrorBody).error.code;

describe("GET /gmail/status", () => {
  it("GET /gmail/status → not_connected without a connection", async () => {
    const { call } = await appWith();
    const res = await call("GET", "/gmail/status");
    expect(res.statusCode).toBe(200);
    expect(SyncStatusSchema.parse(res.json())).toEqual({
      connection: "not_connected",
      started: false,
      lastSyncAt: null,
      lastError: null,
      backfill: { state: "not_started", listed: 0, processed: 0 },
      queue: { discovered: 0, jobRelated: 0, extracted: 0, needsReview: 0, failed: 0 },
    });
  });

  it("GET /gmail/status counts discovered, job_related, extracted, needs_review and failed messages", async () => {
    const { call } = await appWith();
    await seedStartedConnection(prisma, {
      backfillListed: 9,
      lastSyncAt: new Date("2026-10-01T11:55:00.000Z"),
      lastSyncError: "gmail_unavailable: Gmail is temporarily unavailable (HTTP 503).",
    });
    const counts: [string, number][] = [
      ["discovered", 3],
      ["job_related", 2],
      ["extracted", 1],
      ["needs_review", 4],
      ["failed", 1],
      ["applied", 2],
      ["skipped", 1],
      ["triaged_out", 1],
    ];
    let n = 0;
    for (const [state, howMany] of counts) {
      for (let i = 0; i < howMany; i++) {
        await prisma.gmailMessage.create({
          data: {
            id: `m${n++}`,
            threadId: "t",
            internalDate: new Date("2026-09-10T10:00:00.000Z"),
            direction: "inbound",
            labelIds: [],
            state: state as "discovered",
          },
        });
      }
    }
    const res = await call("GET", "/gmail/status");
    expect(SyncStatusSchema.parse(res.json())).toEqual({
      connection: "active",
      started: true,
      lastSyncAt: "2026-10-01T11:55:00.000Z",
      lastError: "gmail_unavailable: Gmail is temporarily unavailable (HTTP 503).",
      backfill: { state: "running", listed: 9, processed: 9 },
      queue: { discovered: 3, jobRelated: 2, extracted: 1, needsReview: 4, failed: 1 },
    });
  });

  it("requires a session", async () => {
    const { app } = await appWith();
    const res = await app.inject({ method: "GET", url: "/api/v1/gmail/status" });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /gmail/start", () => {
  it("POST /gmail/start → 202, backfill running, gmail.backfill sent, gmail.sync scheduled '*/5 * * * *' in America/Monterrey", async () => {
    const { call, queue, deps } = await appWith();
    await seedConnection(prisma, { backfillSince: new Date("2020-01-01") });
    const res = await call("POST", "/gmail/start");
    expect(res.statusCode).toBe(202);
    const body = SyncStatusSchema.parse(res.json());
    expect(body).toMatchObject({
      connection: "active",
      started: true,
      backfill: { state: "running", listed: 0, processed: 0 },
    });

    const row = await connectionRow();
    expect(row.startedAt).toEqual(deps.clock());
    expect(row.backfillState).toBe("running");
    expect(row.backfillSince.toISOString().slice(0, 10)).toBe("2026-09-01"); // GMAIL_BACKFILL_SINCE
    expect(queue.sentNames).toEqual(["gmail.backfill"]);
    expect(queue.schedules).toEqual([
      { name: "gmail.sync", cron: "*/5 * * * *", tz: "America/Monterrey" },
    ]);
  });

  it("uses GMAIL_SYNC_INTERVAL_MINUTES for the schedule", async () => {
    const { call, queue } = await appWith({
      env: testEnv({ GMAIL_SYNC_INTERVAL_MINUTES: "10" }),
    });
    await seedConnection(prisma);
    await call("POST", "/gmail/start");
    expect(queue.schedules[0]?.cron).toBe("*/10 * * * *");
  });

  it("POST /gmail/start a second time → 409 already_running; without an active connection → 409 not_connected", async () => {
    const { call, queue } = await appWith();
    const none = await call("POST", "/gmail/start");
    expect(none.statusCode).toBe(409);
    expect(errorCode(none.body)).toBe("not_connected");

    await seedConnection(prisma, { status: "needs_reauth" });
    const reauth = await call("POST", "/gmail/start");
    expect(reauth.statusCode).toBe(409);
    expect(errorCode(reauth.body)).toBe("not_connected");
    await prisma.gmailConnection.update({ where: { id: 1 }, data: { status: "active" } });

    expect((await call("POST", "/gmail/start")).statusCode).toBe(202);
    const again = await call("POST", "/gmail/start");
    expect(again.statusCode).toBe(409);
    expect(errorCode(again.body)).toBe("already_running");
    expect(queue.sentNames).toEqual(["gmail.backfill"]); // the second press sent nothing
  });

  it("two presses at once start the backfill once", async () => {
    const { call, queue } = await appWith();
    await seedConnection(prisma);
    const [a, b] = await Promise.all([call("POST", "/gmail/start"), call("POST", "/gmail/start")]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([202, 409]);
    expect(queue.sentNames).toEqual(["gmail.backfill"]);
  });

  it("leaves the button usable when the queue is down", async () => {
    const { call, queue } = await appWith();
    await seedConnection(prisma);
    queue.failSendWith = new Error("connection refused");
    const failed = await call("POST", "/gmail/start");
    expect(failed.statusCode).toBe(500);
    expect(failed.body).not.toContain("connection refused");
    const row = await connectionRow();
    expect(row.startedAt).toBeNull();
    expect(row.backfillState).toBe("not_started");

    queue.failSendWith = null;
    expect((await call("POST", "/gmail/start")).statusCode).toBe(202);
  });

  it("needs the CSRF header", async () => {
    const { app, cookie } = await appWith();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/gmail/start",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /gmail/sync", () => {
  it("POST /gmail/sync → 202 and sends gmail.sync", async () => {
    const { call, queue } = await appWith();
    await seedStartedConnection(prisma, { backfillState: "done", historyId: "5" });
    const res = await call("POST", "/gmail/sync");
    expect(res.statusCode).toBe(202);
    expect(queue.sentNames).toEqual(["gmail.sync"]);
  });

  it("restarts a failed first sync, which resumes from its saved page", async () => {
    const { call, queue } = await appWith();
    await seedStartedConnection(prisma, {
      backfillState: "failed",
      backfillPageToken: "page-3",
      lastSyncError: "gmail_unavailable: Gmail is temporarily unavailable (HTTP 503).",
    });
    const res = await call("POST", "/gmail/sync");
    expect(res.statusCode).toBe(202);
    expect(queue.sentNames.sort()).toEqual(["gmail.backfill", "gmail.sync"]);
    const row = await connectionRow();
    expect(row.backfillState).toBe("running");
    expect(row.backfillPageToken).toBe("page-3");
  });

  it("does not restart a backfill that is running or done", async () => {
    for (const state of ["running", "done"] as const) {
      await resetDb(prisma);
      const { call, queue } = await appWith();
      await seedStartedConnection(prisma, { backfillState: state });
      await call("POST", "/gmail/sync");
      expect(queue.sentNames).toEqual(["gmail.sync"]);
    }
  });

  it("→ 409 not_connected without an active connection or before Start syncing", async () => {
    const { call, queue } = await appWith();
    expect(errorCode((await call("POST", "/gmail/sync")).body)).toBe("not_connected");
    await seedConnection(prisma);
    const notStarted = await call("POST", "/gmail/sync");
    expect(notStarted.statusCode).toBe(409);
    expect(errorCode(notStarted.body)).toBe("not_connected");
    await prisma.gmailConnection.update({
      where: { id: 1 },
      data: { status: "needs_reauth", startedAt: new Date() },
    });
    expect((await call("POST", "/gmail/sync")).statusCode).toBe(409);
    expect(queue.sent).toEqual([]);
  });
});

describe("POST /gmail/disconnect", () => {
  it("POST /gmail/disconnect revokes at Google, deletes tokens, sets disconnected, unschedules sync and keeps records", async () => {
    const { call, queue, google, deps } = await appWith();
    const key = deps.env.tokenEncryptionKey as Buffer;
    await seedStartedConnection(prisma, {
      backfillState: "done",
      historyId: "42",
      refreshTokenEnc: encryptToken("the-refresh-token", key),
      accessTokenEnc: encryptToken("the-access-token", key),
      accessTokenExpiresAt: new Date("2026-10-01T13:00:00.000Z"),
    });
    await prisma.gmailMessage.create({
      data: {
        id: "kept",
        threadId: "t",
        internalDate: new Date("2026-09-10T10:00:00.000Z"),
        direction: "inbound",
        labelIds: [],
        state: "applied",
      },
    });

    const res = await call("POST", "/gmail/disconnect");
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe("");
    expect(google.revoked).toEqual(["the-refresh-token"]);
    const row = await connectionRow();
    expect(row).toMatchObject({
      status: "disconnected",
      refreshTokenEnc: null,
      accessTokenEnc: null,
      accessTokenExpiresAt: null,
      historyId: "42", // kept, so reconnecting resumes
    });
    expect(queue.unscheduled).toEqual(["gmail.sync"]);
    expect(await prisma.gmailMessage.count()).toBe(1);
  });

  it("deletes the tokens even when Google refuses the revoke", async () => {
    const { call, google, deps } = await appWith();
    const key = deps.env.tokenEncryptionKey as Buffer;
    await seedStartedConnection(prisma, {
      status: "needs_reauth",
      refreshTokenEnc: encryptToken("already-invalid", key),
    });
    google.revoke = () => Promise.reject(new Error("invalid_token ana@quarry.example"));
    const res = await call("POST", "/gmail/disconnect");
    expect(res.statusCode).toBe(204);
    const row = await connectionRow();
    expect(row.status).toBe("disconnected");
    expect(row.refreshTokenEnc).toBeNull();
  });

  it("is repeatable, and → 409 not_connected when there never was a connection", async () => {
    const { call, google } = await appWith();
    expect(errorCode((await call("POST", "/gmail/disconnect")).body)).toBe("not_connected");
    await seedStartedConnection(prisma);
    expect((await call("POST", "/gmail/disconnect")).statusCode).toBe(204);
    expect((await call("POST", "/gmail/disconnect")).statusCode).toBe(204);
    expect(google.revoked).toHaveLength(1); // nothing left to revoke the second time
  });
});

describe("signing in again", () => {
  /** Runs the Google sign-in the way a browser would. */
  async function signInAgain(
    app: FastifyInstance,
    google: FakeGoogleAuthClient,
    refreshToken: string | undefined,
  ) {
    const start = await app.inject({ method: "GET", url: "/api/v1/auth/google/start" });
    const oauth = start.cookies.find((c) => c.name === "ob_oauth");
    const params = google.authUrls.at(-1);
    if (!oauth || !params) throw new Error("no oauth cookie");
    google.exchange = { ...google.exchange, refreshToken: refreshToken as string };
    return app.inject({
      method: "GET",
      url: `/api/v1/auth/google/callback?code=c&state=${params.state}`,
      headers: { cookie: `ob_oauth=${oauth.value}` },
    });
  }

  it("signing in again after needs_reauth reschedules sync and keeps the stored historyId", async () => {
    const { app, queue, google } = await appWith();
    await seedStartedConnection(prisma, {
      status: "needs_reauth",
      backfillState: "done",
      historyId: "42",
      lastSyncError: "invalid_grant: Google rejected the stored authorization.",
    });
    const res = await signInAgain(app, google, "brand-new-refresh-token");
    expect(res.statusCode).toBe(302);

    const row = await connectionRow();
    expect(row.status).toBe("active");
    expect(row.historyId).toBe("42");
    expect(row.lastSyncError).toBeNull();
    expect(queue.schedules).toEqual([
      { name: "gmail.sync", cron: "*/5 * * * *", tz: "America/Monterrey" },
    ]);
    expect(queue.sent).toEqual([]); // nothing to resume: the backfill had finished
  });

  it("continues a backfill that was interrupted by the lost authorization", async () => {
    const { app, queue, google } = await appWith();
    await seedStartedConnection(prisma, {
      status: "needs_reauth",
      backfillState: "running",
      backfillPageToken: "page-2",
      backfillListed: 500,
    });
    await signInAgain(app, google, "brand-new-refresh-token");
    expect(queue.sentNames).toEqual(["gmail.backfill"]);
    expect((await connectionRow()).backfillPageToken).toBe("page-2");
  });

  it("does not schedule anything before Start syncing", async () => {
    const { app, queue, google } = await appWith();
    await signInAgain(app, google, "first-refresh-token");
    expect(queue.schedules).toEqual([]);
    expect(queue.sent).toEqual([]);
  });

  it("still signs in when the queue is unreachable", async () => {
    const { app, queue, google } = await appWith();
    await seedStartedConnection(prisma, { status: "needs_reauth" });
    queue.failSendWith = new Error("down");
    const res = await signInAgain(app, google, "brand-new-refresh-token");
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).not.toContain("error");
    expect((await connectionRow()).status).toBe("active");
  });
});

describe("worker start", () => {
  const stops: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(stops.splice(0).map((stop) => stop()));
    // resetDb leaves pg-boss's own tables alone; do not leave a schedule behind.
    await prisma.$executeRaw`delete from pgboss.schedule where name = 'gmail.sync'`;
  });

  async function jobsSince(name: string, since: Date): Promise<number> {
    const rows = await prisma.$queryRaw<{ n: bigint }[]>`
      select count(*) as n from pgboss.job where name = ${name} and created_on >= ${since}`;
    return Number(rows[0]?.n ?? 0);
  }

  it("worker start re-sends gmail.backfill while backfill_state is running", async () => {
    await seedStartedConnection(prisma, { backfillState: "running" });
    const before = new Date();
    // A mailbox with nothing to list, so the resumed backfill finishes at once.
    const worker = await startWorker(
      testWorkerCtx({
        gmail: fakeGmailFactory(new FakeGmailClient([])),
        log: pino({ level: "silent" }),
      }),
    );
    stops.push(worker.stop);
    expect(await jobsSince("gmail.backfill", before)).toBe(1);
    await worker.stop();
  });

  it("does not re-send gmail.backfill once it is done, but registers the sync schedule", async () => {
    await seedStartedConnection(prisma, { backfillState: "done", historyId: "1" });
    const before = new Date();
    const worker = await startWorker(testWorkerCtx());
    stops.push(worker.stop);
    expect(await jobsSince("gmail.backfill", before)).toBe(0);
    const schedules = await prisma.$queryRaw<{ cron: string; timezone: string }[]>`
      select cron, timezone from pgboss.schedule where name = 'gmail.sync'`;
    expect(schedules).toEqual([{ cron: "*/5 * * * *", timezone: "America/Monterrey" }]);
    await worker.stop();
  });

  it("a worker picks up the resent backfill and completes it", async () => {
    await seedStartedConnection(prisma, { backfillState: "running" });
    const mailbox = new FakeGmailClient([
      emailFixture("w1", "2026-09-02T10:00:00.000Z"),
      emailFixture("w2", "2026-09-03T10:00:00.000Z"),
    ]);
    const worker = await startWorker(testWorkerCtx({ gmail: fakeGmailFactory(mailbox) }));
    stops.push(worker.stop);
    const deadline = Date.now() + 15_000;
    let state = "running";
    while (Date.now() < deadline && state !== "done") {
      await new Promise((r) => setTimeout(r, 200));
      state = (await connectionRow()).backfillState;
    }
    expect(state).toBe("done");
    expect(await prisma.gmailMessage.count()).toBe(2);
    await worker.stop();
  });
});

describe("GET /ready", () => {
  it("GET /ready → 503 not_ready while the queue isn't started", async () => {
    const queue = new RecordingQueue();
    queue.ready = false;
    const { app } = await appWith({ queue });
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(503);
    expect(errorCode(res.body)).toBe("not_ready");
    queue.ready = true;
    expect((await app.inject({ method: "GET", url: "/ready" })).statusCode).toBe(200);
  });

  it("is ready once a real PgBossQueue has started, and not before or after", async () => {
    const queue = new PgBossQueue(createBoss(testEnv().databaseUrl, "api"));
    const { app } = await appWith({ queue });
    expect((await app.inject({ method: "GET", url: "/ready" })).statusCode).toBe(503);
    await queue.start();
    expect((await app.inject({ method: "GET", url: "/ready" })).statusCode).toBe(200);
    await queue.stop({ graceful: false });
    expect((await app.inject({ method: "GET", url: "/ready" })).statusCode).toBe(503);
  });
});
