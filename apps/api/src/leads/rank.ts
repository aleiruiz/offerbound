import { clampRanking, type Ranking } from "@offerbound/contracts";
import type { WorkerCtx } from "../deps.js";
import { QUEUES } from "../jobs/queues.js";
import { getSettings } from "../settings/service.js";
import { getActiveProfile } from "./cv.js";
import { bumpBatchCounts, rankingColumns, sendFinalizeIfSettled, withLeadsLock } from "./intake.js";

/** Leads ranked by one model call (TECHNICAL_SPEC §7.1). */
export const RANK_BATCH_SIZE = 10;

/**
 * `leads.rank`: ranks up to 10 leads that are in `ranking` with one model call (§7.4, AC-12.1,
 * AC-12.2), stores the result, and moves them to `ready`. A ranking with eligibility `no` →
 * `suppressed, ineligible`; a seniority the owner excludes → `suppressed, excluded_seniority`
 * (AC-9.3 rule 5, which needs the ranked seniority). Leads that are not in `ranking` any more
 * are left alone, so a repeated job does nothing twice.
 *
 * The model sees the brief, CV profile, tracks, home country and, per lead: company, title,
 * location, work mode, compensation text and the page excerpt (stored only for a verified link).
 * Lead pages are untrusted text; they only ever reach this one call, and nothing they say is
 * acted on beyond the schema-checked ranking. The model is called before the lock is taken.
 *
 * A lead the model leaves out stays in `ranking` and the job fails, so pg-boss retries it. When
 * more leads wait, another `leads.rank` is sent.
 */
export async function runRankBatch(ctx: WorkerCtx): Promise<void> {
  const leads = await ctx.prisma.lead.findMany({
    where: { pipelineState: "ranking", status: "new" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: RANK_BATCH_SIZE,
    include: { company: { select: { name: true } } },
  });
  if (leads.length === 0) return;

  const settings = await getSettings(ctx.prisma);
  const cvProfile = await getActiveProfile(ctx.prisma);
  const { output } = await ctx.llm.rank({
    brief: settings.search.brief,
    cvProfile,
    tracks: settings.search.tracks,
    homeCountry: ctx.env.homeCountry,
    leads: leads.map((lead) => ({
      leadRef: lead.id,
      company: lead.company.name,
      title: lead.title,
      locationText: lead.locationText,
      workMode: lead.workMode,
      compensationText: lead.compensationText,
      pageExcerpt: lead.pageExcerpt,
    })),
  });

  // Only rankings for the leads we asked about count; anything else the model returned is dropped.
  const byRef = new Map<string, Ranking>();
  for (const ranking of output.rankings) {
    if (leads.some((l) => l.id === ranking.leadRef) && !byRef.has(ranking.leadRef)) {
      byRef.set(ranking.leadRef, clampRanking(ranking));
    }
  }

  const trackKeys = settings.search.tracks.map((t) => t.key);
  const excluded = new Set(settings.search.excludedSeniorities);
  const now = ctx.clock();
  const batches = new Set<string>();

  await withLeadsLock(ctx.prisma, async (tx) => {
    for (const lead of leads) {
      const ranking = byRef.get(lead.id);
      if (ranking === undefined) continue;
      const seniority = ranking.seniority === "unknown" ? lead.seniority : ranking.seniority;
      const reason =
        seniority !== "unknown" && excluded.has(seniority)
          ? ("excluded_seniority" as const)
          : ranking.eligible === "no"
            ? ("ineligible" as const)
            : null;
      const { count } = await tx.lead.updateMany({
        where: { id: lead.id, pipelineState: "ranking" },
        data: {
          ...rankingColumns(ranking, trackKeys),
          seniority,
          workMode: ranking.workMode === "unknown" ? lead.workMode : ranking.workMode,
          pipelineState: "ready",
          rankedAt: now,
          updatedAt: now,
          version: { increment: 1 },
          ...(reason === null
            ? {}
            : { status: "suppressed", suppressedReason: reason, statusChangedAt: now }),
        },
      });
      if (count === 0) continue;
      batches.add(lead.intakeBatchId);
      if (reason !== null)
        await bumpBatchCounts(tx, lead.intakeBatchId, { suppressed: 1, accepted: -1 });
    }
  });

  const missing = leads.filter((l) => !byRef.has(l.id)).length;
  if (missing > 0) throw new Error(`The model did not rank ${missing} of ${leads.length} leads`);

  if ((await ctx.prisma.lead.count({ where: { pipelineState: "ranking", status: "new" } })) > 0) {
    await ctx.queue.send(QUEUES.leadsRank, {});
  }
  for (const batchId of batches) await sendFinalizeIfSettled(ctx, batchId);
}
