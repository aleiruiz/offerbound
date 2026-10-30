import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import type { ApplicationStatus, NavCounts } from "@offerbound/contracts";
import type { AppDeps } from "../deps.js";
import { countUpcomingInterviews } from "./interviews.js";

/** Applications still in play: the statuses before a final outcome. */
const OPEN_STATUSES: ApplicationStatus[] = [
  "applied",
  "screening",
  "assessment",
  "interviewing",
  "offer",
];

/**
 * The four navigation badges (DESIGN_SPEC §3; AC-5.4).
 * - `upcomingInterviews` is the Upcoming list of the Interviews page (to-schedule interviews and
 *   every scheduled one from now on, no 7-day window), so the badge and the list agree. Today's own
 *   "next 7 days" list is separate.
 * - `newLeads` is the New tab: New leads that have been checked and ranked.
 */
export async function getNavCounts(prisma: PrismaClient, now: Date): Promise<NavCounts> {
  const [openApplications, newLeads, upcomingInterviews, openReview] = await Promise.all([
    prisma.application.count({ where: { status: { in: OPEN_STATUSES } } }),
    prisma.lead.count({ where: { status: "new", pipelineState: "ready" } }),
    countUpcomingInterviews(prisma, now),
    prisma.reviewItem.count({ where: { state: "open" } }),
  ]);
  return { openApplications, newLeads, upcomingInterviews, openReview };
}

export function registerNavCountsRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/nav-counts", (): Promise<NavCounts> => getNavCounts(deps.prisma, deps.clock()));
}
