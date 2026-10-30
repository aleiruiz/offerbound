import { beforeEach, describe, expect, it } from "vitest";
import { resetDb, testPrisma } from "../../test/db.js";
import { emailFixture, seedStartedConnection } from "../../test/gmail.js";
import { testWorkerCtx } from "../../test/worker.js";
import {
  GmailAuthError,
  GmailRequestError,
  GmailRetryableError,
  type GmailClient,
} from "../gmail/client.js";
import { FakeGmailClient, fakeGmailFactory } from "../gmail/fake-client.js";
import { FakeLlmProvider } from "../llm/fake-provider.js";
import { LlmError } from "../llm/provider.js";
import { MAX_EXTRACT_RESENDS, resendPendingExtractions } from "../pipeline/triage.js";
import { HANDLERS, type JobInfo } from "./handlers.js";
import { QUEUE_CONFIG, QUEUES } from "./queues.js";

const prisma = testPrisma();

beforeEach(async () => {
  await resetDb(prisma);
});

const job = (over: Partial<JobInfo> = {}): JobInfo => ({
  data: {},
  retryCount: 0,
  retryLimit: 3,
  ...over,
});
const failing = (error: Error) => testWorkerCtx({ gmail: () => Promise.reject(error) });
const connectionRow = () => prisma.gmailConnection.findUniqueOrThrow({ where: { id: 1 } });

describe("gmail.sync handler", () => {
  const sync = HANDLERS[QUEUES.gmailSync];
  if (!sync) throw new Error("no gmail.sync handler");

  beforeEach(async () => {
    await seedStartedConnection(prisma, { backfillState: "done", historyId: "5" });
  });

  it("honours Retry-After by sending the job again after that wait", async () => {
    const ctx = failing(new GmailRetryableError(429, 90_000));
    await sync(ctx, job());
    expect(ctx.queue.sent).toEqual([
      { name: "gmail.sync", data: { deferrals: 1 }, opts: { startAfterSeconds: 90 } },
    ]);
    expect((await connectionRow()).lastSyncError).toMatch(/HTTP 429/);
  });

  it("clamps the wait to between one second and an hour", async () => {
    for (const [asked, waits] of [
      [0, 1],
      [400, 1],
      [99_999_999, 3600],
    ] as const) {
      const ctx = failing(new GmailRetryableError(429, asked));
      await sync(ctx, job());
      expect(ctx.queue.sent[0]?.opts.startAfterSeconds).toBe(waits);
    }
  });

  it("defers at most retryLimit times in a chain, then lets pg-boss retry", async () => {
    const ctx = failing(new GmailRetryableError(429, 30_000));
    await expect(sync(ctx, job({ data: { deferrals: 3 }, retryLimit: 3 }))).rejects.toBeInstanceOf(
      GmailRetryableError,
    );
    expect(ctx.queue.sent).toEqual([]);
    await sync(ctx, job({ data: { deferrals: 2 }, retryLimit: 3 }));
    expect(ctx.queue.sent[0]?.data).toEqual({ deferrals: 3 });
  });

  it("rethrows a retryable error without Retry-After for pg-boss's backoff", async () => {
    const error = new GmailRetryableError(503, null);
    const ctx = failing(error);
    await expect(sync(ctx, job())).rejects.toBe(error);
    expect(ctx.queue.sent).toEqual([]);
  });

  it("a cron tick skips while a deferred retry waits, so chains do not pile up", async () => {
    const rateLimited = failing(new GmailRetryableError(429, 600_000));
    await sync(rateLimited, job()); // the first tick defers
    expect(rateLimited.queue.sent).toHaveLength(1);

    // The next tick finds the deferred job waiting: it does not call Gmail or defer again.
    let calls = 0;
    const next = testWorkerCtx({
      queue: rateLimited.queue,
      gmail: () => {
        calls += 1;
        return Promise.reject(new GmailRetryableError(429, 600_000));
      },
    });
    await sync(next, job());
    expect(calls).toBe(0);
    expect(next.queue.sent).toHaveLength(1);
  });

  it("the deferred job and pg-boss retries run even while a delayed job waits", async () => {
    const ctx = failing(new GmailRetryableError(429, 60_000));
    await sync(ctx, job()); // one deferred job is now waiting
    let calls = 0;
    const running = testWorkerCtx({
      queue: ctx.queue,
      gmail: () => {
        calls += 1;
        return Promise.reject(new GmailRetryableError(503, null));
      },
    });
    await expect(sync(running, job({ data: { deferrals: 1 } }))).rejects.toBeInstanceOf(
      GmailRetryableError,
    );
    await expect(sync(running, job({ retryCount: 1 }))).rejects.toBeInstanceOf(GmailRetryableError);
    expect(calls).toBe(2);
  });

  it("a deferred job that is rate limited again defers once more", async () => {
    const ctx = failing(new GmailRetryableError(429, 60_000));
    await sync(ctx, job({ data: { deferrals: 1 } }));
    expect(ctx.queue.sent[0]?.data).toEqual({ deferrals: 2 });
  });

  it("ends normally when the authorization is gone, so it is not retried", async () => {
    const ctx = failing(new GmailAuthError("invalid_grant"));
    await sync(ctx, job());
    expect((await connectionRow()).status).toBe("needs_reauth");
  });
});

describe("gmail.backfill handler", () => {
  const backfill = HANDLERS[QUEUES.gmailBackfill];
  if (!backfill) throw new Error("no gmail.backfill handler");

  beforeEach(async () => {
    await seedStartedConnection(prisma, { backfillState: "running" });
  });

  it("keeps the backfill running while retries remain", async () => {
    const error = new GmailRetryableError(503, null);
    await expect(backfill(failing(error), job({ retryCount: 2, retryLimit: 5 }))).rejects.toBe(
      error,
    );
    expect((await connectionRow()).backfillState).toBe("running");
  });

  it("marks the backfill failed on the last attempt", async () => {
    const error = new GmailRetryableError(503, null);
    await expect(backfill(failing(error), job({ retryCount: 5, retryLimit: 5 }))).rejects.toBe(
      error,
    );
    const row = await connectionRow();
    expect(row.backfillState).toBe("failed");
    expect(row.lastSyncError).toMatch(/HTTP 503/);
  });

  it("marks the backfill failed at once for a request Gmail refuses", async () => {
    const error = new GmailRequestError(400);
    await expect(backfill(failing(error), job({ retryCount: 0, retryLimit: 5 }))).rejects.toBe(
      error,
    );
    expect((await connectionRow()).backfillState).toBe("failed");
  });

  it("leaves the backfill running when the authorization is lost, to resume after reconnecting", async () => {
    await backfill(failing(new GmailAuthError("invalid_grant")), job({ retryLimit: 5 }));
    const row = await connectionRow();
    expect(row.status).toBe("needs_reauth");
    expect(row.backfillState).toBe("running");
  });

  it("a worker-start re-send skips while a deferred backfill waits", async () => {
    const first = failing(new GmailRetryableError(429, 60_000));
    await backfill(first, job({ retryLimit: 5 }));
    let calls = 0;
    const resend = testWorkerCtx({
      queue: first.queue,
      gmail: () => {
        calls += 1;
        return Promise.reject(new GmailRetryableError(429, 60_000));
      },
    });
    await backfill(resend, job({ retryLimit: 5 }));
    expect(calls).toBe(0);
    expect(first.queue.sent).toHaveLength(1);
  });

  it("defers for Retry-After instead of failing", async () => {
    const ctx = failing(new GmailRetryableError(429, 45_000));
    await backfill(ctx, job({ retryCount: 5, retryLimit: 5 }));
    expect(ctx.queue.sent).toEqual([
      { name: "gmail.backfill", data: { deferrals: 1 }, opts: { startAfterSeconds: 45 } },
    ]);
    expect((await connectionRow()).backfillState).toBe("running");
  });
});

describe("queue configuration (TECHNICAL_SPEC §9)", () => {
  it("has the concurrency and retries of the job table", () => {
    const table: Record<string, [number, number, string]> = {
      "gmail.sync": [1, 3, "singleton"],
      "gmail.backfill": [1, 5, "singleton"],
      "email.triage": [1, 4, "singleton"],
      "email.extract": [4, 4, "stately"],
      "email.apply": [1, 3, "singleton"],
      "leads.check": [5, 2, "standard"],
      "leads.rank": [2, 3, "standard"],
      "leads.finalize": [1, 3, "singleton"],
      "search.run": [1, 0, "singleton"],
      "timers.tick": [1, 1, "singleton"],
      "backup.nightly": [1, 2, "singleton"],
      "demo.reset": [1, 1, "singleton"],
      "maintenance.daily": [1, 1, "singleton"],
    };
    expect(
      Object.fromEntries(
        Object.entries(QUEUE_CONFIG).map(([n, c]) => [n, [c.concurrency, c.retryLimit, c.policy]]),
      ),
    ).toEqual(table);
  });
});

describe("email.triage handler", () => {
  const triage = HANDLERS[QUEUES.emailTriage];
  if (!triage) throw new Error("no email.triage handler");

  /** Spam-labelled messages: the rules skip them, so no LLM or extraction is involved. */
  const spam = (n: number) =>
    Array.from({ length: n }, (_, i) => {
      const id = `s${String(i).padStart(2, "0")}`;
      return emailFixture(id, "2026-10-05T10:00:00.000Z", { labels: ["SPAM"] });
    });

  async function discover(ids: string[]): Promise<void> {
    await prisma.gmailMessage.createMany({
      data: ids.map((id) => ({
        id,
        threadId: `thr-${id}`,
        internalDate: new Date(0),
        direction: "inbound" as const,
        labelIds: [],
      })),
    });
  }

  const ctxFor = (client: GmailClient) =>
    testWorkerCtx({
      gmail: fakeGmailFactory(client),
      llm: FakeLlmProvider.fromFixtures({ emails: [], leadBatches: [] }),
    });

  /** A Gmail client whose metadata calls fail with `error`. */
  function failingMetadata(error: Error): GmailClient {
    const real = new FakeGmailClient([]);
    return {
      getProfile: () => real.getProfile(),
      listMessages: (q, t) => real.listMessages(q, t),
      listHistory: (s, t) => real.listHistory(s, t),
      getFull: (id) => real.getFull(id),
      getMetadata: () => Promise.reject(error),
    };
  }

  it("triages a batch, and a full batch sends the next one at once", async () => {
    const fixtures = spam(26);
    await discover(fixtures.map((f) => f.id));
    const ctx = ctxFor(new FakeGmailClient(fixtures));
    await triage(ctx, job());
    expect(ctx.queue.sentNames).toEqual(["email.triage"]);
    expect(await prisma.gmailMessage.count({ where: { state: "discovered" } })).toBe(1);

    const next = ctxFor(new FakeGmailClient(fixtures));
    await triage(next, job());
    expect(next.queue.sent).toEqual([]);
    expect(await prisma.gmailMessage.count({ where: { state: "discovered" } })).toBe(0);
  });

  it("sends messages that are still job_related to extraction again, keyed by id", async () => {
    // A send lost after the triage commit: the row is job_related and nothing is queued for it.
    await prisma.gmailMessage.createMany({
      data: ["j1", "j2"].map((id, i) => ({
        id,
        threadId: `thr-${id}`,
        internalDate: new Date(Date.UTC(2026, 9, 1 + i)),
        direction: "inbound" as const,
        labelIds: ["INBOX"],
        state: "job_related" as const,
      })),
    });
    const ctx = ctxFor(new FakeGmailClient([]));
    await triage(ctx, job());
    expect(ctx.queue.sent).toEqual([
      { name: "email.extract", data: { messageId: "j1" }, opts: { singletonKey: "j1" } },
      { name: "email.extract", data: { messageId: "j2" }, opts: { singletonKey: "j2" } },
    ]);
  });

  it("honours Retry-After during getMetadata: defers the job, counts no failed attempt", async () => {
    await discover(["a"]);
    const ctx = ctxFor(failingMetadata(new GmailRetryableError(429, 90_000)));
    await triage(ctx, job());
    expect(ctx.queue.sent).toEqual([
      { name: "email.triage", data: { deferrals: 1 }, opts: { startAfterSeconds: 90 } },
    ]);
    const stored = await prisma.gmailMessage.findUniqueOrThrow({ where: { id: "a" } });
    expect(stored).toMatchObject({ state: "discovered", attempts: 0, lastError: null });

    // The next cron tick finds the deferred job waiting and does not call Gmail.
    let calls = 0;
    const tick = testWorkerCtx({
      queue: ctx.queue,
      gmail: () => {
        calls += 1;
        return Promise.reject(new GmailRetryableError(429, 90_000));
      },
    });
    await triage(tick, job());
    expect(calls).toBe(0);
    expect(tick.queue.sent).toHaveLength(1);
  });

  it("rethrows a retryable error without Retry-After for pg-boss's backoff", async () => {
    await discover(["a"]);
    const error = new GmailRetryableError(503, null);
    await expect(triage(ctxFor(failingMetadata(error)), job())).rejects.toBe(error);
  });

  it("unschedules gmail.sync when the authorization is already marked lost", async () => {
    await seedStartedConnection(prisma, { status: "needs_reauth", backfillState: "done" });
    await discover(["a"]);
    const ctx = failing(new GmailAuthError("invalid_grant"));
    await triage(ctx, job());
    expect(ctx.queue.unscheduled).toEqual(["gmail.sync"]);
    expect((await connectionRow()).status).toBe("needs_reauth");
  });

  it("marks the connection and unschedules gmail.sync when a triage-first invalid_grant arrives", async () => {
    await seedStartedConnection(prisma, { backfillState: "done", historyId: "5" });
    await discover(["a"]);
    const ctx = failing(new GmailAuthError("invalid_grant"));
    await triage(ctx, job());
    expect(ctx.queue.unscheduled).toEqual(["gmail.sync"]);
    expect((await connectionRow()).status).toBe("needs_reauth");
  });

  it("unschedules gmail.sync for a missing scope too", async () => {
    await seedStartedConnection(prisma, { backfillState: "done", historyId: "5" });
    await discover(["a"]);
    const ctx = failing(new GmailAuthError("missing_scope"));
    await triage(ctx, job());
    expect(ctx.queue.unscheduled).toEqual(["gmail.sync"]);
    expect((await connectionRow()).status).toBe("missing_scope");
  });
});

describe("email.extract handler", () => {
  const extract = HANDLERS[QUEUES.emailExtract];
  if (!extract) throw new Error("no email.extract handler");

  const fixture = emailFixture("x1", "2026-10-05T10:00:00.000Z", { bodyText: "Hello there" });

  async function jobRelated(id = "x1"): Promise<void> {
    await prisma.gmailMessage.create({
      data: {
        id,
        threadId: `thr-${id}`,
        internalDate: new Date("2026-10-05T10:00:00.000Z"),
        direction: "inbound",
        labelIds: ["INBOX"],
        state: "job_related",
        subject: "Subject x1",
      },
    });
  }
  const stored = () => prisma.gmailMessage.findUniqueOrThrow({ where: { id: "x1" } });
  const extractJob = (over: Partial<JobInfo> = {}) =>
    job({ data: { messageId: "x1" }, retryLimit: 4, ...over });
  const withClient = (client: GmailClient, llm?: FakeLlmProvider) =>
    testWorkerCtx({
      gmail: fakeGmailFactory(client),
      llm: llm ?? FakeLlmProvider.fromFixtures({ emails: [], leadBatches: [] }),
    });
  function failingFull(error: Error): GmailClient {
    const real = new FakeGmailClient([fixture]);
    return {
      getProfile: () => real.getProfile(),
      listMessages: (q, t) => real.listMessages(q, t),
      listHistory: (s, t) => real.listHistory(s, t),
      getMetadata: (id) => real.getMetadata(id),
      getFull: () => Promise.reject(error),
    };
  }

  beforeEach(async () => {
    await jobRelated();
  });

  it("extracts the message in the job and queues email.apply", async () => {
    const ctx = withClient(new FakeGmailClient([fixture]));
    await extract(ctx, extractJob());
    expect((await stored()).state).toBe("extracted");
    expect(ctx.queue.sentNames).toEqual(["email.apply"]);
  });

  it("ignores a job without a message id", async () => {
    const ctx = withClient(new FakeGmailClient([fixture]));
    await extract(ctx, job({ data: {} }));
    expect(ctx.queue.sent).toEqual([]);
    expect((await stored()).state).toBe("job_related");
  });

  it("rethrows a retryable error while retries remain, and the message waits for the retry", async () => {
    const llm = FakeLlmProvider.fromFixtures({ emails: [], leadBatches: [] });
    const error = new LlmError("upstream", "down", { retryable: true });
    llm.failNext("extract", error);
    const ctx = withClient(new FakeGmailClient([fixture]), llm);
    await expect(extract(ctx, extractJob({ retryCount: 3 }))).rejects.toBe(error);
    expect(await stored()).toMatchObject({ state: "job_related", lastError: null });
    expect(await prisma.reviewItem.count()).toBe(0);
  });

  it("marks the message failed, with an extraction_failed review item, when the last retry fails", async () => {
    const llm = FakeLlmProvider.fromFixtures({ emails: [], leadBatches: [] });
    const error = new LlmError("timeout", "slow", { retryable: true });
    llm.failNext("extract", error);
    const ctx = withClient(new FakeGmailClient([fixture]), llm);
    await expect(extract(ctx, extractJob({ retryCount: 4 }))).rejects.toBe(error);
    expect(await stored()).toMatchObject({ state: "failed", lastError: "llm_timeout" });
    expect(await prisma.reviewItem.findMany()).toMatchObject([
      { kind: "extraction_failed", state: "open", messageId: "x1" },
    ]);
    // Triage's resend sweep no longer picks it up.
    const sweep = testWorkerCtx();
    await HANDLERS[QUEUES.emailTriage]?.(sweep, job());
    expect(sweep.queue.sent.filter((s) => s.name === "email.extract")).toEqual([]);
  });

  it("an incomplete answer is retried, and fails the message as llm_incomplete when retries run out", async () => {
    const error = new LlmError("incomplete", "cut off", { retryable: false });
    const llm = FakeLlmProvider.fromFixtures({ emails: [], leadBatches: [] });
    llm.failNext("extract", error);
    await expect(
      extract(withClient(new FakeGmailClient([fixture]), llm), extractJob({ retryCount: 2 })),
    ).rejects.toBe(error);
    expect((await stored()).state).toBe("job_related");

    llm.failNext("extract", error);
    await expect(
      extract(withClient(new FakeGmailClient([fixture]), llm), extractJob({ retryCount: 4 })),
    ).rejects.toBe(error);
    expect(await stored()).toMatchObject({ state: "failed", lastError: "llm_incomplete" });
    expect(await prisma.reviewItem.count({ where: { kind: "extraction_failed" } })).toBe(1);
  });

  it("does nothing, and unschedules nothing again, while the authorization is already lost", async () => {
    await seedStartedConnection(prisma, { status: "needs_reauth", backfillState: "done" });
    let calls = 0;
    const ctx = testWorkerCtx({
      gmail: () => {
        calls += 1;
        return Promise.reject(new GmailAuthError("invalid_grant"));
      },
    });
    await extract(ctx, extractJob());
    await extract(ctx, extractJob());
    expect(calls).toBe(0);
    expect(ctx.queue.unscheduled).toEqual([]);
    expect(await stored()).toMatchObject({ state: "job_related", lastError: null });
  });

  it("marks the message failed on the last retry after a Gmail outage too", async () => {
    const error = new GmailRetryableError(503, null);
    const ctx = withClient(failingFull(error));
    await expect(extract(ctx, extractJob({ retryCount: 4 }))).rejects.toBe(error);
    expect(await stored()).toMatchObject({ state: "failed", lastError: "gmail_unavailable" });
  });

  it("honours Retry-After: sends the job again for this message after the wait, keyed by its id", async () => {
    const ctx = withClient(failingFull(new GmailRetryableError(429, 90_000)));
    await extract(ctx, extractJob());
    expect(ctx.queue.sent).toEqual([
      {
        name: "email.extract",
        data: { messageId: "x1", deferrals: 1 },
        opts: { startAfterSeconds: 90, singletonKey: "x1" },
      },
    ]);
    expect((await stored()).state).toBe("job_related");
  });

  describe("the resend sweep's wait", () => {
    const NOW = new Date("2026-10-01T12:00:00.000Z"); // the test context's clock
    const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);
    const sweepAt = (at: Date) => testWorkerCtx({ clock: () => at });

    it("a Retry-After deferral moves the wait to the deferred job's due time and forgets earlier resends", async () => {
      await prisma.gmailMessage.update({
        where: { id: "x1" },
        data: { attempts: MAX_EXTRACT_RESENDS - 1, processedAt: minutes(-30) },
      });
      const ctx = withClient(failingFull(new GmailRetryableError(429, 3_600_000)));
      await extract(ctx, extractJob());
      expect(ctx.queue.sent[0]?.opts.startAfterSeconds).toBe(3600);
      expect(await stored()).toMatchObject({
        state: "job_related",
        attempts: 0,
        processedAt: minutes(60),
      });

      // Sweeps while the deferred job waits (and for 10 minutes after it is due) change nothing,
      // however many there are: the message is never failed for waiting.
      for (const at of [10, 20, 30, 40, 50, 60, 69]) {
        const sweep = sweepAt(minutes(at));
        expect(await resendPendingExtractions(sweep)).toBe(0);
        expect(sweep.queue.sent).toEqual([]);
      }
      expect(await stored()).toMatchObject({ state: "job_related", attempts: 0 });
      expect(await prisma.reviewItem.count()).toBe(0);

      // Only once the job is overdue by the full wait is it treated as lost.
      const late = sweepAt(minutes(71));
      expect(await resendPendingExtractions(late)).toBe(1);
      expect((await stored()).attempts).toBe(1);
    });

    it("each attempt stamps processed_at, so a long chain never gets a second chain beside it", async () => {
      await prisma.gmailMessage.update({
        where: { id: "x1" },
        data: { processedAt: minutes(-60), attempts: 3 },
      });
      const llm = FakeLlmProvider.fromFixtures({ emails: [], leadBatches: [] });
      const error = new LlmError("upstream", "down", { retryable: true });
      llm.failNext("extract", error);
      const ctx = withClient(new FakeGmailClient([fixture]), llm);
      await expect(extract(ctx, extractJob({ retryCount: 2 }))).rejects.toBe(error);
      // Stamped now; the resend count is untouched, so a job that crashes every time still
      // reaches the cap.
      expect(await stored()).toMatchObject({ processedAt: NOW, attempts: 3 });

      // The chain is in backoff; a sweep 9 minutes later leaves it alone.
      const sweep = sweepAt(minutes(9));
      expect(await resendPendingExtractions(sweep)).toBe(0);
      expect(sweep.queue.sent).toEqual([]);
    });
  });

  it("defers every rate-limited message, not just the first one waiting in the queue", async () => {
    await jobRelated("x2");
    const ctx = withClient(failingFull(new GmailRetryableError(429, 30_000)));
    await extract(ctx, extractJob());
    await extract(ctx, job({ data: { messageId: "x2" }, retryLimit: 4 }));
    expect(ctx.queue.sent.map((s) => s.opts.singletonKey)).toEqual(["x1", "x2"]);
  });

  it("defers at most retryLimit times, then lets pg-boss retry", async () => {
    const error = new GmailRetryableError(429, 30_000);
    const ctx = withClient(failingFull(error));
    await expect(
      extract(ctx, extractJob({ data: { messageId: "x1", deferrals: 4 } })),
    ).rejects.toBe(error);
    expect(ctx.queue.sent).toEqual([]);
  });

  it("ends normally and stops gmail.sync when the authorization is lost", async () => {
    await seedStartedConnection(prisma, { backfillState: "done", historyId: "5" });
    const ctx = testWorkerCtx({ gmail: () => Promise.reject(new GmailAuthError("invalid_grant")) });
    await extract(ctx, extractJob({ retryCount: 4 }));
    expect(ctx.queue.unscheduled).toEqual(["gmail.sync"]);
    expect((await connectionRow()).status).toBe("needs_reauth");
    // Waiting for the owner to reconnect is not a failed extraction.
    expect(await stored()).toMatchObject({ state: "job_related", lastError: null });
    expect(await prisma.reviewItem.count()).toBe(0);
  });

  it("a request Gmail refuses fails the message at once and ends the job", async () => {
    const ctx = withClient(failingFull(new GmailRequestError(400)));
    await extract(ctx, extractJob());
    expect(await stored()).toMatchObject({ state: "failed", lastError: "gmail_request_failed" });
  });
});
