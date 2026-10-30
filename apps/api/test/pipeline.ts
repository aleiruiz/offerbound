import type { WorkerCtx } from "../src/deps.js";
import { runBackfill } from "../src/gmail/sync.js";
import { QUEUES, type QueueName } from "../src/jobs/queues.js";
import { leadJobHandlers } from "../src/leads/jobs.js";
import { applyEligibleMessages } from "../src/pipeline/apply.js";
import { runExtract } from "../src/pipeline/extract.js";
import { runTriageBatch } from "../src/pipeline/triage.js";
import type { RecordingQueue } from "./queue.js";

/** Safety net: a pipeline that never settles fails the test instead of hanging it. */
const MAX_ROUNDS = 200;

/** The lead jobs `drainPipeline` runs from the recording queue, by queue. */
const LEAD_QUEUES: Partial<Record<QueueName, keyof typeof leadJobHandlers>> = {
  [QUEUES.leadsCheck]: "check",
  [QUEUES.leadsRank]: "rank",
  [QUEUES.leadsFinalize]: "finalize",
};

/**
 * Runs the whole email pipeline against the context's Gmail client and model until nothing changes
 * (TECHNICAL_SPEC §15). It runs the backfill (a no-op once that has finished), then repeats one
 * round of: triage one batch, extract every `job_related` message, apply every eligible message,
 * and run the lead jobs (`leads.check`, `leads.rank`, `leads.finalize`) the stages sent to the
 * context's `RecordingQueue`, until a round does no work.
 *
 * The caller seeds the Gmail connection (started, backfill `running`) and injects `fetchLink`.
 * Running it again on a settled database does nothing.
 */
export async function drainPipeline(ctx: WorkerCtx): Promise<void> {
  const queue = ctx.queue as RecordingQueue;
  await runBackfill(ctx);

  let nextJob = 0;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    let worked = false;

    const triaged = await runTriageBatch(ctx);
    if (triaged.processed > 0) worked = true;

    const pending = await ctx.prisma.gmailMessage.findMany({
      where: { state: "job_related" },
      orderBy: [{ internalDate: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    for (const { id } of pending) await runExtract(ctx, id);
    if (pending.length > 0) worked = true;

    const applied = await applyEligibleMessages(ctx);
    if (applied.applied > 0) worked = true;

    // The lead jobs are sent as the stages and jobs run, so keep going until the queue is read.
    while (nextJob < queue.sent.length) {
      const job = queue.sent[nextJob++]!;
      const handler = LEAD_QUEUES[job.name];
      if (handler === undefined) continue;
      await leadJobHandlers[handler](ctx, { data: job.data, retryCount: 0, retryLimit: 3 });
      worked = true;
    }

    if (!worked) return;
  }
  throw new Error(`The pipeline did not settle within ${MAX_ROUNDS} rounds.`);
}
