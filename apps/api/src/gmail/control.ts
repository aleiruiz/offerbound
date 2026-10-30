import type { SyncStatus } from "@offerbound/contracts";
import { decryptToken } from "../auth/crypto.js";
import type { AppDeps } from "../deps.js";
import { ApiError } from "../http/errors.js";
import { QUEUES } from "../jobs/queues.js";
import { getSyncStatus, scheduleGmailSync } from "./sync.js";

/**
 * What the owner's buttons do to the Gmail connection and its jobs (AC-2.3, 2.4, 2.6, 2.8).
 * State changes are single conditional updates, so two clicks or a click racing a job cannot
 * leave the row half changed.
 */

type Deps = Pick<AppDeps, "env" | "prisma" | "clock" | "queue">;

/** Longest the disconnect waits for Google to confirm a revoke. */
const REVOKE_TIMEOUT_MS = 3_000;

/**
 * *Start syncing*: records the start, begins the backfill and schedules the incremental sync.
 * `409 not_connected` without an active connection, `409 already_running` if it was started.
 */
export async function startSyncing(deps: Deps): Promise<SyncStatus> {
  const { env, prisma, queue } = deps;
  const startedAt = deps.clock();
  const { count } = await prisma.gmailConnection.updateMany({
    where: { id: 1, status: "active", startedAt: null },
    data: {
      startedAt,
      backfillState: "running",
      backfillSince: new Date(env.gmailBackfillSince),
      backfillPageToken: null,
      backfillListed: 0,
      lastSyncError: null,
    },
  });
  if (count === 0) {
    const row = await prisma.gmailConnection.findUnique({
      where: { id: 1 },
      select: { status: true },
    });
    if (row?.status === "active") {
      throw new ApiError(409, "already_running", "Syncing has already started.");
    }
    throw new ApiError(409, "not_connected", "Gmail is not connected.");
  }

  try {
    await queue.send(QUEUES.gmailBackfill);
    await scheduleGmailSync(queue, env.gmailSyncIntervalMinutes, env.userTimezone);
  } catch (error) {
    // Leave the owner able to press the button again rather than stuck on "already started".
    await prisma.gmailConnection.updateMany({
      where: { id: 1, startedAt },
      data: { startedAt: null, backfillState: "not_started" },
    });
    throw error;
  }
  return getSyncStatus(prisma);
}

/**
 * *Sync now*: sends a sync. A first sync that failed is restarted too (it resumes from its saved
 * page), since the incremental sync cannot fill in what the backfill did not list.
 */
export async function syncNow(deps: Deps): Promise<void> {
  const { prisma, queue } = deps;
  const row = await prisma.gmailConnection.findUnique({ where: { id: 1 } });
  if (!row || row.status !== "active") {
    throw new ApiError(409, "not_connected", "Gmail is not connected.");
  }
  if (row.startedAt === null) {
    throw new ApiError(409, "not_connected", "Syncing has not been started.");
  }
  const { count } = await prisma.gmailConnection.updateMany({
    where: { id: 1, status: "active", backfillState: "failed" },
    data: { backfillState: "running" },
  });
  if (count > 0) await queue.send(QUEUES.gmailBackfill);
  await queue.send(QUEUES.gmailSync);
}

/**
 * *Disconnect Gmail*: revokes the grant at Google, deletes the stored tokens and stops the
 * schedule. Messages and records stay. Revoking is best effort (a grant that is already invalid
 * cannot be revoked, and the owner can also remove it in their Google account); the tokens are
 * deleted either way.
 */
export async function disconnectGmail(deps: Deps & Pick<AppDeps, "google">): Promise<void> {
  const { env, prisma, queue, google } = deps;
  const row = await prisma.gmailConnection.findUnique({ where: { id: 1 } });
  if (!row) throw new ApiError(409, "not_connected", "Gmail is not connected.");

  const key = env.tokenEncryptionKey;
  if (row.refreshTokenEnc !== null && key) {
    let timer: NodeJS.Timeout | undefined;
    try {
      const token = decryptToken(row.refreshTokenEnc, key);
      await Promise.race([
        google.revoke(token),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, REVOKE_TIMEOUT_MS);
        }),
      ]);
    } catch {
      // Ignored on purpose; see above.
    } finally {
      clearTimeout(timer);
    }
  }

  await prisma.gmailConnection.updateMany({
    where: { id: 1 },
    data: {
      status: "disconnected",
      refreshTokenEnc: null,
      accessTokenEnc: null,
      accessTokenExpiresAt: null,
    },
  });
  await queue.unschedule(QUEUES.gmailSync);
}

/**
 * After the owner signs in again, or when the worker starts: if syncing was started and the
 * connection is usable, make sure the schedule exists and a running backfill continues. The
 * stored `historyId` is kept, so syncing resumes from the last synced point (AC-2.6).
 */
export async function resumeGmailJobs(deps: Deps): Promise<void> {
  const { env, prisma, queue } = deps;
  const row = await prisma.gmailConnection.findUnique({ where: { id: 1 } });
  if (!row || row.status !== "active" || row.startedAt === null) return;
  await scheduleGmailSync(queue, env.gmailSyncIntervalMinutes, env.userTimezone);
  if (row.backfillState === "running") await queue.send(QUEUES.gmailBackfill);
}
