import type { WorkerCtx } from "../deps.js";
import { runLeadCheck } from "./check.js";
import { runFinalize } from "./finalize.js";
import { runRankBatch } from "./rank.js";

/** What the worker hands a handler; the same shape as `JobInfo` in `jobs/handlers.ts`. */
type LeadJob = { data: Record<string, unknown> };

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
    if (leadId !== null) await runLeadCheck(ctx, leadId);
  },
  rank: async (ctx: WorkerCtx): Promise<void> => {
    await runRankBatch(ctx);
  },
  finalize: async (ctx: WorkerCtx, job: LeadJob): Promise<void> => {
    const batchId = idOf(job, "batchId");
    if (batchId !== null) await runFinalize(ctx, batchId);
  },
};
