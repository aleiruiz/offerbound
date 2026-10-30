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
import { applyEligibleMessages } from "../pipeline/apply.js";
import { runExtract } from "../pipeline/extract.js";
import { gmailAuthIsLost, markExtractionFailed } from "../pipeline/failure.js";
import {
  resendPendingExtractions,
  runTriageBatch,
  TRIAGE_BATCH_SIZE,
  type TriageBatchResult,
} from "../pipeline/triage.js";
import { sendPendingChecks } from "../leads/intake.js";
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
 * `email.triage`, from the 1-minute sweep and after sync inserts. The sweep also sends
 * `leads.check` for leads whose first send was lost (`sendPendingChecks`). Messages already `job_related`
 * are sent to extraction again first (a send lost after a commit is not repeated by a retry). A
 * full batch is followed by the next one at once, in the same run (see `continueTriage`), so a
 * large backfill does not wait a minute per 25 messages. Gmail's `Retry-After` defers the job instead of failing it. While the connection is
 * already lost the job does nothing, so the 1-minute sweep neither calls Gmail nor logs the
 * lost authorization again (`gmail.sync` stops its own schedule); an authorization lost during
 * the job ends it and stops the sync schedule.
 */
/**
 * Whether another triage batch should run at once instead of at the next 1-minute sweep:
 * - the batch was full;
 * - it read messages for the first time and more work follows: messages still unread, or outgoing
 *   messages waiting on older ones, which the next batch can decide once those have been read;
 * - it decided waiting outgoing messages and others still wait.
 * Never when a model call failed: that is an outage, and running again at once would spend the
 * messages' failed attempts back to back. Each message then gets one attempt per sweep, as before.
 * A batch whose only work was looking at waiting rows that are still blocked reads nothing and
 * decides nothing, so it never continues either: the stage cannot spin.
 */
function continueTriage(batch: TriageBatchResult): boolean {
  if (batch.modelFailed > 0) return false;
  return (
    batch.processed >= TRIAGE_BATCH_SIZE ||
    (batch.read > 0 && (batch.unread > 0 || batch.waiting > 0)) ||
    (batch.released > 0 && batch.waiting > 0)
  );
}

/**
 * One `email.triage` run works through batches until none is called for, up to this many batches
 * or this long. Each batch the job would otherwise ask for is a separate pg-boss job, and a job
 * waits for the queue's next poll, so a first sync of thousands of messages would spend most of
 * its time waiting. The bound keeps one run well inside the queue's job expiry; if work remains
 * the run asks for another job.
 */
export const MAX_TRIAGE_BATCHES_PER_RUN = 20;
const MAX_TRIAGE_RUN_MS = 50_000;

const emailTriage: JobHandler = async (ctx, job) => {
  // The one 1-minute sweep that runs in every mode: it also sends `leads.check` for leads whose
  // first send was lost. A failure here must not hold up triage.
  try {
    await sendPendingChecks(ctx);
  } catch (error) {
    ctx.log.error(
      { errorName: error instanceof Error ? error.name : undefined },
      "pending lead checks sweep failed",
    );
  }
  if (await shouldSkipWhileDelayed(ctx, QUEUES.emailTriage, job)) return;
  if (await gmailAuthIsLost(ctx.prisma)) return;
  try {
    await resendPendingExtractions(ctx);
    const started = Date.now();
    let more = false;
    for (let batches = 0; batches < MAX_TRIAGE_BATCHES_PER_RUN; batches += 1) {
      const batch = await runTriageBatch(ctx);
      // A waiting outgoing message was decided: the messages after it can be applied now, and the
      // next waiting one may be decidable once they are.
      if (batch.released > 0 && batch.waiting > 0) await applyEligibleMessages(ctx);
      more = continueTriage(batch);
      if (!more || Date.now() - started >= MAX_TRIAGE_RUN_MS) break;
    }
    if (more) await ctx.queue.send(QUEUES.emailTriage);
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

/*
 * Writes outside the intake lock. §6.8 puts every system write that changes records under the
 * lock; these three touch only a message's retry bookkeeping (`processed_at`, `attempts`), never
 * an application, lead, company, interview or event, and each is a single guarded `updateMany`
 * (`where state = 'job_related'`), so they cannot race a stage that moves the message on:
 *   - the extract heartbeat, which stamps `processed_at` at the start of every attempt;
 *   - `onDeferred`, which moves `processed_at` to the deferred job's due time;
 *   - the resend counter in `resendPendingExtractions` (triage.ts), which increments `attempts`
 *     before each send and gives it back when the send fails.
 * Taking the lock for them would make every extraction attempt queue behind a long import or
 * search finalize just to write a timestamp.
 */

/**
 * `email.extract`, one job per `job_related` message (key = message id). Each attempt stamps
 * `processed_at` as a heartbeat for triage's resend sweep. Gmail's `Retry-After` defers the job
 * and moves that stamp to the deferred job's due time.
 *
 * Lost authorization ends the job and stops the sync schedule, like triage: the first job to meet
 * it does, and jobs that find the connection already unusable end at once. Any other error goes
 * to pg-boss for its backoff. When the last retry has failed the message is marked `failed` with
 * an *Extraction failed* review item: triage's resend sweep re-sends every `job_related` message,
 * so a message left in that state would be retried for ever.
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
      // leaves the row alone until 10 minutes later). The resend count stays, so a message that
      // also meets a Retry-After in some cycle still reaches the cap.
      onDeferred: async (dueAt) => {
        await ctx.prisma.gmailMessage.updateMany({
          where: { id: messageId, state: "job_related" },
          data: { processedAt: dueAt },
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
 * `email.apply`, from each finished extraction and the 1-minute sweep. The queue is a singleton
 * and the job carries no key, so a run that finds the queue busy is dropped: every run drains
 * all eligible messages, oldest first, instead of applying one (TECHNICAL_SPEC §5.6).
 */
const emailApply: JobHandler = async (ctx) => {
  await applyEligibleMessages(ctx);
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
  [QUEUES.emailApply]: emailApply,
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
