import { finalizeBatch, type BatchLead } from "@offerbound/domain";
import type { WorkerCtx } from "../deps.js";
import { withIntakeLock } from "../db/lock.js";
import { BATCHES_WITHOUT_FINALIZE, bumpBatchCounts } from "./intake.js";

/**
 * `leads.finalize` (TECHNICAL_SPEC §7.1): once no lead of the batch is still `checking` or
 * `ranking`, keep the best `new` lead of each company (highest fit, then newest `posted_at`, then
 * first returned) and suppress the others as `same_company_in_batch`. Sheet and manual batches
 * are skipped. `intake_batch.finalized_at` makes it idempotent: a batch is finalized once.
 */
export async function runFinalize(ctx: WorkerCtx, batchId: string): Promise<void> {
  const now = ctx.clock();
  await withIntakeLock(ctx.prisma, async (tx) => {
    const batch = await tx.intakeBatch.findUnique({ where: { id: batchId } });
    if (batch === null || batch.finalizedAt !== null || BATCHES_WITHOUT_FINALIZE.has(batch.kind)) {
      return;
    }
    const leads = await tx.lead.findMany({
      where: { intakeBatchId: batchId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    // Another lead may have been brought back for a check since the job was sent.
    if (leads.some((l) => l.pipelineState !== "ready")) return;

    const candidates: BatchLead[] = leads.map((lead, order) => ({
      id: lead.id,
      companyId: lead.companyId,
      status: lead.status,
      fitScore: lead.fitScore,
      postedAt: lead.postedAt,
      order,
    }));
    const { suppressIds } = finalizeBatch(candidates);
    if (suppressIds.length > 0) {
      const { count } = await tx.lead.updateMany({
        where: { id: { in: suppressIds }, status: "new" },
        data: {
          status: "suppressed",
          suppressedReason: "same_company_in_batch",
          statusChangedAt: now,
          updatedAt: now,
          version: { increment: 1 },
        },
      });
      await bumpBatchCounts(tx, batchId, { suppressed: count, accepted: -count });
    }
    await tx.intakeBatch.update({ where: { id: batchId }, data: { finalizedAt: now } });
  });
}
