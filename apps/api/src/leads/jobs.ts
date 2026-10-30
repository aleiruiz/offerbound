import type { WorkerCtx } from "../deps.js";
import { runLeadCheck } from "./check.js";
import { runFinalize } from "./finalize.js";
import { runRankBatch } from "./rank.js";

/** What the worker hands a handler; the same shape as `JobInfo` in `jobs/handlers.ts`. */
type LeadJob = { data: Record<string, unknown>; retryCount?: number; retryLimit?: number };

function idOf(job: LeadJob, key: string): string | null {
  const value = job.data[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The handlers for `leads.check`, `leads.rank` and `leads.finalize`. A job without its id has
 * nothing to do and ends quietly. `jobs/handlers.ts` registers them.
 */
export const leadJobHandlers = {
  check: async (ctx: WorkerCtx, job: LeadJob): Promise<void> => {
    const leadId = idOf(job, "leadId");
    if (leadId !== null) await runLeadCheck(ctx, leadId, idOf(job, "batchId") ?? undefined);
  },
  rank: async (ctx: WorkerCtx, job: LeadJob): Promise<void> => {
    // On the last attempt, leads the model cannot rank move on unranked instead of waiting.
    const lastAttempt = (job.retryCount ?? 0) >= (job.retryLimit ?? Infinity);
    await runRankBatch(ctx, { lastAttempt });
  },
  finalize: async (ctx: WorkerCtx, job: LeadJob): Promise<void> => {
    const batchId = idOf(job, "batchId");
    if (batchId !== null) await runFinalize(ctx, batchId);
  },
};
