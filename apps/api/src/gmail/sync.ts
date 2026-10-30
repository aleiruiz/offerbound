import type { Prisma, PrismaClient } from "@prisma/client";
import type { SyncStatus } from "@offerbound/contracts";
import type { WorkerCtx } from "../deps.js";
import { QUEUES, type JobQueue } from "../jobs/queues.js";
import {
  GmailAuthError,
  GmailHistoryExpiredError,
  GmailRequestError,
  GmailRetryableError,
  type GmailClient,
} from "./client.js";

/**
 * Backfill and incremental sync (TECHNICAL_SPEC §5.2). Both only list ids and insert them as
 * `discovered`; triage fetches the metadata. Every step is safe to repeat: inserts ignore ids
 * that exist, progress is saved per page, and every write to `gmail_connection` is conditional
 * on the row still being the one the job started from, so a job that outlives a Disconnect or a
 * reconnect cannot overwrite newer state. Nothing here logs ids, subjects or addresses.
 */

type Db = PrismaClient | Prisma.TransactionClient;
type Ref = { id: string; threadId: string };

/**
 * A listed message has no date, direction or labels yet (triage reads them from the metadata).
 * Until then its date is the epoch, which keeps it ahead of every real date: the apply watermark
 * (the oldest message still `discovered`, §5.6) and the timers gate (§6.7) wait for it.
 */
const UNKNOWN_DATE = new Date(0);
const DAY_MS = 86_400_000;
const QUERY_SUFFIX = "-in:spam -in:trash -in:drafts";

/** `YYYY/MM/DD` in UTC, the form Gmail's `after:` takes. */
function gmailDay(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}/${m}/${d}`;
}

/** The list query for everything dated after `since` minus one day (the day is a safety margin). */
export function gmailListQuery(since: Date): string {
  return `after:${gmailDay(new Date(since.getTime() - DAY_MS))} ${QUERY_SUFFIX}`;
}

/** Cron for the sync schedule: every `minutes` minutes, or every whole number of hours past 59. */
export function syncCron(minutes: number): string {
  if (minutes < 60) return `*/${Math.max(1, Math.floor(minutes))} * * * *`;
  return `0 */${Math.min(24, Math.floor(minutes / 60))} * * *`;
}

export async function scheduleGmailSync(
  queue: JobQueue,
  minutes: number,
  tz: string,
): Promise<void> {
  await queue.schedule(QUEUES.gmailSync, syncCron(minutes), { tz });
}

// ---------------------------------------------------------------------------------------------
// Status (AC-2.5)
// ---------------------------------------------------------------------------------------------

export async function getSyncStatus(db: Db): Promise<SyncStatus> {
  const [row, groups] = await Promise.all([
    db.gmailConnection.findUnique({ where: { id: 1 } }),
    db.gmailMessage.groupBy({ by: ["state"], _count: { _all: true } }),
  ]);
  const count = (state: string): number => groups.find((g) => g.state === state)?._count._all ?? 0;
  const left = count("discovered");
  const total = groups.reduce((sum, g) => sum + g._count._all, 0);
  const listed = row?.backfillListed ?? 0;
  return {
    connection: row?.status ?? "not_connected",
    started: row?.startedAt != null,
    lastSyncAt: row?.lastSyncAt?.toISOString() ?? null,
    lastError: row?.lastSyncError ?? null,
    backfill: {
      state: row?.backfillState ?? "not_started",
      listed,
      // Messages that have left `discovered`; never more than were listed by the backfill.
      processed: Math.min(total - left, listed),
    },
    queue: {
      discovered: left,
      jobRelated: count("job_related"),
      extracted: count("extracted"),
      needsReview: count("needs_review"),
      failed: count("failed"),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------------------------

type Connection = NonNullable<Awaited<ReturnType<PrismaClient["gmailConnection"]["findUnique"]>>>;

/**
 * Matches the row only while it is still the same active connection (same Google account) the job
 * started from. The refresh token is deliberately not part of it: the client may rotate it
 * mid-job, and that must not stop the job's progress writes.
 */
function sameRow(conn: Connection) {
  return { id: 1, status: "active", googleSub: conn.googleSub } as const;
}

/** Also the same refresh token: used for writes that mark the authorization as lost. */
function sameToken(conn: Connection) {
  return { ...sameRow(conn), refreshTokenEnc: conn.refreshTokenEnc } as const;
}

/**
 * A job found the connection unusable (lost authorization, or disconnected): stop the schedule,
 * so `gmail.sync` stops running (§5.2 step 4). Another stage's client may have marked it first.
 */
async function stopScheduleIfUnusable(queue: JobQueue, conn: Connection | null): Promise<void> {
  if (conn && conn.status !== "active") await queue.unschedule(QUEUES.gmailSync);
}

/** Inserts ids as `discovered`, ignoring ids already stored. Returns how many were new. */
async function insertDiscovered(db: Db, refs: Ref[]): Promise<number> {
  if (refs.length === 0) return 0;
  const { count } = await db.gmailMessage.createMany({
    data: refs.map((ref) => ({
      id: ref.id,
      threadId: ref.threadId,
      internalDate: UNKNOWN_DATE,
      direction: "inbound" as const,
      labelIds: [],
    })),
    skipDuplicates: true,
  });
  return count;
}

/** Lists every page of a query, inserting each page as it arrives. Returns how many ids were new. */
async function listAndInsert(client: GmailClient, db: Db, q: string): Promise<number> {
  let inserted = 0;
  let token: string | null = null;
  do {
    const page = await client.listMessages(q, token);
    inserted += await insertDiscovered(db, page.ids);
    token = page.nextPageToken;
  } while (token !== null);
  return inserted;
}

const AUTH_TEXT = {
  invalid_grant: "invalid_grant: Google rejected the stored authorization.",
  missing_scope: "missing_scope: Gmail access was not granted.",
} as const;

/** A short, content-free description for `last_sync_error` (an error code and a few words). */
function describeFailure(error: unknown): string {
  if (error instanceof GmailRetryableError) {
    const http = error.status === null ? "" : ` (HTTP ${error.status})`;
    return `gmail_unavailable: Gmail is temporarily unavailable${http}. Offerbound will try again.`;
  }
  if (error instanceof GmailRequestError) {
    const http = error.status === null ? "" : ` (HTTP ${error.status})`;
    return `gmail_request_failed: Gmail refused the request${http}.`;
  }
  return "sync_failed: The sync failed unexpectedly.";
}

/**
 * What a job does with a failure. Lost authorization stops syncing until the owner reconnects
 * (AC-2.6, §13) and the job ends normally, since a retry cannot help. Anything else is recorded
 * in `last_sync_error` and rethrown so pg-boss retries with backoff (§5.2 step 5).
 */
async function handleFailure(ctx: WorkerCtx, conn: Connection, error: unknown): Promise<void> {
  const { prisma, queue, log } = ctx;
  if (error instanceof GmailAuthError) {
    if (error.reason !== "not_connected") {
      const status = error.reason === "missing_scope" ? "missing_scope" : "needs_reauth";
      await prisma.gmailConnection.updateMany({
        where: sameToken(conn),
        data: { status, lastSyncError: AUTH_TEXT[error.reason] },
      });
    }
    // Stop the schedule unless the row has since been reconnected (a stale job).
    const now = await prisma.gmailConnection.findUnique({
      where: { id: 1 },
      select: { status: true },
    });
    if (now?.status !== "active") await queue.unschedule(QUEUES.gmailSync);
    log.warn({ reason: error.reason }, "gmail authorization lost; sync stopped");
    return;
  }
  await prisma.gmailConnection.updateMany({
    where: sameRow(conn),
    data: { lastSyncError: describeFailure(error) },
  });
  throw error;
}

// ---------------------------------------------------------------------------------------------
// Backfill (AC-2.3)
// ---------------------------------------------------------------------------------------------

/**
 * `gmail.backfill`: lists every message dated on or after the backfill start (minus a day),
 * a page at a time. It stores the mailbox `historyId` first (the incremental sync's starting
 * point, so nothing between the listing and the first incremental sync is missed), then saves
 * the page token with each page so a restart resumes where it stopped. Does nothing unless the
 * backfill is `running` on an active connection.
 */
export async function runBackfill(ctx: WorkerCtx): Promise<void> {
  const { prisma, queue } = ctx;
  const conn = await prisma.gmailConnection.findUnique({ where: { id: 1 } });
  if (!conn || conn.status !== "active") return stopScheduleIfUnusable(queue, conn);
  if (conn.backfillState !== "running") return;

  try {
    const client = await ctx.gmail();

    if (conn.historyId === null) {
      const profile = await client.getProfile();
      await prisma.gmailConnection.updateMany({
        where: { ...sameRow(conn), historyId: null },
        data: { historyId: profile.historyId },
      });
    }

    const q = gmailListQuery(conn.backfillSince);
    let token = conn.backfillPageToken;
    do {
      const page = await client.listMessages(q, token);
      token = page.nextPageToken;
      // Ids and progress commit together, so a restart never counts a page twice.
      const saved = await prisma.$transaction(async (tx) => {
        const { count } = await tx.gmailConnection.updateMany({
          where: { ...sameRow(conn), backfillState: "running" },
          data: { backfillPageToken: token, backfillListed: { increment: page.ids.length } },
        });
        if (count === 0) return false;
        await insertDiscovered(tx, page.ids);
        return true;
      });
      // Disconnected or reconnected meanwhile: the newer state owns what is left.
      if (!saved) return;
    } while (token !== null);

    const { count } = await prisma.gmailConnection.updateMany({
      where: { ...sameRow(conn), backfillState: "running" },
      data: {
        backfillState: "done",
        backfillPageToken: null,
        lastSyncAt: ctx.clock(),
        lastSyncError: null,
      },
    });
    if (count > 0) await queue.send(QUEUES.emailTriage);
  } catch (error) {
    await handleFailure(ctx, conn, error);
  }
}

/** The retries are used up (or the failure is final): the owner sees a failed first sync. */
export async function markBackfillFailed(ctx: WorkerCtx): Promise<void> {
  await ctx.prisma.gmailConnection.updateMany({
    where: { id: 1, status: "active", backfillState: "running" },
    data: { backfillState: "failed" },
  });
}

// ---------------------------------------------------------------------------------------------
// Incremental sync (AC-2.4, AC-2.7)
// ---------------------------------------------------------------------------------------------

/** The larger of two numeric history ids (they are decimal strings). */
function newerHistoryId(a: string, b: string): string {
  try {
    return BigInt(b) > BigInt(a) ? b : a;
  } catch {
    return b;
  }
}

/**
 * `gmail.sync`: adds the messages that arrived since the stored `historyId`. The new `historyId`
 * and `last_sync_at` are stored only after every insert has committed. When Gmail no longer has
 * the stored history point, the mailbox is re-listed from the newest processed message minus a
 * day instead (duplicates are ignored). Does nothing before *Start syncing* or without an active
 * connection.
 */
export async function runIncrementalSync(ctx: WorkerCtx): Promise<void> {
  const { prisma, queue } = ctx;
  const conn = await prisma.gmailConnection.findUnique({ where: { id: 1 } });
  if (!conn || conn.status !== "active") return stopScheduleIfUnusable(queue, conn);
  if (conn.startedAt === null || conn.backfillState === "not_started" || conn.historyId === null) {
    return;
  }
  const start = conn.historyId;

  try {
    const client = await ctx.gmail();
    let inserted = 0;
    let latest = start;
    try {
      let token: string | null = null;
      do {
        const page = await client.listHistory(start, token);
        inserted += await insertDiscovered(prisma, page.added);
        latest = newerHistoryId(latest, page.historyId);
        token = page.nextPageToken;
      } while (token !== null);
    } catch (error) {
      if (!(error instanceof GmailHistoryExpiredError)) throw error;
      // The profile's history id is read before listing, so nothing after it is missed; it is
      // stored once the listing has committed, so a failed listing is retried the same way.
      latest = (await client.getProfile()).historyId;
      const newest = await prisma.gmailMessage.aggregate({
        _max: { internalDate: true },
        where: { state: { not: "discovered" } },
      });
      const since = newest._max.internalDate ?? conn.backfillSince;
      inserted = await listAndInsert(client, prisma, gmailListQuery(since));
    }

    await prisma.gmailConnection.updateMany({
      where: { ...sameRow(conn), historyId: start },
      data: {
        historyId: latest,
        lastSyncAt: ctx.clock(),
        // A failed first sync keeps its message until it is restarted.
        ...(conn.backfillState === "failed" ? {} : { lastSyncError: null }),
      },
    });
    if (inserted > 0) await queue.send(QUEUES.emailTriage);
  } catch (error) {
    await handleFailure(ctx, conn, error);
  }
}
