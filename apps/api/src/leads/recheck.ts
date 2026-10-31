import type { Prisma } from "@prisma/client";
import type { WorkerCtx } from "../deps.js";
import { withIntakeLock } from "../db/lock.js";
import { checkLink } from "./link-check.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** An open lead is checked again once its last check is older than this. */
export const RECHECK_AFTER_MS = 20 * HOUR_MS;
/** The most leads one run fetches, oldest check first; the rest wait for the next day. */
export const RECHECK_BATCH = 150;
const RECHECK_CONCURRENCY = 3;
/**
 * A New lead that could not be confirmed open (LinkedIn only, or a page that did not show it) and
 * was posted, or found, longer ago than this is taken to be closed.
 */
export const STALE_AFTER_DAYS = 30;

/** The reasons a lead is dismissed by the system rather than by the owner. */
export const DISMISSED_POSTING_CLOSED = "posting_closed";
export const DISMISSED_EXPIRED = "expired";

export type RecheckResult = { checked: number; closed: number; expired: number };

const OPEN = ["new", "shortlisted"] as const;

/**
 * `leads.recheck`, daily: keeps the open leads honest about their postings.
 *
 * 1. Every New or Shortlisted lead with a link that can be fetched is checked again once a day.
 *    A posting that is gone is dismissed with the reason `posting_closed`; any other verdict
 *    replaces the stored one, so a lead never keeps saying "verified" about a page that no longer
 *    shows the job.
 * 2. A New lead that is not verified and is older than {@link STALE_AFTER_DAYS} days (by its
 *    posting date, else the date it was found) is dismissed with the reason `expired`. This is
 *    what retires old LinkedIn alert leads, which cannot be fetched. A lead the owner has already
 *    moved (shortlisted, or brought back with *Reconsider*) is left alone: its status changed
 *    after it was created.
 *
 * Every write carries the version that was read, so a lead the owner changed in the meantime is
 * skipped until the next run. The owner can bring any of these back from the Dismissed tab.
 * Nothing here logs a URL or page text.
 */
export async function runLeadsRecheck(ctx: WorkerCtx): Promise<RecheckResult> {
  const now = ctx.clock();
  const result: RecheckResult = { checked: 0, closed: 0, expired: 0 };

  const due = await ctx.prisma.lead.findMany({
    where: {
      status: { in: [...OPEN] },
      pipelineState: "ready",
      jobUrl: { not: null },
      verification: { not: "unverifiable" },
      OR: [
        { verifiedAt: null },
        { verifiedAt: { lt: new Date(now.getTime() - RECHECK_AFTER_MS) } },
      ],
    },
    select: { id: true, version: true, jobUrl: true, title: true },
    orderBy: [{ verifiedAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
    take: RECHECK_BATCH,
  });

  await mapLimit(due, RECHECK_CONCURRENCY, async (lead) => {
    const link = await checkLink(lead.jobUrl as string, ctx.fetchLink, { title: lead.title });
    const checkedAt = ctx.clock();
    const data: Prisma.LeadUpdateManyMutationInput =
      link.verdict === "dead"
        ? {
            status: "dismissed",
            dismissedReason: DISMISSED_POSTING_CLOSED,
            statusChangedAt: checkedAt,
            verifiedAt: checkedAt,
          }
        : {
            verification: link.verdict,
            verifiedAt: checkedAt,
            ...(link.verdict === "verified" ? { pageExcerpt: link.pageExcerpt } : {}),
          };
    const { count } = await withIntakeLock(ctx.prisma, (tx) =>
      tx.lead.updateMany({
        where: { id: lead.id, version: lead.version, status: { in: [...OPEN] } },
        data: { ...data, updatedAt: checkedAt, version: { increment: 1 } },
      }),
    );
    if (count === 0) return;
    result.checked += 1;
    if (link.verdict === "dead") result.closed += 1;
  });

  const cutoff = new Date(now.getTime() - STALE_AFTER_DAYS * DAY_MS);
  const old = await ctx.prisma.lead.findMany({
    where: {
      status: "new",
      pipelineState: "ready",
      verification: { not: "verified" },
      OR: [{ postedAt: { lt: cutoff } }, { postedAt: null, foundAt: { lt: cutoff } }],
    },
    select: { id: true, version: true, createdAt: true, statusChangedAt: true },
  });
  // A lead the owner moved (or reconsidered) has a status date well after it was created.
  const untouched = old.filter(
    (lead) => lead.statusChangedAt.getTime() - lead.createdAt.getTime() < HOUR_MS,
  );
  if (untouched.length > 0) {
    await withIntakeLock(ctx.prisma, async (tx) => {
      for (const lead of untouched) {
        const { count } = await tx.lead.updateMany({
          where: { id: lead.id, version: lead.version, status: "new" },
          data: {
            status: "dismissed",
            dismissedReason: DISMISSED_EXPIRED,
            statusChangedAt: now,
            updatedAt: now,
            version: { increment: 1 },
          },
        });
        result.expired += count;
      }
    });
  }

  if (result.checked + result.expired > 0) ctx.log.info(result, "leads recheck");
  return result;
}

async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next]!;
      next += 1;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
