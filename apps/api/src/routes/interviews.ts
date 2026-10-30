import {
  Prisma,
  type Application,
  type Company,
  type Interview as InterviewRow,
  type PrismaClient,
} from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { DateTime } from "luxon";
import { z } from "zod";
import {
  API_ERROR_STATUS,
  InterviewPatchSchema,
  type ApplicationSummary,
  type Interview,
  type InterviewWithApplication,
  type Page,
} from "@offerbound/contracts";
import type { AppDeps } from "../deps.js";
import { writeEvent } from "../db/events.js";
import { ApiError, errorBody } from "../http/errors.js";

/**
 * Interview routes (TECHNICAL_SPEC §10.1; AC-8.4, AC-8.5). Register inside the guarded scope.
 * `POST /applications/:id/interviews` belongs to the applications routes (T7.1).
 *
 * - **Upcoming** is every `to_schedule` interview (no time yet, listed first) followed by the
 *   `scheduled` ones that start now or later, earliest first. **Past** is every `completed`
 *   and every `cancelled` interview, whatever its time, plus any `scheduled` one that started
 *   before now (the timer has not completed it yet), latest first; an interview with no start
 *   sorts by when it was created. A cancelled interview is never Upcoming.
 *   `countUpcomingInterviews` counts exactly the Upcoming set, so the navigation
 *   badge and the list agree.
 * - **PATCH** is an owner edit: it carries the `version`, does not take the intake lock and is not
 *   undoable (§6.6). A stale version answers `409 version_conflict` with the record as `current`.
 */

// --- queries ---------------------------------------------------------------------------------------

export const INTERVIEWS_DEFAULT_LIMIT = 50;
export const INTERVIEWS_MAX_LIMIT = 200;

const InterviewsQuerySchema = z.object({
  range: z.enum(["upcoming", "past"]),
  limit: z.coerce.number().int().min(1).max(INTERVIEWS_MAX_LIMIT).default(INTERVIEWS_DEFAULT_LIMIT),
  cursor: z.string().min(1).optional(),
});

/** Where a page stopped: the row's sort group (0 = to schedule, 1 = the rest), sort time and id. */
const CursorSchema = z.object({
  g: z.union([z.literal(0), z.literal(1)]),
  t: z.iso.datetime(),
  id: z.uuid(),
});
type Cursor = z.infer<typeof CursorSchema>;

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(raw: string): Cursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    return CursorSchema.parse(parsed);
  } catch {
    throw new ApiError(400, "validation_failed", "The cursor is not valid.", { cursor: "invalid" });
  }
}

const GROUP_SQL = Prisma.sql`(CASE WHEN i.status = 'to_schedule'::interview_status THEN 0 ELSE 1 END)`;
/** Rows with no start (completed or to-schedule) sort by when they were created. */
const SORT_TIME_SQL = Prisma.sql`coalesce(i.starts_at, i.created_at)`;

/** `interview` aliased `i`: to-schedule interviews, and scheduled ones that start now or later. */
const upcomingWhere = (now: Date): Prisma.Sql => Prisma.sql`
  (i.status = 'to_schedule'::interview_status
   OR (i.status = 'scheduled'::interview_status AND i.starts_at >= ${now}))`;

/** The interviews on the Upcoming list; what the navigation badge shows. */
export async function countUpcomingInterviews(prisma: PrismaClient, now: Date): Promise<number> {
  const [row] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(*) AS count FROM interview i WHERE ${upcomingWhere(now)}`;
  return Number(row?.count ?? 0);
}

/** The id and sort time of each row on one page, in list order. */
async function pageKeys(
  prisma: PrismaClient,
  range: "upcoming" | "past",
  now: Date,
  after: Cursor | null,
  take: number,
): Promise<{ id: string; g: number; t: Date }[]> {
  if (range === "upcoming") {
    const afterSql = after
      ? Prisma.sql`AND (${GROUP_SQL}, ${SORT_TIME_SQL}, i.id)
          > (${after.g}::int, ${new Date(after.t)}::timestamptz, ${after.id}::uuid)`
      : Prisma.empty;
    return prisma.$queryRaw`
      SELECT i.id::text AS id, ${GROUP_SQL} AS g, ${SORT_TIME_SQL} AS t
      FROM interview i
      WHERE ${upcomingWhere(now)} ${afterSql}
      ORDER BY g, t, i.id
      LIMIT ${take}`;
  }
  const afterSql = after
    ? Prisma.sql`AND (${SORT_TIME_SQL}, i.id) < (${new Date(after.t)}::timestamptz, ${after.id}::uuid)`
    : Prisma.empty;
  return prisma.$queryRaw`
    SELECT i.id::text AS id, 1 AS g, ${SORT_TIME_SQL} AS t
    FROM interview i
    WHERE (i.status IN ('completed'::interview_status, 'cancelled'::interview_status)
           OR (i.status = 'scheduled'::interview_status AND i.starts_at < ${now})) ${afterSql}
    ORDER BY t DESC, i.id DESC
    LIMIT ${take}`;
}

// --- DTOs ------------------------------------------------------------------------------------------

const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());

export function toInterview(row: InterviewRow): Interview {
  return {
    id: row.id,
    version: row.version,
    applicationId: row.applicationId,
    kind: row.kind,
    status: row.status,
    startsAt: iso(row.startsAt),
    endsAt: iso(row.endsAt),
    timezoneHint: row.timezoneHint,
    meetingUrl: row.meetingUrl,
    schedulingUrl: row.schedulingUrl,
    location: row.location,
    interviewers: row.interviewers,
    notes: row.notes,
  };
}

/** `nextInterviewAt` is the application's earliest scheduled interview from now on. */
export function toApplicationSummary(
  row: Application & { company: Pick<Company, "id" | "name"> },
  nextInterviewAt: Date | null,
): ApplicationSummary {
  return {
    id: row.id,
    version: row.version,
    company: { id: row.company.id, name: row.company.name },
    title: row.title,
    status: row.status,
    statusChangedAt: row.statusChangedAt.toISOString(),
    appliedAt: iso(row.appliedAt),
    lastCompanyActivityAt: iso(row.lastCompanyActivityAt),
    followUpDue: row.followUpDue,
    nextInterviewAt: iso(nextInterviewAt),
    workMode: row.workMode,
    country: row.country,
    source: row.source,
  };
}

async function listInterviews(
  prisma: PrismaClient,
  query: z.infer<typeof InterviewsQuerySchema>,
  now: Date,
): Promise<Page<InterviewWithApplication>> {
  const after = query.cursor === undefined ? null : decodeCursor(query.cursor);
  const keys = await pageKeys(prisma, query.range, now, after, query.limit + 1);
  const pageOfKeys = keys.slice(0, query.limit);
  const last = pageOfKeys.at(-1);
  const nextCursor =
    keys.length > query.limit && last
      ? encodeCursor({ g: last.g === 0 ? 0 : 1, t: last.t.toISOString(), id: last.id })
      : null;

  const rows = await prisma.interview.findMany({
    where: { id: { in: pageOfKeys.map((k) => k.id) } },
    include: { application: { include: { company: true } } },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));

  const next = await prisma.interview.groupBy({
    by: ["applicationId"],
    where: {
      applicationId: { in: [...new Set(rows.map((r) => r.applicationId))] },
      status: "scheduled",
      startsAt: { gte: now },
    },
    _min: { startsAt: true },
  });
  const nextByApplication = new Map(next.map((n) => [n.applicationId, n._min.startsAt]));

  const items: InterviewWithApplication[] = [];
  for (const { id } of pageOfKeys) {
    const row = byId.get(id);
    if (!row) continue; // Deleted between the two reads.
    items.push({
      ...toInterview(row),
      application: toApplicationSummary(
        row.application,
        nextByApplication.get(row.applicationId) ?? null,
      ),
    });
  }
  return { items, nextCursor };
}

// --- PATCH -----------------------------------------------------------------------------------------

type Patch = z.infer<typeof InterviewPatchSchema>;
type Changes = Partial<
  Pick<
    InterviewRow,
    "kind" | "status" | "startsAt" | "endsAt" | "meetingUrl" | "location" | "interviewers" | "notes"
  >
>;

class StaleInterview extends Error {
  constructor(readonly current: InterviewRow | null) {
    super("stale");
  }
}

const sameValue = (a: unknown, b: unknown): boolean => {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => v === b[i]);
  return a === b;
};

/** The fields of the patch that differ from the stored row, as new values. */
function changesOf(row: InterviewRow, patch: Patch): Changes {
  const wanted: Changes = {
    ...(patch.kind !== undefined && { kind: patch.kind }),
    ...(patch.status !== undefined && { status: patch.status }),
    ...(patch.startsAt !== undefined && {
      startsAt: patch.startsAt === null ? null : new Date(patch.startsAt),
    }),
    ...(patch.endsAt !== undefined && {
      endsAt: patch.endsAt === null ? null : new Date(patch.endsAt),
    }),
    ...(patch.meetingUrl !== undefined && { meetingUrl: patch.meetingUrl }),
    ...(patch.location !== undefined && { location: patch.location }),
    ...(patch.interviewers !== undefined && { interviewers: patch.interviewers }),
    ...(patch.notes !== undefined && { notes: patch.notes }),
  };
  const changes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(wanted)) {
    if (!sameValue(row[key as keyof InterviewRow], value)) changes[key] = value;
  }
  return changes;
}

/**
 * The rules for an interview's times, shared with the create route (T7.1): a `scheduled` interview
 * needs a start, and an end cannot come before it. Throws 400 `validation_failed` with the field.
 */
export function assertInterviewTimes(interview: {
  status: InterviewRow["status"];
  startsAt: Date | null;
  endsAt: Date | null;
}): void {
  const { status, startsAt, endsAt } = interview;
  if (status === "scheduled" && !startsAt) {
    throw new ApiError(400, "validation_failed", "A scheduled interview needs a start time.", {
      startsAt: "required_when_scheduled",
    });
  }
  if (startsAt && endsAt && endsAt.getTime() < startsAt.getTime()) {
    throw new ApiError(400, "validation_failed", "The interview can't end before it starts.", {
      endsAt: "before_start",
    });
  }
}

/** Checks the row as it would be after `changes`; a patch that leaves status and times alone is not checked. */
function assertTimesMakeSense(row: InterviewRow, changes: Changes): void {
  if (!("status" in changes || "startsAt" in changes || "endsAt" in changes)) return;
  assertInterviewTimes({
    status: changes.status ?? row.status,
    startsAt: "startsAt" in changes ? (changes.startsAt ?? null) : row.startsAt,
    endsAt: "endsAt" in changes ? (changes.endsAt ?? null) : row.endsAt,
  });
}

function eventFor(
  row: InterviewRow,
  changes: Changes,
  timezone: string,
): {
  type: "interview_updated" | "interview_cancelled" | "interview_completed" | "note_updated";
  summary: string;
} {
  if (changes.status === "cancelled")
    return { type: "interview_cancelled", summary: "Interview cancelled" };
  if (changes.status === "completed")
    return { type: "interview_completed", summary: "Interview completed" };
  const keys = Object.keys(changes);
  // Prep notes are never quoted in the timeline.
  if (keys.length === 1 && keys[0] === "notes") {
    return { type: "note_updated", summary: "Interview prep notes updated" };
  }
  const startsAt = changes.startsAt;
  if (startsAt) {
    const when = DateTime.fromJSDate(startsAt, { zone: timezone })
      .setLocale("en-US")
      .toFormat("ccc, LLL d, HH:mm");
    const wasScheduled = row.status === "scheduled" && row.startsAt !== null;
    return {
      type: "interview_updated",
      summary: wasScheduled
        ? `Interview rescheduled to ${when}`
        : `Interview scheduled for ${when}`,
    };
  }
  return { type: "interview_updated", summary: "Interview updated" };
}

async function patchInterview(
  deps: AppDeps,
  id: string,
  patch: Patch,
): Promise<{ interview: Interview } | { stale: Interview | null }> {
  const now = deps.clock();
  try {
    const row = await deps.prisma.$transaction(async (tx) => {
      const current = await tx.interview.findUnique({ where: { id } });
      if (!current) throw new StaleInterview(null);
      if (current.version !== patch.version) throw new StaleInterview(current);

      const changes = changesOf(current, patch);
      if (Object.keys(changes).length === 0) return current;
      assertTimesMakeSense(current, changes);

      const { count } = await tx.interview.updateMany({
        where: { id, version: current.version },
        data: { ...changes, version: { increment: 1 } },
      });
      if (count === 0) {
        throw new StaleInterview(await tx.interview.findUnique({ where: { id } }));
      }
      const updated = await tx.interview.findUniqueOrThrow({ where: { id } });

      const { type, summary } = eventFor(current, changes, deps.env.userTimezone);
      await writeEvent(tx, {
        applicationId: current.applicationId,
        type,
        actor: "owner",
        occurredAt: now,
        summary,
        // Which fields changed, never their values: the notes stay out of the timeline.
        data: { interviewId: id, fields: Object.keys(changes) },
        undoable: false,
      });
      return updated;
    });
    return { interview: toInterview(row) };
  } catch (error) {
    if (error instanceof StaleInterview) {
      return { stale: error.current === null ? null : toInterview(error.current) };
    }
    throw error;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerInterviewRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/interviews", async (request): Promise<Page<InterviewWithApplication>> => {
    const query = InterviewsQuerySchema.parse(request.query);
    return listInterviews(deps.prisma, query, deps.clock());
  });

  app.patch<{ Params: { id: string } }>("/interviews/:id", async (request, reply) => {
    const { id } = request.params;
    if (!UUID.test(id)) throw new ApiError(404, "not_found", "No such interview.");
    const patch = InterviewPatchSchema.parse(request.body);
    const result = await patchInterview(deps, id, patch);
    if ("interview" in result) return result.interview;
    if (result.stale === null) throw new ApiError(404, "not_found", "No such interview.");
    // TECHNICAL_SPEC §10: "409 version_conflict with the current record". The envelope keeps its
    // shape; the record rides next to it as `current`, which the web refreshes from.
    return reply.code(API_ERROR_STATUS.version_conflict).send({
      ...errorBody(
        "version_conflict",
        "This interview was changed elsewhere. Showing the latest version.",
      ),
      current: result.stale,
    });
  });
}
