import { finalizeBatch } from "@offerbound/domain";
import type { WorkerCtx } from "../deps.js";
import { withIntakeLock } from "../db/lock.js";
import { bumpBatchCounts, sendFinalizeIfSettled, type LeadsTx } from "./intake.js";
import { checkLink, type LinkCheckResult } from "./link-check.js";
import { QUEUES } from "../jobs/queues.js";

/** A lead with no job link has nothing to fetch; it is simply not verified. */
const NO_LINK: LinkCheckResult = { verdict: "unverified", finalUrl: null, pageExcerpt: null };

type Outcome = { batchId: string; rank: boolean; recheck: string[] };

/**
 * `leads.check` for one lead (TECHNICAL_SPEC §7.1, §7.2, AC-9.8). Skips a lead that is not in
 * `checking`, so a repeated job changes nothing; it does send again whatever the first run may not
 * have got to send (`leads.rank` for a lead waiting in `ranking`, the checks of a batch whose lead
 * is gone, `leads.finalize` for a settled batch), because the first run commits before it sends.
 * The sends are idempotent: a second `leads.rank` finds nothing to rank, a second check skips,
 * and `leads.finalize` is keyed by the batch. `batchId` is the batch the job was sent for.
 *
 * - Dead: the lead is deleted, so its company does not count as reported, and the batch's `dead`
 *   count goes up. A `sheet_import` lead is history and becomes `dismissed` with `posting_closed`.
 *   If the dead lead was the kept lead of its company, the best remaining `same_company_in_batch`
 *   lead of that company goes back to `new` and is checked.
 * - Anything else: the verdict is stored (the page text too when verified) and the lead moves to
 *   `ranking`; one that was ranked before (a lead brought back after its company's kept lead
 *   died) goes straight back to `ready`.
 *
 * The job link and job key stay as they were received. A redirect's final URL is used only to
 * judge the page: the key identifies the posting in the alert, so the same alert, processed again,
 * still finds its duplicates.
 *
 * The page is fetched before the lock is taken; nothing slow runs while it is held. Nothing here
 * logs a URL or page text.
 */
export async function runLeadCheck(
  ctx: WorkerCtx,
  leadId: string,
  batchId?: string,
): Promise<void> {
  const lead = await ctx.prisma.lead.findUnique({
    where: { id: leadId },
    select: { pipelineState: true, jobUrl: true },
  });
  if (lead === null || lead.pipelineState !== "checking") {
    await resendFollowUps(ctx, leadId, batchId);
    return;
  }

  const result = lead.jobUrl === null ? NO_LINK : await checkLink(lead.jobUrl, ctx.fetchLink);
  const now = ctx.clock();

  const outcome = await withIntakeLock(ctx.prisma, async (tx): Promise<Outcome | null> => {
    const current = await tx.lead.findUnique({ where: { id: leadId } });
    if (current === null || current.pipelineState !== "checking") return null;
    const base = { batchId: current.intakeBatchId, rank: false, recheck: [] as string[] };

    if (result.verdict === "dead") {
      if (current.source === "sheet_import") {
        await tx.lead.update({
          where: { id: leadId },
          data: {
            status: "dismissed",
            dismissedReason: "posting_closed",
            pipelineState: "ready",
            statusChangedAt: now,
            updatedAt: now,
            version: { increment: 1 },
          },
        });
        // History: kept, but no longer one of the leads the batch accepted.
        if (current.status === "new")
          await bumpBatchCounts(tx, current.intakeBatchId, { accepted: -1 });
        return base;
      }
      await tx.lead.delete({ where: { id: leadId } });
      await bumpBatchCounts(tx, current.intakeBatchId, {
        dead: 1,
        accepted: current.status === "new" ? -1 : 0,
      });
      base.recheck = await promoteRunnerUp(tx, current.intakeBatchId, current.companyId, now);
      return base;
    }

    const ranked = current.rankedAt !== null;
    await tx.lead.update({
      where: { id: leadId },
      data: {
        verification: result.verdict,
        verifiedAt: now,
        pageExcerpt: result.verdict === "verified" ? result.pageExcerpt : null,
        pipelineState: ranked ? "ready" : "ranking",
        updatedAt: now,
        version: { increment: 1 },
      },
    });
    return { ...base, rank: !ranked };
  });
  if (outcome === null) {
    await resendFollowUps(ctx, leadId, batchId);
    return;
  }

  if (outcome.rank) await ctx.queue.send(QUEUES.leadsRank, {});
  for (const id of outcome.recheck) {
    await ctx.queue.send(QUEUES.leadsCheck, { leadId: id, batchId: outcome.batchId });
  }
  await sendFinalizeIfSettled(ctx, outcome.batchId);
}

/**
 * The follow-ups of a check that has already happened (see `runLeadCheck`). A lead that is gone
 * was dead: the lead brought back in its place, if any, is the batch's lead in `checking`.
 */
async function resendFollowUps(ctx: WorkerCtx, leadId: string, batchHint?: string): Promise<void> {
  const lead = await ctx.prisma.lead.findUnique({
    where: { id: leadId },
    select: { pipelineState: true, intakeBatchId: true },
  });
  const batchId = lead?.intakeBatchId ?? batchHint;
  if (batchId === undefined) return;
  if (lead === null) {
    const waiting = await ctx.prisma.lead.findMany({
      where: { intakeBatchId: batchId, pipelineState: "checking" },
      select: { id: true },
    });
    for (const { id } of waiting) await ctx.queue.send(QUEUES.leadsCheck, { leadId: id, batchId });
  } else if (lead.pipelineState === "ranking") {
    await ctx.queue.send(QUEUES.leadsRank, {});
  }
  await sendFinalizeIfSettled(ctx, batchId);
}

/**
 * When a company's only `new` lead in the batch is gone, the best of its `same_company_in_batch`
 * leads takes its place: back to `new`, waiting for a check. Returns the promoted ids.
 */
async function promoteRunnerUp(
  tx: LeadsTx,
  batchId: string,
  companyId: string,
  now: Date,
): Promise<string[]> {
  const siblings = await tx.lead.findMany({
    where: { intakeBatchId: batchId, companyId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  if (siblings.some((l) => l.status === "new")) return [];
  // `finalizeBatch` keeps the best lead of each company, which is the one to bring back.
  const candidates = siblings
    .map((lead, order) => ({
      id: lead.id,
      companyId: lead.companyId,
      status: "new" as const,
      fitScore: lead.fitScore,
      postedAt: lead.postedAt,
      order,
      eligible: lead.suppressedReason === "same_company_in_batch",
    }))
    .filter((c) => c.eligible);
  const { suppressIds } = finalizeBatch(candidates);
  const best = candidates.find((c) => !suppressIds.includes(c.id));
  if (best === undefined) return [];
  await tx.lead.update({
    where: { id: best.id },
    data: {
      status: "new",
      suppressedReason: null,
      pipelineState: "checking",
      statusChangedAt: now,
      updatedAt: now,
      version: { increment: 1 },
    },
  });
  await bumpBatchCounts(tx, batchId, { suppressed: -1, accepted: 1 });
  return [best.id];
}
