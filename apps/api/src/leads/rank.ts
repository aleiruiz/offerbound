import { clampRanking, type Ranking } from "@offerbound/contracts";
import type { WorkerCtx } from "../deps.js";
import { QUEUES } from "../jobs/queues.js";
import { getSettings } from "../settings/service.js";
import { getActiveProfile } from "./cv.js";
import { withIntakeLock } from "../db/lock.js";
import { bumpBatchCounts, rankingColumns, sendPendingFinalizes } from "./intake.js";

/** Leads ranked by one model call (TECHNICAL_SPEC §7.1). */
export const RANK_BATCH_SIZE = 10;
/** The most page text sent to the model per lead (TECHNICAL_SPEC §7.2, SECURITY). */
const EXCERPT_MAX_CHARS = 8000;

function boundedExcerpt(excerpt: string | null): string | null {
  if (excerpt === null) return null;
  const cut = excerpt.slice(0, EXCERPT_MAX_CHARS);
  // Never end on half of a surrogate pair.
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

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
 * A lead the model leaves out stays in `ranking` and the job fails, so pg-boss retries it. On the
 * last attempt (`lastAttempt`), or when the model call itself fails on it, the leads it could not
 * rank move on unranked instead: `ready`, fit score null, so they show in the New list with no
 * rank and their batch can finish. The lead table has no column for a rank error. When more leads
 * wait, another `leads.rank` is sent. Whatever the first run may not have sent after committing
 * (`leads.finalize` for a settled batch) is sent again, so a re-delivered job heals the batch.
 */
export async function runRankBatch(
  ctx: WorkerCtx,
  opts: { lastAttempt?: boolean } = {},
): Promise<void> {
  const leads = await ctx.prisma.lead.findMany({
    where: { pipelineState: "ranking", status: "new" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: RANK_BATCH_SIZE,
    include: { company: { select: { name: true } } },
  });
  if (leads.length === 0) {
    await sendPendingFinalizes(ctx);
    return;
  }

  const settings = await getSettings(ctx.prisma);
  const cvProfile = await getActiveProfile(ctx.prisma);
  let rankings: Ranking[];
  try {
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
        pageExcerpt: boundedExcerpt(lead.pageExcerpt),
      })),
    });
    rankings = output.rankings;
  } catch (error) {
    if (opts.lastAttempt === true) {
      await leaveUnranked(
        ctx,
        leads.map((l) => l.id),
      );
      await followUps(ctx, []);
    }
    throw error;
  }

  // Only rankings for the leads we asked about count; anything else the model returned is dropped.
  const byRef = new Map<string, Ranking>();
  for (const ranking of rankings) {
    if (leads.some((l) => l.id === ranking.leadRef) && !byRef.has(ranking.leadRef)) {
      byRef.set(ranking.leadRef, clampRanking(ranking));
    }
  }

  const trackKeys = settings.search.tracks.map((t) => t.key);
  const excluded = new Set(settings.search.excludedSeniorities);
  const now = ctx.clock();

  await withIntakeLock(ctx.prisma, async (tx) => {
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
      if (reason !== null) {
        await bumpBatchCounts(tx, lead.intakeBatchId, { suppressed: 1, accepted: -1 });
      }
    }
  });

  const omitted = leads.filter((l) => !byRef.has(l.id)).map((l) => l.id);
  if (omitted.length > 0 && opts.lastAttempt === true) {
    await leaveUnranked(ctx, omitted);
    await followUps(ctx, []);
    return;
  }
  // Leads the model left out wait for the retry of this job, not for a job of their own.
  await followUps(ctx, omitted);
  if (omitted.length > 0) {
    throw new Error(`The model did not rank ${omitted.length} of ${leads.length} leads`);
  }
}

/** Moves leads on without a rank: `ready`, no fit score, status unchanged (still `new`). */
async function leaveUnranked(ctx: WorkerCtx, ids: string[]): Promise<void> {
  const now = ctx.clock();
  const { count } = await ctx.prisma.lead.updateMany({
    where: { id: { in: ids }, pipelineState: "ranking" },
    data: { pipelineState: "ready", updatedAt: now, version: { increment: 1 } },
  });
  ctx.log.warn({ count }, "leads left unranked after ranking failed");
}

/** Another `leads.rank` for the leads still waiting (not `except`), and finalize for settled batches. */
async function followUps(ctx: WorkerCtx, except: string[]): Promise<void> {
  const waiting = await ctx.prisma.lead.count({
    where: { pipelineState: "ranking", status: "new", id: { notIn: except } },
  });
  if (waiting > 0) await ctx.queue.send(QUEUES.leadsRank, {});
  await sendPendingFinalizes(ctx);
}
