import { beforeEach, describe, expect, it } from "vitest";
import { resetDb, testPrisma } from "../../test/db.js";
import { seedStartedConnection } from "../../test/gmail.js";
import { testWorkerCtx } from "../../test/worker.js";
import { GmailAuthError, GmailRequestError, GmailRetryableError } from "../gmail/client.js";
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
