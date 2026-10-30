import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { WorkerCtx } from "../deps.js";
import { GmailRequestError, GmailRetryableError, MAX_RETRY_AFTER_MS } from "../gmail/client.js";
import { markBackfillFailed, runBackfill, runIncrementalSync } from "../gmail/sync.js";
import { QUEUE_CONFIG, QUEUES, type QueueName } from "./queues.js";

/** What a handler knows about the job it is running. */
export type JobInfo = {
  data: Record<string, unknown>;
  /** How many times pg-boss has retried this job. */
  retryCount: number;
  retryLimit: number;
};

export type JobHandler = (ctx: WorkerCtx, job: JobInfo) => Promise<void>;

/** Deferrals a job chain has used so far (`Retry-After` waits, see `deferForRetryAfter`). */
function deferralsOf(job: JobInfo): number {
  const n = job.data.deferrals;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : 0;
}

/**
 * A cron tick, "Sync now" or a worker-start re-send: not a deferred retry and not a pg-boss
 * retry. While a retry is already waiting for its start time (a `Retry-After`, or pg-boss's own
 * backoff), these skip, so the wait is not undercut and chains do not pile up.
 */
async function shouldSkipWhileDelayed(
  ctx: WorkerCtx,
  name: QueueName,
  job: JobInfo,
): Promise<boolean> {
  if (deferralsOf(job) > 0 || job.retryCount > 0) return false;
  return ctx.queue.hasDelayed(name);
}

/**
 * Honours a `Retry-After` from Gmail (§13). pg-boss retries wait a fixed backoff and cannot be
 * told to wait longer, so the job ends normally and the same queue gets a new job that starts
 * after the requested wait (at most `MAX_RETRY_AFTER_MS`). A chain defers at most `retryLimit`
 * times; after that the error is thrown and pg-boss's own backoff and retry limit take over.
 * Only one deferred job waits per queue. Returns true when the work was deferred.
 */
async function deferForRetryAfter(
  ctx: WorkerCtx,
  name: QueueName,
  job: JobInfo,
  error: unknown,
): Promise<boolean> {
  if (!(error instanceof GmailRetryableError) || error.retryAfterMs === null) return false;
  const deferrals = deferralsOf(job);
  if (deferrals >= job.retryLimit) return false;
  // Another job is already waiting out a delay: it covers this one.
  if (await ctx.queue.hasDelayed(name)) return true;
  const waitMs = Math.min(Math.max(error.retryAfterMs, 1_000), MAX_RETRY_AFTER_MS);
  await ctx.queue.send(
    name,
    { ...job.data, deferrals: deferrals + 1 },
    { startAfterSeconds: Math.ceil(waitMs / 1000) },
  );
  ctx.log.warn({ queue: name, waitSeconds: Math.ceil(waitMs / 1000) }, "gmail asked to wait");
  return true;
}

const gmailSync: JobHandler = async (ctx, job) => {
  if (await shouldSkipWhileDelayed(ctx, QUEUES.gmailSync, job)) return;
  try {
    await runIncrementalSync(ctx);
  } catch (error) {
    if (await deferForRetryAfter(ctx, QUEUES.gmailSync, job, error)) return;
    throw error;
  }
};

const gmailBackfill: JobHandler = async (ctx, job) => {
  if (await shouldSkipWhileDelayed(ctx, QUEUES.gmailBackfill, job)) return;
  try {
    await runBackfill(ctx);
  } catch (error) {
    if (await deferForRetryAfter(ctx, QUEUES.gmailBackfill, job, error)) return;
    // A request Gmail refuses will not succeed later; otherwise this was the last attempt.
    if (error instanceof GmailRequestError || job.retryCount >= job.retryLimit) {
      await markBackfillFailed(ctx);
    }
    throw error;
  }
};

/**
 * The handlers registered so far, by queue. Later tasks add theirs here (triage, extract, apply,
 * leads, timers, maintenance). A queue without a handler is created but not consumed.
 */
export const HANDLERS: Partial<Record<QueueName, JobHandler>> = {
  [QUEUES.gmailSync]: gmailSync,
  [QUEUES.gmailBackfill]: gmailBackfill,
};

/**
 * Starts a pg-boss worker for every queue that has a handler, with the concurrency from
 * `QUEUE_CONFIG` (§9). Jobs are handled one at a time per worker; a thrown error makes pg-boss
 * retry with the queue's backoff.
 */
export async function registerHandlers(boss: PgBoss, ctx: WorkerCtx): Promise<void> {
  for (const [name, handler] of Object.entries(HANDLERS) as [QueueName, JobHandler][]) {
    await boss.work(
      name,
      { includeMetadata: true, localConcurrency: QUEUE_CONFIG[name].concurrency },
      async (jobs: JobWithMetadata<Record<string, unknown>>[]) => {
        for (const job of jobs) {
          await handler(ctx, {
            data: job.data ?? {},
            retryCount: job.retryCount,
            retryLimit: job.retryLimit,
          });
        }
      },
    );
  }
}
