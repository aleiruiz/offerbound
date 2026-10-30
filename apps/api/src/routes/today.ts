import { Prisma, type PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import {
  ApplicationStatusSchema,
  LeadsQuerySchema,
  type ApplicationStatus,
  type ApplicationSummary,
  type InterviewWithApplication,
  type ReviewItem,
  type Today,
} from "@offerbound/contracts";
import { dayRangeUtc, ownerLocalDay } from "@offerbound/domain";
import type { AppDeps } from "../deps.js";
import { getSyncStatus } from "../gmail/sync.js";
import { listLeads } from "../leads/owner-actions.js";
import { getSettings } from "../settings/service.js";
import { nextInterviewAtByApplication, toApplicationSummary, toInterview } from "./interviews.js";

/**
 * `GET /today` (TECHNICAL_SPEC §10.1; AC-13.1 to 13.4, AC-5.4). One call answers the whole page.
 *
 * "Today" is the owner's local day (`ownerLocalDay` / `dayRangeUtc`), so an application marked
 * applied at 23:30 in Monterrey counts today even though it is already tomorrow in UTC.
 */

export const TOP_LEADS = 5;
export const REVIEW_PREVIEW = 3;
/** Interviews within this many days of now are on Today (to-schedule ones always are). */
export const UPCOMING_DAYS = 7;
/** An application that has reached one of these counts toward the interview rate (AC-13.4). */
const SCREENING_OR_LATER: ApplicationStatus[] = [
  "screening",
  "assessment",
  "interviewing",
  "offer",
  "accepted",
];

export type TodayCtx = Pick<AppDeps, "prisma" | "env">;

/** The date column's value for an owner-local day: midnight UTC of that calendar date. */
export const dayColumn = (day: string): Date => new Date(`${day}T00:00:00.000Z`);

export async function getToday(ctx: TodayCtx, now: Date): Promise<Today> {
  const { prisma } = ctx;
  const timezone = ctx.env.userTimezone;
  const day = ownerLocalDay(now, timezone);
  const range = dayRangeUtc(day, timezone);

  const [
    settings,
    activity,
    applicationsToday,
    leadsToday,
    followUps,
    interviews,
    topLeads,
    reviewOpen,
    reviewFirst,
    sync,
    pipeline,
  ] = await Promise.all([
    getSettings(prisma),
    prisma.dailyActivity.findUnique({ where: { day: dayColumn(day) } }),
    prisma.application.count({ where: { appliedAt: { gte: range.start, lt: range.end } } }),
    // Leads that are shown to the owner (checked and ranked), found today, not suppressed.
    prisma.lead.count({
      where: {
        foundAt: { gte: range.start, lt: range.end },
        status: { not: "suppressed" },
        pipelineState: "ready",
      },
    }),
    followUpsDue(prisma, now),
    upcomingInterviews(prisma, now),
    listLeads(prisma, LeadsQuerySchema.parse({ status: "new", limit: TOP_LEADS })),
    prisma.reviewItem.count({ where: { state: "open" } }),
    prisma.reviewItem.findMany({
      where: { state: "open" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: REVIEW_PREVIEW,
      include: { message: true },
    }),
    getSyncStatus(prisma),
    pipelineSummary(prisma),
  ]);

  return {
    date: day,
    targets: settings.dailyTargets,
    counts: {
      newLeads: leadsToday,
      applications: applicationsToday,
      outreach: activity?.outreachCount ?? 0,
      followUps: activity?.followUps ?? 0,
      prepMinutes: activity?.prepMinutes ?? 0,
    },
    followUpsDue: followUps,
    upcomingInterviews: interviews,
    topLeads: topLeads.items,
    review: { open: reviewOpen, first: reviewFirst.map(toReviewItem) },
    sync,
    pipeline,
  };
}

// --- follow-ups and interviews --------------------------------------------------------------------

/** Applications whose follow-up is due, the one waiting longest first (AC-13.3). */
async function followUpsDue(prisma: PrismaClient, now: Date): Promise<ApplicationSummary[]> {
  const rows = await prisma.application.findMany({
    where: { followUpDue: true },
    orderBy: [{ followUpDueSince: { sort: "asc", nulls: "last" } }, { id: "asc" }],
    include: { company: true },
  });
  const next = await nextInterviewAtByApplication(
    prisma,
    rows.map((r) => r.id),
    now,
  );
  return rows.map((row) => toApplicationSummary(row, next.get(row.id) ?? null));
}

/** Interviews still to schedule first, then those starting within the next 7 days (AC-13.3). */
async function upcomingInterviews(
  prisma: PrismaClient,
  now: Date,
): Promise<InterviewWithApplication[]> {
  const until = new Date(now.getTime() + UPCOMING_DAYS * 24 * 3_600_000);
  const rows = await prisma.interview.findMany({
    where: {
      OR: [{ status: "to_schedule" }, { status: "scheduled", startsAt: { gte: now, lte: until } }],
    },
    orderBy: [{ startsAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }, { id: "asc" }],
    include: { application: { include: { company: true } } },
  });
  // To schedule first (whatever they hold in `starts_at`), then by start.
  rows.sort((a, b) => Number(b.status === "to_schedule") - Number(a.status === "to_schedule"));
  const next = await nextInterviewAtByApplication(
    prisma,
    rows.map((r) => r.applicationId),
    now,
  );
  return rows.map((row) => ({
    ...toInterview(row),
    application: toApplicationSummary(row.application, next.get(row.applicationId) ?? null),
  }));
}

// --- leads ----------------------------------------------------------------------------------------

// --- review ---------------------------------------------------------------------------------------

type ReviewRow = Prisma.ReviewItemGetPayload<{ include: { message: true } }>;

const REVIEW_TITLE: Record<ReviewRow["kind"], string> = {
  low_confidence: "Check a change from an email",
  ambiguous_match: "Choose the application for an email",
  unexpected_transition: "Confirm an unexpected status change",
  possible_duplicate_company: "Possible duplicate company",
  extraction_failed: "An email couldn't be read",
  undone_change: "Undone change",
};

/** Words for an operation name such as `update_application`: the action and what it acts on. */
function operationPreview(op: unknown): { entity: string; action: string; summary: string } | null {
  const name = typeof op === "object" && op !== null ? (op as { op?: unknown }).op : undefined;
  if (typeof name !== "string") return null;
  const [action = name, ...rest] = name.split("_");
  const entity = rest.join(" ") || "record";
  return {
    entity,
    action,
    summary: `${action[0]?.toUpperCase() ?? ""}${action.slice(1)} ${entity}`,
  };
}

/**
 * The review item as Today shows it. The proposal reads from what the item stored: the reasons
 * the plan gave, and one preview line per operation of the stored plan.
 */
function toReviewItem(row: ReviewRow): ReviewItem {
  const plan = row.plan;
  const operations =
    typeof plan === "object" &&
    plan !== null &&
    "operations" in plan &&
    Array.isArray(plan.operations)
      ? plan.operations.flatMap((op: unknown) => operationPreview(op) ?? [])
      : [];
  const candidates = Array.isArray(row.candidates)
    ? row.candidates.flatMap((c) => {
        const candidate = c as { id?: unknown; label?: unknown } | null;
        return typeof candidate?.id === "string" && typeof candidate.label === "string"
          ? [{ id: candidate.id, label: candidate.label }]
          : [];
      })
    : [];
  const message = row.message;
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    createdAt: row.createdAt.toISOString(),
    confidence: row.confidence,
    message:
      message === null
        ? null
        : {
            id: message.id,
            internalDate: message.internalDate.toISOString(),
            direction: message.direction,
            fromName: message.fromName,
            fromEmail: message.fromEmail,
            subject: message.subject,
            summary: message.summary,
            category: message.category,
          },
    proposal: { description: row.reasons[0] ?? REVIEW_TITLE[row.kind], operations },
    candidates,
  };
}

// --- pipeline summary (AC-13.4) -------------------------------------------------------------------

async function pipelineSummary(prisma: PrismaClient): Promise<Today["pipeline"]> {
  const [groups, replied, reachedRows] = await Promise.all([
    prisma.application.groupBy({ by: ["status"], _count: { _all: true } }),
    // Any reply beyond the automatic acknowledgement: an inbound email that isn't an application
    // confirmation (and has been categorised).
    prisma.application.count({
      where: {
        messages: {
          some: {
            direction: "inbound",
            category: { not: null, notIn: ["application_confirmation"] },
          },
        },
      },
    }),
    // Screening or later now, or at any time before: a status change into one of those statuses
    // that wasn't undone. The importer and the pipeline write the target as `data.toStatus`;
    // `data.to` is accepted too (the task brief's spelling).
    prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count FROM application a
      WHERE a.status::text IN (${Prisma.join(SCREENING_OR_LATER)})
         OR EXISTS (
           SELECT 1 FROM event e
           WHERE e.application_id = a.id
             AND e.type = 'status_changed'::event_type
             AND e.undone_at IS NULL
             AND coalesce(e.data->>'toStatus', e.data->>'to') IN (${Prisma.join(SCREENING_OR_LATER)}))`,
  ]);

  const byStatus = Object.fromEntries(
    ApplicationStatusSchema.options.map((status) => [
      status,
      groups.find((g) => g.status === status)?._count._all ?? 0,
    ]),
  ) as Record<ApplicationStatus, number>;
  const total = Object.values(byStatus).reduce((sum, n) => sum + n, 0);
  const reached = Number(reachedRows[0]?.count ?? 0);
  return {
    byStatus,
    responseRate: total === 0 ? 0 : replied / total,
    interviewRate: total === 0 ? 0 : reached / total,
  };
}

export function registerTodayRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/today", (): Promise<Today> => getToday(deps, deps.clock()));
}
