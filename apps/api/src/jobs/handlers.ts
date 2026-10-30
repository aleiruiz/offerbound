import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { WorkerCtx } from "../deps.js";
import {
  GmailAuthError,
  GmailRequestError,
  GmailRetryableError,
  MAX_RETRY_AFTER_MS,
} from "../gmail/client.js";
import { LlmError } from "../llm/provider.js";
import {
  markBackfillFailed,
  runBackfill,
  runIncrementalSync,
  stopSyncAfterAuthError,
} from "../gmail/sync.js";
import { runExtract } from "../pipeline/extract.js";
import { gmailAuthIsLost, markExtractionFailed } from "../pipeline/failure.js";
import { resendPendingExtractions, runTriageBatch, TRIAGE_BATCH_SIZE } from "../pipeline/triage.js";
import { leadJobHandlers } from "../leads/jobs.js";
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
 * Returns true when the work was deferred.
 *
 * Queues whose jobs are about the whole mailbox keep only one deferred job waiting. A queue of
 * per-message jobs passes its `singletonKey` (the message id) instead: each message defers its
 * own job, and the key keeps a resend from queueing a second one behind it. It may also pass
 * `onDeferred`, called with the time the deferred job is due, to record the wait.
 */
async function deferForRetryAfter(
  ctx: WorkerCtx,
  name: QueueName,
  job: JobInfo,
  error: unknown,
  opts: { singletonKey?: string; onDeferred?: (dueAt: Date) => Promise<void> } = {},
): Promise<boolean> {
  const { singletonKey, onDeferred } = opts;
  if (!(error instanceof GmailRetryableError) || error.retryAfterMs === null) return false;
  const deferrals = deferralsOf(job);
  if (deferrals >= job.retryLimit) return false;
  // Another job is already waiting out a delay: it covers this one.
  if (singletonKey === undefined && (await ctx.queue.hasDelayed(name))) return true;
  const waitMs = Math.min(Math.max(error.retryAfterMs, 1_000), MAX_RETRY_AFTER_MS);
  const waitSeconds = Math.ceil(waitMs / 1000);
  await ctx.queue.send(
    name,
    { ...job.data, deferrals: deferrals + 1 },
    {
      startAfterSeconds: waitSeconds,
      ...(singletonKey === undefined ? {} : { singletonKey }),
    },
  );
  ctx.log.warn({ queue: name, waitSeconds }, "gmail asked to wait");
  await onDeferred?.(new Date(ctx.clock().getTime() + waitSeconds * 1000));
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
 * `email.triage`, from the 1-minute sweep and after sync inserts. Messages already `job_related`
 * are sent to extraction again first (a send lost after a commit is not repeated by a retry). A
 * full batch sends the next one at once, so a large backfill does not wait a minute per 25
 * messages. Gmail's `Retry-After` defers the job instead of failing it; lost authorization ends
 * the job and stops the sync schedule.
 */
const emailTriage: JobHandler = async (ctx, job) => {
  if (await shouldSkipWhileDelayed(ctx, QUEUES.emailTriage, job)) return;
  try {
    await resendPendingExtractions(ctx);
    const { processed } = await runTriageBatch(ctx);
    if (processed >= TRIAGE_BATCH_SIZE) await ctx.queue.send(QUEUES.emailTriage);
  } catch (error) {
    if (await deferForRetryAfter(ctx, QUEUES.emailTriage, job, error)) return;
    if (error instanceof GmailAuthError) {
      await stopSyncAfterAuthError(ctx, error);
      return;
    }
    throw error;
  }
};

/** A short, content-free code for `last_error` when the retries of a job run out. */
function exhaustedCode(error: unknown): string {
  if (error instanceof LlmError) return `llm_${error.code}`;
  if (error instanceof GmailRetryableError) return "gmail_unavailable";
  return "extract_error";
}

/**
 * `email.extract`, one job per `job_related` message (key = message id). Each attempt stamps
 * `processed_at` as a heartbeat for triage's resend sweep. Gmail's `Retry-After` defers the job
 * (and moves that stamp to the deferred job's due time); lost authorization ends it and stops the sync schedule, like triage (the first
 * job to meet it does; jobs that find the connection already unusable end at once). Any other
 * error goes to pg-boss for its backoff, and when the last retry has failed the message is marked
 * `failed` with an *Extraction failed* review item: triage's resend sweep re-sends every
 * `job_related` message, so a message left in that state would be retried for ever.
 */
const emailExtract: JobHandler = async (ctx, job) => {
  const messageId = job.data.messageId;
  if (typeof messageId !== "string" || messageId === "") {
    ctx.log.warn("email.extract job without a message id");
    return;
  }
  // Authorization already lost and handled: leave the message for after the owner reconnects,
  // instead of every queued job failing and unscheduling again.
  if (await gmailAuthIsLost(ctx.prisma)) return;
  // A heartbeat: while the job chain is alive (running, backing off, deferred) the resend sweep
  // must not start a second chain beside it. `attempts` is left alone: it counts resends, and a
  // job that crashes every time must still reach the cap.
  await ctx.prisma.gmailMessage.updateMany({
    where: { id: messageId, state: "job_related" },
    data: { processedAt: ctx.clock() },
  });
  try {
    await runExtract(ctx, messageId);
  } catch (error) {
    const deferred = await deferForRetryAfter(ctx, QUEUES.emailExtract, job, error, {
      singletonKey: messageId,
      // The job is waiting on purpose, not lost: move the resend wait to when it is due (the sweep
      // leaves the row alone until 10 minutes later) and forget the resends counted so far.
      onDeferred: async (dueAt) => {
        await ctx.prisma.gmailMessage.updateMany({
          where: { id: messageId, state: "job_related" },
          data: { processedAt: dueAt, attempts: 0 },
        });
      },
    });
    if (deferred) return;
    if (error instanceof GmailAuthError) {
      await stopSyncAfterAuthError(ctx, error);
      return;
    }
    if (job.retryCount >= job.retryLimit) {
      try {
        await markExtractionFailed(ctx, messageId, exhaustedCode(error));
      } catch (markError) {
        ctx.log.error(
          { errorName: markError instanceof Error ? markError.name : "unknown" },
          "could not mark an extraction failed",
        );
      }
    }
    throw error;
  }
};

/**
 * The handlers registered so far, by queue. Later tasks add theirs here (apply, leads,
 * timers, maintenance). A queue without a handler is created but not consumed.
 */
export const HANDLERS: Partial<Record<QueueName, JobHandler>> = {
  [QUEUES.gmailSync]: gmailSync,
  [QUEUES.gmailBackfill]: gmailBackfill,
  [QUEUES.emailTriage]: emailTriage,
  [QUEUES.emailExtract]: emailExtract,
  [QUEUES.leadsCheck]: leadJobHandlers.check,
  [QUEUES.leadsRank]: leadJobHandlers.rank,
  [QUEUES.leadsFinalize]: leadJobHandlers.finalize,
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
