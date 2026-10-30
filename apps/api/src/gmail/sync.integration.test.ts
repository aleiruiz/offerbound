import { beforeEach, describe, expect, it } from "vitest";
import { resetDb, testPrisma } from "../../test/db.js";
import { emailFixture, seedConnection, seedStartedConnection } from "../../test/gmail.js";
import { testWorkerCtx } from "../../test/worker.js";
import {
  GmailAuthError,
  GmailHistoryExpiredError,
  GmailRequestError,
  GmailRetryableError,
  type GmailClient,
} from "./client.js";
import { FakeGmailClient, fakeGmailFactory } from "./fake-client.js";
import { getSyncStatus, markBackfillFailed, runBackfill, runIncrementalSync } from "./sync.js";

const prisma = testPrisma();

beforeEach(async () => {
  await resetDb(prisma);
});

/** A GmailClient that forwards to another and lets a test hook each call. */
class SpyClient implements GmailClient {
  listCalls: { q: string; pageToken: string | null }[] = [];
  historyCalls: { start: string; pageToken: string | null }[] = [];
  profileCalls = 0;
  beforeList: ((callNumber: number) => Promise<void> | void) | null = null;
  beforeHistory: ((callNumber: number) => Promise<void> | void) | null = null;
  constructor(private readonly inner: GmailClient) {}
  getProfile() {
    this.profileCalls += 1;
    return this.inner.getProfile();
  }
  async listMessages(q: string, pageToken: string | null) {
    this.listCalls.push({ q, pageToken });
    await this.beforeList?.(this.listCalls.length);
    return this.inner.listMessages(q, pageToken);
  }
  async listHistory(start: string, pageToken: string | null) {
    this.historyCalls.push({ start, pageToken });
    await this.beforeHistory?.(this.historyCalls.length);
    return this.inner.listHistory(start, pageToken);
  }
  getMetadata(id: string) {
    return this.inner.getMetadata(id);
  }
  getFull(id: string) {
    return this.inner.getFull(id);
  }
}

/** Five messages dated after the backfill start, one before it. */
const FIVE = [
  emailFixture("m1", "2026-09-02T10:00:00.000Z"),
  emailFixture("m2", "2026-09-03T10:00:00.000Z"),
  emailFixture("m3", "2026-09-04T10:00:00.000Z"),
  emailFixture("m4", "2026-09-05T10:00:00.000Z"),
  emailFixture("m5", "2026-09-06T10:00:00.000Z"),
];

function ctxWith(client: GmailClient) {
  return testWorkerCtx({ gmail: fakeGmailFactory(client) });
}

const connectionRow = () => prisma.gmailConnection.findUniqueOrThrow({ where: { id: 1 } });
const messageIds = async () =>
  (await prisma.gmailMessage.findMany({ select: { id: true }, orderBy: { id: "asc" } })).map(
    (m) => m.id,
  );

describe("runBackfill", () => {
  it("stores historyId from getProfile before listing", async () => {
    await seedStartedConnection(prisma);
    const spy = new SpyClient(new FakeGmailClient(FIVE, { profileHistoryId: "777" }));
    let seenDuringFirstList: string | null = null;
    spy.beforeList = async () => {
      seenDuringFirstList = (await connectionRow()).historyId;
    };
    await runBackfill(ctxWith(spy));
    expect(seenDuringFirstList).toBe("777");
    expect((await connectionRow()).historyId).toBe("777");
  });

  it("lists with q 'after:2026/08/31 -in:spam -in:trash -in:drafts' for GMAIL_BACKFILL_SINCE 2026-09-01", async () => {
    await seedStartedConnection(prisma, { backfillSince: new Date("2026-09-01") });
    const spy = new SpyClient(new FakeGmailClient(FIVE));
    await runBackfill(ctxWith(spy));
    expect(spy.listCalls[0]?.q).toBe("after:2026/08/31 -in:spam -in:trash -in:drafts");
  });

  it("inserts ids as discovered and saves the page token after each page", async () => {
    await seedStartedConnection(prisma);
    const spy = new SpyClient(new FakeGmailClient(FIVE, { pageSize: 2 }));
    const seen: { rows: number; token: string | null; listed: number }[] = [];
    spy.beforeList = async () => {
      const row = await connectionRow();
      seen.push({
        rows: await prisma.gmailMessage.count(),
        token: row.backfillPageToken,
        listed: row.backfillListed,
      });
    };
    await runBackfill(ctxWith(spy));

    // Before page 1 nothing; before page 2 the first page is stored with its token; and so on.
    expect(seen.map((s) => s.rows)).toEqual([0, 2, 4]);
    expect(seen.map((s) => s.listed)).toEqual([0, 2, 4]);
    expect(seen[0]?.token).toBeNull();
    expect(seen[1]?.token).toBe(spy.listCalls[1]?.pageToken);
    expect(seen[2]?.token).toBe(spy.listCalls[2]?.pageToken);

    const rows = await prisma.gmailMessage.findMany();
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.state === "discovered")).toBe(true);
    expect(rows.find((r) => r.id === "m1")?.threadId).toBe("thr-m1");
    expect((await connectionRow()).backfillListed).toBe(5);
  });

  it("resumes from the saved page token after a restart", async () => {
    await seedStartedConnection(prisma);
    const crashing = new SpyClient(new FakeGmailClient(FIVE, { pageSize: 2 }));
    crashing.beforeList = (n) => {
      if (n === 2) throw new GmailRetryableError(503);
    };
    await expect(runBackfill(ctxWith(crashing))).rejects.toBeInstanceOf(GmailRetryableError);
    const saved = (await connectionRow()).backfillPageToken;
    expect(saved).not.toBeNull();
    expect(await messageIds()).toHaveLength(2);

    // A new process, a new client: it continues from the stored token and lists the rest once.
    const restarted = new SpyClient(new FakeGmailClient(FIVE, { pageSize: 2 }));
    await runBackfill(ctxWith(restarted));
    expect(restarted.listCalls[0]?.pageToken).toBe(saved);
    expect(restarted.profileCalls).toBe(0); // the history id is already stored
    expect(await messageIds()).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    const row = await connectionRow();
    expect(row.backfillListed).toBe(5); // no page counted twice
    expect(row.backfillState).toBe("done");
    expect(row.backfillPageToken).toBeNull();
  });

  it("ignores ids that are already stored", async () => {
    await seedStartedConnection(prisma);
    const processed = new Date("2026-09-02T10:00:00.000Z");
    await prisma.gmailMessage.create({
      data: {
        id: "m1",
        threadId: "thr-m1",
        internalDate: processed,
        direction: "inbound",
        labelIds: ["INBOX"],
        state: "triaged_out",
      },
    });
    await runBackfill(ctxWith(new FakeGmailClient(FIVE)));
    expect(await prisma.gmailMessage.count()).toBe(5);
    const kept = await prisma.gmailMessage.findUniqueOrThrow({ where: { id: "m1" } });
    expect(kept.state).toBe("triaged_out");
    expect(kept.internalDate).toEqual(processed);
  });

  it("sets backfill_state done, then enqueues email.triage", async () => {
    await seedStartedConnection(prisma);
    const ctx = ctxWith(new FakeGmailClient(FIVE));
    await runBackfill(ctx);
    const row = await connectionRow();
    expect(row.backfillState).toBe("done");
    expect(row.lastSyncAt).toEqual(ctx.clock());
    expect(row.lastSyncError).toBeNull();
    expect(ctx.queue.sentNames).toEqual(["email.triage"]);
  });

  it("does nothing unless the backfill is running on an active connection", async () => {
    for (const over of [
      { backfillState: "not_started" as const, startedAt: null },
      { backfillState: "done" as const },
      { backfillState: "failed" as const },
      { status: "needs_reauth" as const },
    ]) {
      await resetDb(prisma);
      await seedStartedConnection(prisma, over);
      const spy = new SpyClient(new FakeGmailClient(FIVE));
      const ctx = ctxWith(spy);
      await runBackfill(ctx);
      expect(spy.listCalls).toEqual([]);
      expect(ctx.queue.sent).toEqual([]);
    }
  });

  it("a second delivery after completion changes nothing", async () => {
    await seedStartedConnection(prisma);
    const ctx = ctxWith(new FakeGmailClient(FIVE));
    await runBackfill(ctx);
    const before = await connectionRow();
    await runBackfill(ctx);
    expect(await connectionRow()).toEqual(before);
    expect(ctx.queue.sentNames).toEqual(["email.triage"]);
  });

  it("stops saving when the connection is disconnected while it runs", async () => {
    await seedStartedConnection(prisma);
    const spy = new SpyClient(new FakeGmailClient(FIVE, { pageSize: 2 }));
    spy.beforeList = async (n) => {
      if (n === 2) {
        await prisma.gmailConnection.update({
          where: { id: 1 },
          data: { status: "disconnected", refreshTokenEnc: null },
        });
      }
    };
    const ctx = ctxWith(spy);
    await runBackfill(ctx);
    expect(spy.listCalls).toHaveLength(2); // it did not go on to page 3
    expect(await prisma.gmailMessage.count()).toBe(2);
    const row = await connectionRow();
    expect(row.status).toBe("disconnected");
    expect(row.backfillState).toBe("running"); // resumes after the owner reconnects
    expect(ctx.queue.sent).toEqual([]);
  });

  it("markBackfillFailed turns a running backfill into failed", async () => {
    await seedStartedConnection(prisma);
    await markBackfillFailed(testWorkerCtx());
    expect((await connectionRow()).backfillState).toBe("failed");
  });
});

describe("runIncrementalSync", () => {
  it("incremental sync inserts history additions and stores the newest historyId only after the inserts commit", async () => {
    await seedStartedConnection(prisma, { backfillState: "done", historyId: "5" });
    const fake = new FakeGmailClient(FIVE, { pageSize: 1 }); // history id is now 5
    fake.add(emailFixture("n1", "2026-10-01T09:00:00.000Z"));
    fake.add(emailFixture("n2", "2026-10-01T09:01:00.000Z"));
    fake.add(emailFixture("n3", "2026-10-01T09:02:00.000Z"));

    // A failure on the third page leaves the stored history id where it was.
    const failing = new SpyClient(fake);
    failing.beforeHistory = (n) => {
      if (n === 3) throw new GmailRetryableError(500);
    };
    await expect(runIncrementalSync(ctxWith(failing))).rejects.toBeInstanceOf(GmailRetryableError);
    expect((await connectionRow()).historyId).toBe("5");
    expect(await messageIds()).toEqual(["n1", "n2"]); // inserted so far; the retry adds the rest

    const ctx = ctxWith(fake);
    await runIncrementalSync(ctx);
    expect(await messageIds()).toEqual(["n1", "n2", "n3"]);
    const row = await connectionRow();
    expect(row.historyId).toBe("8");
    expect(row.lastSyncAt).toEqual(ctx.clock());
    expect(row.lastSyncError).toBeNull();
    expect(ctx.queue.sentNames).toEqual(["email.triage"]);
  });

  it("a sync with nothing new still records last_sync_at and sends nothing", async () => {
    await seedStartedConnection(prisma, {
      backfillState: "done",
      historyId: "5",
      lastSyncError: "old error",
    });
    const ctx = ctxWith(new FakeGmailClient(FIVE));
    await runIncrementalSync(ctx);
    const row = await connectionRow();
    expect(row.lastSyncAt).toEqual(ctx.clock());
    expect(row.lastSyncError).toBeNull();
    expect(ctx.queue.sent).toEqual([]);
  });

  it("an expired history id resets from getProfile and re-lists after the newest processed internal_date minus 1 day", async () => {
    await seedStartedConnection(prisma, { backfillState: "done", historyId: "2" });
    const processedAt = new Date("2026-09-20T15:00:00.000Z");
    await prisma.gmailMessage.createMany({
      data: [
        {
          id: "old",
          threadId: "thr-old",
          internalDate: new Date("2026-09-10T10:00:00.000Z"),
          direction: "inbound",
          labelIds: [],
          state: "applied",
        },
        {
          id: "newest",
          threadId: "thr-newest",
          internalDate: processedAt,
          direction: "inbound",
          labelIds: [],
          state: "triaged_out",
        },
        {
          // Not yet processed: its placeholder date must not count.
          id: "pending",
          threadId: "thr-pending",
          internalDate: new Date(0),
          direction: "inbound",
          labelIds: [],
          state: "discovered",
        },
      ],
    });
    const mailbox = [
      emailFixture("old", "2026-09-10T10:00:00.000Z"),
      emailFixture("newest", processedAt.toISOString()),
      emailFixture("p1", "2026-09-18T10:00:00.000Z"), // before the cut: not re-listed
      emailFixture("p2", "2026-09-19T12:00:00.000Z"), // after the cut
      emailFixture("p3", "2026-09-25T10:00:00.000Z"),
    ];
    const spy = new SpyClient(
      new FakeGmailClient(mailbox, { historyExpired: true, profileHistoryId: "900" }),
    );
    const ctx = ctxWith(spy);
    await runIncrementalSync(ctx);

    expect(spy.listCalls[0]?.q).toBe("after:2026/09/19 -in:spam -in:trash -in:drafts");
    expect(await messageIds()).toEqual(["newest", "old", "p2", "p3", "pending"]);
    // The processed rows were not touched by the duplicate inserts.
    expect((await prisma.gmailMessage.findUniqueOrThrow({ where: { id: "newest" } })).state).toBe(
      "triaged_out",
    );
    const row = await connectionRow();
    expect(row.historyId).toBe("900");
    expect(row.lastSyncAt).toEqual(ctx.clock());
    expect(ctx.queue.sentNames).toEqual(["email.triage"]);
  });

  it("an expired history id with nothing processed re-lists from the backfill start", async () => {
    await seedStartedConnection(prisma, { backfillState: "done", historyId: "2" });
    const spy = new SpyClient(new FakeGmailClient(FIVE, { historyExpired: true }));
    await runIncrementalSync(ctxWith(spy));
    expect(spy.listCalls[0]?.q).toBe("after:2026/08/31 -in:spam -in:trash -in:drafts");
    expect(await prisma.gmailMessage.count()).toBe(5);
  });

  it("a failed re-list after an expired history id keeps the old history id so the retry re-lists", async () => {
    await seedStartedConnection(prisma, { backfillState: "done", historyId: "2" });
    const fake = new FakeGmailClient(FIVE, { historyExpired: true, profileHistoryId: "900" });
    const failing = new SpyClient(fake);
    failing.beforeList = () => {
      throw new GmailRetryableError(503);
    };
    await expect(runIncrementalSync(ctxWith(failing))).rejects.toBeInstanceOf(GmailRetryableError);
    expect((await connectionRow()).historyId).toBe("2");
  });

  it("invalid_grant sets needs_reauth and last_sync_error and unschedules gmail.sync", async () => {
    await seedStartedConnection(prisma, { backfillState: "done", historyId: "5" });
    const ctx = testWorkerCtx({
      gmail: () => Promise.reject(new GmailAuthError("invalid_grant")),
    });
    await runIncrementalSync(ctx);
    const row = await connectionRow();
    expect(row.status).toBe("needs_reauth");
    expect(row.lastSyncError).toMatch(/^invalid_grant/);
    expect(row.historyId).toBe("5"); // kept for the reconnect
    expect(ctx.queue.unscheduled).toEqual(["gmail.sync"]);
  });

  it("missing_scope sets missing_scope and unschedules gmail.sync", async () => {
    await seedStartedConnection(prisma, { backfillState: "done", historyId: "5" });
    const ctx = testWorkerCtx({
      gmail: () => Promise.reject(new GmailAuthError("missing_scope")),
    });
    await runIncrementalSync(ctx);
    const row = await connectionRow();
    expect(row.status).toBe("missing_scope");
    expect(row.lastSyncError).toMatch(/^missing_scope/);
    expect(ctx.queue.unscheduled).toEqual(["gmail.sync"]);
  });

  it("an invalid_grant from a job that started before a reconnect does not flip the new row", async () => {
    await seedStartedConnection(prisma, { backfillState: "done", historyId: "5" });
    const fake = new FakeGmailClient(FIVE);
    const stale = new SpyClient(fake);
    stale.beforeHistory = async () => {
      // The owner reconnects (a new refresh token) while the old token's job is failing.
      await prisma.gmailConnection.update({
        where: { id: 1 },
        data: { refreshTokenEnc: "v1:replaced:replaced:replaced" },
      });
      throw new GmailAuthError("invalid_grant");
    };
    const ctx = ctxWith(stale);
    await runIncrementalSync(ctx);
    const row = await connectionRow();
    expect(row.status).toBe("active");
    expect(row.lastSyncError).toBeNull();
    expect(ctx.queue.unscheduled).toEqual([]);
  });

  it("a retryable error records last_sync_error and rethrows", async () => {
    await seedStartedConnection(prisma, { backfillState: "done", historyId: "5" });
    const retryable = new GmailRetryableError(429, 30_000);
    const ctx = testWorkerCtx({ gmail: () => Promise.reject(retryable) });
    await expect(runIncrementalSync(ctx)).rejects.toBe(retryable);
    const row = await connectionRow();
    expect(row.status).toBe("active");
    expect(row.lastSyncError).toMatch(/^gmail_unavailable: .*HTTP 429/);
    expect(ctx.queue.unscheduled).toEqual([]);
  });

  it("a request Gmail refuses records last_sync_error and rethrows", async () => {
    await seedStartedConnection(prisma, { backfillState: "done", historyId: "5" });
    const refused = new GmailRequestError(400);
    const ctx = testWorkerCtx({ gmail: () => Promise.reject(refused) });
    await expect(runIncrementalSync(ctx)).rejects.toBe(refused);
    expect((await connectionRow()).lastSyncError).toMatch(/^gmail_request_failed: .*HTTP 400/);
  });

  it("last_sync_error never carries an error's own message", async () => {
    await seedStartedConnection(prisma, { backfillState: "done", historyId: "5" });
    const odd = new Error("select * from gmail_message where from_email = 'ana@quarry.example'");
    const ctx = testWorkerCtx({ gmail: () => Promise.reject(odd) });
    await expect(runIncrementalSync(ctx)).rejects.toBe(odd);
    const error = (await connectionRow()).lastSyncError ?? "";
    expect(error).toMatch(/^sync_failed/);
    expect(error).not.toContain("quarry");
  });

  it("keeps a failed first sync's error after a successful incremental sync", async () => {
    await seedStartedConnection(prisma, {
      backfillState: "failed",
      historyId: "5",
      lastSyncError: "gmail_unavailable: first sync failed",
    });
    await runIncrementalSync(ctxWith(new FakeGmailClient(FIVE)));
    expect((await connectionRow()).lastSyncError).toBe("gmail_unavailable: first sync failed");
  });

  it("does nothing before Start syncing or without a history id, and leaves the schedule alone", async () => {
    for (const over of [
      { startedAt: null, backfillState: "not_started" as const, historyId: "5" },
      { historyId: null },
    ]) {
      await resetDb(prisma);
      await seedConnection(prisma, over);
      const spy = new SpyClient(new FakeGmailClient(FIVE));
      const ctx = ctxWith(spy);
      await runIncrementalSync(ctx);
      expect(spy.historyCalls).toEqual([]);
      expect(ctx.queue.unscheduled).toEqual([]);
    }
  });

  it("stops the schedule when the connection is no longer active (another stage lost the authorization first)", async () => {
    for (const status of ["needs_reauth", "missing_scope", "disconnected"] as const) {
      await resetDb(prisma);
      await seedStartedConnection(prisma, { status, backfillState: "done", historyId: "5" });
      const spy = new SpyClient(new FakeGmailClient(FIVE));
      const ctx = ctxWith(spy);
      await runIncrementalSync(ctx);
      expect(spy.historyCalls, status).toEqual([]);
      expect(ctx.queue.unscheduled, status).toEqual(["gmail.sync"]);
      expect((await connectionRow()).status).toBe(status);
    }
    // A backfill job that finds the same does the same.
    await resetDb(prisma);
    await seedStartedConnection(prisma, { status: "needs_reauth" });
    const ctx = ctxWith(new FakeGmailClient(FIVE));
    await runBackfill(ctx);
    expect(ctx.queue.unscheduled).toEqual(["gmail.sync"]);
  });

  it("does not store a history id over one written meanwhile (compare-and-set)", async () => {
    await seedStartedConnection(prisma, { backfillState: "done", historyId: "5" });
    const fake = new FakeGmailClient(FIVE);
    fake.add(emailFixture("n1", "2026-10-01T09:00:00.000Z"));
    const spy = new SpyClient(fake);
    spy.beforeHistory = async () => {
      await prisma.gmailConnection.update({ where: { id: 1 }, data: { historyId: "900" } });
    };
    await runIncrementalSync(ctxWith(spy));
    const row = await connectionRow();
    expect(row.historyId).toBe("900");
    expect(row.lastSyncAt).toBeNull();
    expect(await messageIds()).toEqual(["n1"]); // the ids still went in; they are idempotent
  });

  it("a refresh token the client rotates mid-job does not stop the progress writes", async () => {
    const rotate = async (): Promise<void> => {
      await prisma.gmailConnection.update({
        where: { id: 1 },
        data: { refreshTokenEnc: "v1:rotated:rotated:rotated" },
      });
    };

    await seedStartedConnection(prisma, { backfillState: "running" });
    const backfill = new SpyClient(new FakeGmailClient(FIVE, { pageSize: 2 }));
    backfill.beforeList = async (n) => {
      if (n === 2) await rotate();
    };
    const ctx = ctxWith(backfill);
    await runBackfill(ctx);
    expect(backfill.listCalls).toHaveLength(3);
    expect((await connectionRow()).backfillState).toBe("done");
    expect(await prisma.gmailMessage.count()).toBe(5);
    expect(ctx.queue.sentNames).toEqual(["email.triage"]);

    await resetDb(prisma);
    await seedStartedConnection(prisma, { backfillState: "done", historyId: "5" });
    const fake = new FakeGmailClient(FIVE);
    fake.add(emailFixture("n1", "2026-10-01T09:00:00.000Z"));
    const sync = new SpyClient(fake);
    sync.beforeHistory = rotate;
    await runIncrementalSync(ctxWith(sync));
    const row = await connectionRow();
    expect(row.historyId).toBe("6");
    expect(row.lastSyncAt).not.toBeNull();
  });

  it("GmailHistoryExpiredError from a client is the only error that triggers a re-list", async () => {
    await seedStartedConnection(prisma, { backfillState: "done", historyId: "5" });
    const spy = new SpyClient(new FakeGmailClient(FIVE));
    spy.beforeHistory = () => {
      throw new GmailRetryableError(503);
    };
    await expect(runIncrementalSync(ctxWith(spy))).rejects.toBeInstanceOf(GmailRetryableError);
    expect(spy.listCalls).toEqual([]);
    expect(new GmailHistoryExpiredError()).toBeInstanceOf(Error);
  });
});

describe("getSyncStatus", () => {
  it("reports processed as the messages that have left discovered, capped at listed", async () => {
    await seedStartedConnection(prisma, { backfillListed: 3 });
    const base = { threadId: "t", internalDate: new Date(0), direction: "inbound" as const };
    await prisma.gmailMessage.createMany({
      data: [
        { ...base, id: "a", labelIds: [], state: "discovered" },
        { ...base, id: "b", labelIds: [], state: "skipped" },
        { ...base, id: "c", labelIds: [], state: "applied" },
        { ...base, id: "d", labelIds: [], state: "applied" },
        { ...base, id: "e", labelIds: [], state: "applied" },
      ],
    });
    const status = await getSyncStatus(prisma);
    expect(status.backfill).toEqual({ state: "running", listed: 3, processed: 3 });
    expect(status.queue.discovered).toBe(1);
  });
});
