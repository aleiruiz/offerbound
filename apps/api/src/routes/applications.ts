import {
  Prisma,
  type Application,
  type Company,
  type PrismaClient,
  type Event as EventRow,
} from "@prisma/client";
import type { FastifyInstance, FastifyReply } from "fastify";
import { DateTime } from "luxon";
import { z } from "zod";
import {
  API_ERROR_STATUS,
  ApplicationCreateSchema,
  ApplicationMergeSchema,
  ApplicationPatchSchema,
  ApplicationStatusSchema,
  InterviewCreateSchema,
  type ApplicationCreate,
  type ApplicationDetail,
  type ApplicationPatch,
  type ApplicationStatus,
  type ApplicationSummary,
  type Interview,
  type MessageSummary,
  type Page,
} from "@offerbound/contracts";
import { jobKey, normalizeCompanyName, ownerLocalDay } from "@offerbound/domain";
import type { AppDeps } from "../deps.js";
import { writeEvent } from "../db/events.js";
import { withIntakeLock } from "../db/lock.js";
import { ApiError, errorBody } from "../http/errors.js";
import { newApplicationDetail } from "../leads/dto.js";
import { assertId } from "../leads/owner-actions.js";
import {
  assertInterviewTimes,
  nextInterviewAtByApplication,
  toApplicationSummary,
  toInterview,
} from "./interviews.js";
import { dayColumn } from "./today.js";

/**
 * Application routes (TECHNICAL_SPEC §10.1; AC-6.1 to AC-6.3, AC-7.3, AC-8.5).
 * Register inside the guarded scope.
 *
 * Every write here is an owner edit, so none of them is undoable (§6.6): the events carry
 * `undoable: false`. Edits do not take the intake lock and are guarded by `version`
 * (`409 version_conflict` with the current record as `current`); that includes a change of
 * company (found or created without the lock, retried once on a unique violation) and *Mark
 * followed up* (a flag-guarded update and one atomic counter statement). Two things do take the
 * lock: adding an application (intake, §7.1: it matches and creates companies like the pipeline)
 * and merging (messages, events and threads the pipeline also writes move).
 */

export { toApplicationSummary } from "./interviews.js";

type Tx = Prisma.TransactionClient;
type Db = PrismaClient | Tx;

// --- queries ---------------------------------------------------------------------------------------

export const APPLICATIONS_DEFAULT_LIMIT = 50;
export const APPLICATIONS_MAX_LIMIT = 200;

const SortSchema = z.enum(["last_activity", "applied", "status"]);
type Sort = z.infer<typeof SortSchema>;

/**
 * `status` repeats (`status=a&status=b`, what the web sends) or carries brackets (`status[]=a`,
 * the spelling in the spec); one value arrives as a string, several as an array.
 */
function statusValues(query: Record<string, unknown>): unknown[] {
  return ["status", "status[]"].flatMap((key) => {
    const value = query[key];
    if (value === undefined) return [];
    return Array.isArray(value) ? (value as unknown[]) : [value];
  });
}

const ApplicationsQuerySchema = z.object({
  status: z.array(ApplicationStatusSchema),
  followUpDue: z.enum(["true", "false"]).optional(),
  q: z.string().optional(),
  sort: SortSchema.default("last_activity"),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(APPLICATIONS_MAX_LIMIT)
    .default(APPLICATIONS_DEFAULT_LIMIT),
  cursor: z.string().min(1).optional(),
});
type ApplicationsQuery = z.infer<typeof ApplicationsQuerySchema>;

function parseQuery(raw: unknown): ApplicationsQuery {
  const query = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return ApplicationsQuerySchema.parse({ ...query, status: statusValues(query) });
}

/** Where a page stopped: the sort it was made for, the row's keys `r` and `t`, and its id. */
const CursorSchema = z.object({
  s: SortSchema,
  r: z.number().int(),
  t: z.iso.datetime(),
  id: z.uuid(),
});
type Cursor = z.infer<typeof CursorSchema>;

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(raw: string, sort: Sort): Cursor {
  const invalid = () =>
    new ApiError(400, "validation_failed", "The cursor is not valid.", { cursor: "invalid" });
  try {
    const parsed = CursorSchema.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    if (parsed.s !== sort) throw invalid();
    return parsed;
  } catch {
    throw invalid();
  }
}

/** The pipeline's order, as a number: Applied first, Abandoned last. */
const STATUS_RANK_SQL = Prisma.sql`(CASE a.status::text ${Prisma.join(
  ApplicationStatusSchema.options.map(
    (status, index) => Prisma.sql`WHEN ${status} THEN ${index}::int`,
  ),
  " ",
)} END)`;
/** Last activity: the company's last sign of life, else when the owner applied, else when it was added. */
const ACTIVITY_SQL = Prisma.sql`coalesce(a.last_company_activity_at, a.applied_at, a.created_at)`;

/**
 * Every sort is the same shape, `(r, t, id)` descending, so one keyset comparison pages them all:
 * - last activity: `r` is 0 and `t` the activity time;
 * - applied date: `r` is 0 and `t` the applied date (none sorts last, as the epoch);
 * - status: `r` is minus the status rank (so Applied comes first) and `t` the activity time.
 */
function sortKeys(sort: Sort): { r: Prisma.Sql; t: Prisma.Sql } {
  switch (sort) {
    case "last_activity":
      return { r: Prisma.sql`0`, t: ACTIVITY_SQL };
    case "applied":
      return { r: Prisma.sql`0`, t: Prisma.sql`coalesce(a.applied_at, 'epoch'::timestamptz)` };
    case "status":
      return { r: Prisma.sql`(-${STATUS_RANK_SQL})`, t: ACTIVITY_SQL };
  }
}

/** `%` and `_` in the search text are letters, not wildcards. */
const likePattern = (text: string): string => `%${text.replace(/[\\%_]/g, "\\$&")}%`;

async function listApplications(
  prisma: PrismaClient,
  query: ApplicationsQuery,
  now: Date,
): Promise<Page<ApplicationSummary>> {
  const after = query.cursor === undefined ? null : decodeCursor(query.cursor, query.sort);
  const { r, t } = sortKeys(query.sort);

  const filters: Prisma.Sql[] = [];
  if (query.status.length > 0) {
    filters.push(Prisma.sql`a.status::text IN (${Prisma.join(query.status)})`);
  }
  if (query.followUpDue === "true") filters.push(Prisma.sql`a.follow_up_due`);
  const text = query.q?.trim() ?? "";
  if (text !== "") {
    const pattern = likePattern(text);
    filters.push(
      Prisma.sql`(c.name ILIKE ${pattern} ESCAPE '\\' OR a.title ILIKE ${pattern} ESCAPE '\\')`,
    );
  }
  if (after) {
    filters.push(Prisma.sql`(${r}, ${t}, a.id)
      < (${after.r}::int, ${new Date(after.t)}::timestamptz, ${after.id}::uuid)`);
  }
  const where =
    filters.length === 0 ? Prisma.empty : Prisma.sql`WHERE ${Prisma.join(filters, " AND ")}`;

  const keys = await prisma.$queryRaw<{ id: string; r: number; t: Date }[]>`
    SELECT a.id::text AS id, ${r}::int AS r, ${t} AS t
    FROM application a JOIN company c ON c.id = a.company_id
    ${where}
    ORDER BY r DESC, t DESC, a.id DESC
    LIMIT ${query.limit + 1}`;

  const pageOfKeys = keys.slice(0, query.limit);
  const last = pageOfKeys.at(-1);
  const nextCursor =
    keys.length > query.limit && last
      ? encodeCursor({ s: query.sort, r: last.r, t: last.t.toISOString(), id: last.id })
      : null;

  const rows = await prisma.application.findMany({
    where: { id: { in: pageOfKeys.map((k) => k.id) } },
    include: { company: { select: { id: true, name: true } } },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const next = await nextInterviewAtByApplication(prisma, [...byId.keys()], now);

  const items: ApplicationSummary[] = [];
  for (const { id } of pageOfKeys) {
    const row = byId.get(id);
    if (row) items.push(toApplicationSummary(row, next.get(id) ?? null));
  }
  return { items, nextCursor };
}

// --- detail ----------------------------------------------------------------------------------------

const iso = (date: Date): string => date.toISOString();

/** The detail's emails: the content columns stay behind `GET /messages/:id`. */
function toMessageSummary(row: {
  id: string;
  internalDate: Date;
  direction: MessageSummary["direction"];
  fromName: string | null;
  fromEmail: string | null;
  subject: string | null;
  summary: string | null;
  category: MessageSummary["category"];
}): MessageSummary {
  return {
    id: row.id,
    internalDate: iso(row.internalDate),
    direction: row.direction,
    fromName: row.fromName,
    fromEmail: row.fromEmail,
    subject: row.subject,
    summary: row.summary,
    category: row.category,
  };
}

/** To schedule first (they have no time), then by start time. */
function byStart<T extends { startsAt: Date | null; createdAt: Date }>(a: T, b: T): number {
  if (a.startsAt === null || b.startsAt === null) {
    if (a.startsAt === b.startsAt) return a.createdAt.getTime() - b.createdAt.getTime();
    return a.startsAt === null ? -1 : 1;
  }
  return a.startsAt.getTime() - b.startsAt.getTime();
}

/**
 * The application with its interviews, emails and timeline (AC-6.2). The timeline is newest
 * first, and the emails are newest first by `internal_date`. `nextInterviewAt` is the earliest
 * `scheduled` interview that starts at `now` or later. Throws 404 for an unknown id.
 */
export async function getApplicationDetail(
  db: Db,
  id: string,
  now: Date = new Date(),
): Promise<ApplicationDetail> {
  assertId(id, "application");
  const row = await db.application.findUnique({
    where: { id },
    include: {
      company: { select: { id: true, name: true } },
      events: true,
      interviews: true,
      messages: { orderBy: [{ internalDate: "desc" }, { id: "desc" }] },
    },
  });
  if (row === null) throw new ApiError(404, "not_found", "No such application.");

  const upcoming = row.interviews
    .filter((i) => i.status === "scheduled" && i.startsAt !== null && i.startsAt >= now)
    .map((i) => i.startsAt as Date);
  const nextInterviewAt =
    upcoming.length === 0 ? null : new Date(Math.min(...upcoming.map((d) => d.getTime())));

  // The timeline (with each event's `toStatus`) is the lead mapper's; this reader adds what a
  // freshly converted application doesn't have yet.
  const base = newApplicationDetail(row);
  return {
    ...base,
    nextInterviewAt: nextInterviewAt === null ? null : iso(nextInterviewAt),
    interviews: [...row.interviews].sort(byStart).map(toInterview),
    messages: row.messages.map(toMessageSummary),
    timeline: sortTimeline(base.timeline, row.events).map((entry) =>
      // An `abandoned` event is always a move to Abandoned, even from a writer that left the key out.
      entry.type === "abandoned" && entry.toStatus === null
        ? { ...entry, toStatus: "abandoned" as const }
        : entry,
    ),
  };
}

/** Newest first; events with the same time keep the order they were written in, latest first. */
function sortTimeline(
  timeline: ApplicationDetail["timeline"],
  events: EventRow[],
): ApplicationDetail["timeline"] {
  const created = new Map(events.map((e) => [e.id, e.createdAt.getTime()]));
  return [...timeline].sort(
    (a, b) =>
      new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime() ||
      (created.get(b.id) ?? 0) - (created.get(a.id) ?? 0),
  );
}

// --- companies ---------------------------------------------------------------------------------------

/**
 * The company an owner typed (TECHNICAL_SPEC §6.2 rule 4): the one whose normalised name equals
 * the typed name's, else the one that lists it as an alias, else a new company. Creating a
 * manual application runs it under the intake lock; an owner edit runs it without
 * ({@link resolveCompanyForOwner}).
 */
async function resolveCompany(tx: Db, name: string, now: Date): Promise<Company> {
  const clean = name.trim();
  const normalizedName = normalizeCompanyName(clean);
  if (normalizedName === "") {
    throw new ApiError(400, "validation_failed", "Enter a company name.", {
      companyName: "required",
    });
  }
  const known =
    (await tx.company.findUnique({ where: { normalizedName } })) ??
    (await tx.company.findFirst({ where: { aliases: { has: normalizedName } } }));
  if (known) return known;
  return tx.company.create({
    data: { name: clean, normalizedName, createdSource: "manual", createdAt: now, updatedAt: now },
  });
}

/**
 * {@link resolveCompany} for an owner edit, which does not take the intake lock (§6.8). If another
 * writer creates the same company between the read and the insert, the unique index on the
 * normalised name refuses the insert (P2002): the company is read again and that row is used.
 */
export async function resolveCompanyForOwner(
  prisma: PrismaClient,
  name: string,
  now: Date,
): Promise<Company> {
  try {
    return await resolveCompany(prisma, name, now);
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
      throw error;
    }
    return resolveCompany(prisma, name, now);
  }
}

/** The posting's job key, unless another application already has it (the key is unique). */
async function freeJobKey(
  tx: Db,
  url: string | null,
  selfId: string | null,
): Promise<string | null> {
  const key = url === null ? null : jobKey(url);
  if (key === null) return null;
  const owner = await tx.application.findFirst({ where: { jobKey: key }, select: { id: true } });
  return owner === null || owner.id === selfId ? key : null;
}

// --- version conflicts ------------------------------------------------------------------------------

/** A stale `version`, or a guarded write that matched nothing: the record changed elsewhere. */
class StaleApplication extends Error {
  constructor() {
    super("stale");
  }
}

async function sendConflict(deps: AppDeps, reply: FastifyReply, id: string): Promise<FastifyReply> {
  const current = await getApplicationDetail(deps.prisma, id, deps.clock());
  // TECHNICAL_SPEC §10: "409 version_conflict with the current record". The envelope keeps its
  // shape; the record rides next to it as `current`, which the web refreshes from.
  return reply.code(API_ERROR_STATUS.version_conflict).send({
    ...errorBody(
      "version_conflict",
      "This application was changed elsewhere. Showing the latest version.",
    ),
    current,
  });
}

// --- create ------------------------------------------------------------------------------------------

const STATUS_LABEL: Record<ApplicationStatus, string> = {
  applied: "Applied",
  screening: "Screening",
  assessment: "Assessment",
  interviewing: "Interviewing",
  offer: "Offer",
  accepted: "Accepted",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
  abandoned: "Abandoned",
};

/** The statuses the timers watch; any other status has nothing to follow up. */
const TIMED_STATUSES: readonly ApplicationStatus[] = [
  "applied",
  "screening",
  "assessment",
  "interviewing",
];

async function createApplication(deps: AppDeps, body: ApplicationCreate): Promise<string> {
  const now = deps.clock();
  return withIntakeLock(deps.prisma, async (tx) => {
    const company = await resolveCompany(tx, body.companyName, now);
    const row = await tx.application.create({
      data: {
        companyId: company.id,
        title: body.title.trim(),
        jobUrl: body.jobUrl,
        jobKey: await freeJobKey(tx, body.jobUrl, null),
        status: body.status,
        statusChangedAt: now,
        appliedAt: body.appliedAt === null ? null : new Date(body.appliedAt),
        notes: body.notes,
        source: "manual",
        createdAt: now,
        updatedAt: now,
      },
    });
    await writeEvent(tx, {
      applicationId: row.id,
      companyId: company.id,
      type: "application_created",
      actor: "owner",
      occurredAt: now,
      summary: `Added by hand: ${STATUS_LABEL[body.status]}`,
      data: { toStatus: body.status },
      undoable: false,
    });
    return row.id;
  });
}

// --- patch -------------------------------------------------------------------------------------------

/** What each plain field is called in a timeline entry; values are never written there. */
const FIELD_LABEL = {
  title: "role",
  jobUrl: "job link",
  appliedAt: "applied date",
  locationText: "location",
  country: "country",
  workMode: "work mode",
  compensationText: "compensation",
  sponsorshipText: "sponsorship",
  notes: "notes",
} as const;
type PlainField = keyof typeof FIELD_LABEL;
const PLAIN_FIELDS = Object.keys(FIELD_LABEL) as PlainField[];

const sameValue = (a: unknown, b: unknown): boolean =>
  a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;

/** The plain fields of the patch that differ from the stored row, as new column values. */
function plainChanges(
  row: Application,
  patch: ApplicationPatch,
): Partial<Record<PlainField, unknown>> {
  const changes: Partial<Record<PlainField, unknown>> = {};
  for (const field of PLAIN_FIELDS) {
    const wanted = patch[field];
    if (wanted === undefined) continue;
    const value = field === "appliedAt" ? (wanted === null ? null : new Date(wanted)) : wanted;
    if (!sameValue(row[field], value)) changes[field] = value;
  }
  return changes;
}

async function patchApplication(deps: AppDeps, id: string, patch: ApplicationPatch): Promise<void> {
  const now = deps.clock();
  // The company is found or created before the transaction, without the lock: a unique violation
  // inside a transaction would abort it.
  const company =
    patch.companyName === undefined
      ? null
      : await resolveCompanyForOwner(deps.prisma, patch.companyName, now);
  await deps.prisma.$transaction(async (tx) => {
    const row = await tx.application.findUnique({ where: { id } });
    if (row === null) throw new ApiError(404, "not_found", "No such application.");
    if (row.version !== patch.version) throw new StaleApplication();

    const data: Prisma.ApplicationUncheckedUpdateManyInput = {};
    const changes = plainChanges(row, patch);
    Object.assign(data, changes);

    // The company: by name, as when an application is added.
    let companyId: string | null = null;
    if (company !== null && company.id !== row.companyId) {
      data.companyId = company.id;
      companyId = company.id;
    }
    if ("jobUrl" in changes) {
      data.jobKey = await freeJobKey(tx, changes.jobUrl as string | null, id);
    }

    // A manual status change ignores the transition table (AC-6.3).
    const status = patch.status;
    const statusChanged = status !== undefined && status !== row.status;
    if (statusChanged) {
      data.status = status;
      data.statusChangedAt = now;
      // Abandoned remembers where it came from so a reply can restore it; leaving it forgets.
      if (status === "abandoned") data.statusBeforeAbandon = row.status;
      else if (row.status === "abandoned") data.statusBeforeAbandon = null;
      if (!TIMED_STATUSES.includes(status)) {
        data.followUpDue = false;
        data.followUpDueSince = null;
      }
    }

    if (Object.keys(data).length === 0) return;

    const { count } = await tx.application.updateMany({
      where: { id, version: row.version },
      data: { ...data, version: { increment: 1 }, updatedAt: now },
    });
    if (count === 0) throw new StaleApplication();

    const owner = {
      applicationId: id,
      companyId: companyId ?? row.companyId,
      actor: "owner" as const,
    };
    if (statusChanged) {
      await writeEvent(tx, {
        ...owner,
        type: "status_changed",
        occurredAt: now,
        summary: `Status changed to ${STATUS_LABEL[status]}`,
        data: { fromStatus: row.status, toStatus: status },
        undoable: false,
      });
    }
    const fields = Object.keys(changes) as PlainField[];
    const touched = [
      ...fields.map((f) => FIELD_LABEL[f]),
      ...(companyId === null ? [] : ["company"]),
    ];
    if (touched.length > 0) {
      const notesOnly = fields.length === 1 && fields[0] === "notes" && companyId === null;
      await writeEvent(tx, {
        ...owner,
        type: notesOnly ? "note_updated" : "field_updated",
        occurredAt: now,
        summary: notesOnly ? "Notes updated" : `Updated ${touched.join(", ")}`,
        // Which fields changed, never their values: notes and pay stay out of the timeline.
        data: { fields: [...fields, ...(companyId === null ? [] : ["companyName"])] },
        undoable: false,
      });
    }
  });
}

// --- follow-up done ----------------------------------------------------------------------------------

/**
 * *Mark followed up* (AC-7.3): clears the flag, stamps `follow_up_done_at` and counts one follow-up
 * on the owner's local day. An application that isn't due has nothing to record, so a second tap
 * changes and counts nothing.
 */
async function markFollowedUp(deps: AppDeps, id: string): Promise<void> {
  const now = deps.clock();
  const day = ownerLocalDay(now, deps.env.userTimezone);
  await deps.prisma.$transaction(async (tx) => {
    const row = await tx.application.findUnique({ where: { id } });
    if (row === null) throw new ApiError(404, "not_found", "No such application.");
    if (!row.followUpDue) return;

    // Guarded by the flag itself: of two taps that arrive together only one matches, so only one
    // is counted.
    const { count } = await tx.application.updateMany({
      where: { id, followUpDue: true },
      data: {
        followUpDue: false,
        followUpDueSince: null,
        followUpDoneAt: now,
        version: { increment: 1 },
        updatedAt: now,
      },
    });
    if (count === 0) return;
    // One statement, so it can't lose a count written by the pipeline or another tap.
    await tx.$executeRaw`
      INSERT INTO daily_activity (day, follow_ups, updated_at)
      VALUES (${dayColumn(day)}::date, 1, ${now})
      ON CONFLICT (day) DO UPDATE SET
        follow_ups = daily_activity.follow_ups + 1, updated_at = EXCLUDED.updated_at`;
    await writeEvent(tx, {
      applicationId: id,
      companyId: row.companyId,
      type: "follow_up_done",
      actor: "owner",
      occurredAt: now,
      summary: "Marked as followed up",
      data: { day },
      undoable: false,
    });
  });
}

// --- add an interview --------------------------------------------------------------------------------

async function createInterview(
  deps: AppDeps,
  applicationId: string,
  body: z.infer<typeof InterviewCreateSchema>,
): Promise<Interview> {
  const now = deps.clock();
  const startsAt = body.startsAt === null ? null : new Date(body.startsAt);
  const endsAt = body.endsAt === null ? null : new Date(body.endsAt);
  assertInterviewTimes({ status: body.status, startsAt, endsAt });

  return deps.prisma.$transaction(async (tx) => {
    const application = await tx.application.findUnique({
      where: { id: applicationId },
      select: { companyId: true },
    });
    if (application === null) throw new ApiError(404, "not_found", "No such application.");
    const row = await tx.interview.create({
      data: {
        applicationId,
        kind: body.kind,
        status: body.status,
        startsAt,
        endsAt,
        meetingUrl: body.meetingUrl,
        location: body.location,
        interviewers: body.interviewers,
        notes: body.notes,
        createdAt: now,
        updatedAt: now,
      },
    });
    const when =
      startsAt === null
        ? null
        : DateTime.fromJSDate(startsAt, { zone: deps.env.userTimezone })
            .setLocale("en-US")
            .toFormat("ccc, LLL d, HH:mm");
    await writeEvent(tx, {
      applicationId,
      companyId: application.companyId,
      type: "interview_created",
      actor: "owner",
      occurredAt: now,
      summary: when === null ? "Interview to schedule" : `Interview scheduled for ${when}`,
      // Prep notes are never quoted in the timeline.
      data: { interviewId: row.id },
      undoable: false,
    });
    return toInterview(row);
  });
}

// --- merge -------------------------------------------------------------------------------------------

const later = (a: Date | null, b: Date | null): Date | null =>
  a === null ? b : b === null ? a : a.getTime() >= b.getTime() ? a : b;

/**
 * Folds `sourceId` into `targetId` (AC-6.5; Should): emails, interviews, threads, review items and
 * timeline entries move to the target and the source is deleted. The target keeps its own fields,
 * fills the ones it lacks from the source, and takes the later company activity. The source's lead
 * goes back to `shortlisted` with no application (§6.6). The moved events can no longer be undone,
 * because the records their change sets name are gone. Runs under the intake lock.
 */
async function mergeApplications(deps: AppDeps, sourceId: string, targetId: string): Promise<void> {
  const now = deps.clock();
  await withIntakeLock(deps.prisma, async (tx) => {
    const [source, target] = await Promise.all([
      tx.application.findUnique({ where: { id: sourceId }, include: { company: true } }),
      tx.application.findUnique({ where: { id: targetId } }),
    ]);
    if (source === null) throw new ApiError(404, "not_found", "No such application.");
    if (target === null) {
      throw new ApiError(404, "not_found", "No such application to merge into.", {
        intoId: "not_found",
      });
    }

    // The idempotency index allows one (message, type) event per application: a source event that
    // would repeat one of the target's keeps its place in the timeline but gives up its message.
    await tx.$executeRaw`
      UPDATE event e SET message_id = NULL
      WHERE e.application_id = ${sourceId}::uuid AND e.message_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM event t
                    WHERE t.application_id = ${targetId}::uuid
                      AND t.message_id = e.message_id AND t.type = e.type)`;
    await tx.event.updateMany({
      where: { applicationId: sourceId },
      data: { applicationId: targetId, undoable: false },
    });
    await tx.gmailMessage.updateMany({
      where: { applicationId: sourceId },
      data: { applicationId: targetId },
    });
    await tx.interview.updateMany({
      where: { applicationId: sourceId },
      data: { applicationId: targetId },
    });
    await tx.threadLink.updateMany({
      where: { applicationId: sourceId },
      data: { applicationId: targetId },
    });
    await tx.reviewItem.updateMany({
      where: { applicationId: sourceId },
      data: { applicationId: targetId },
    });

    // The source's lead: back to shortlisted, pointing at nothing.
    const leadMatches: Prisma.LeadWhereInput[] = [{ applicationId: sourceId }];
    if (source.leadId !== null) leadMatches.push({ id: source.leadId });
    await tx.lead.updateMany({
      where: { OR: leadMatches },
      data: {
        status: "shortlisted",
        statusChangedAt: now,
        applicationId: null,
        version: { increment: 1 },
        updatedAt: now,
      },
    });

    const notes =
      source.notes === null || source.notes === target.notes
        ? target.notes
        : target.notes === null
          ? source.notes
          : `${target.notes}\n\n${source.notes}`;
    const appliedAt =
      source.appliedAt !== null && target.appliedAt !== null
        ? source.appliedAt.getTime() < target.appliedAt.getTime()
          ? source.appliedAt
          : target.appliedAt
        : (target.appliedAt ?? source.appliedAt);
    await tx.application.delete({ where: { id: sourceId } });
    await tx.application.update({
      where: { id: targetId },
      data: {
        notes,
        appliedAt,
        jobUrl: target.jobUrl ?? source.jobUrl,
        jobKey: target.jobKey ?? source.jobKey,
        locationText: target.locationText ?? source.locationText,
        country: target.country ?? source.country,
        workMode: target.workMode === "unknown" ? source.workMode : target.workMode,
        compensationText: target.compensationText ?? source.compensationText,
        sponsorshipText: target.sponsorshipText ?? source.sponsorshipText,
        lastCompanyActivityAt: later(target.lastCompanyActivityAt, source.lastCompanyActivityAt),
        lastOutboundAt: later(target.lastOutboundAt, source.lastOutboundAt),
        version: { increment: 1 },
        updatedAt: now,
      },
    });
    await writeEvent(tx, {
      applicationId: targetId,
      companyId: target.companyId,
      type: "merged",
      actor: "owner",
      occurredAt: now,
      summary: `Merged with ${source.title} at ${source.company.name}`,
      data: { toStatus: target.status, mergedFromTitle: source.title },
      undoable: false,
    });
  });
}

// --- routes ------------------------------------------------------------------------------------------

export function registerApplicationRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/applications", async (request): Promise<Page<ApplicationSummary>> => {
    return listApplications(deps.prisma, parseQuery(request.query), deps.clock());
  });

  app.post("/applications", async (request, reply) => {
    const body = ApplicationCreateSchema.parse(request.body);
    const id = await createApplication(deps, body);
    const detail: ApplicationDetail = await getApplicationDetail(deps.prisma, id, deps.clock());
    return reply.code(201).send(detail);
  });

  app.get<{ Params: { id: string } }>("/applications/:id", (request): Promise<ApplicationDetail> =>
    getApplicationDetail(deps.prisma, request.params.id, deps.clock()),
  );

  app.patch<{ Params: { id: string } }>("/applications/:id", async (request, reply) => {
    const { id } = request.params;
    assertId(id, "application");
    const patch = ApplicationPatchSchema.parse(request.body);
    try {
      await patchApplication(deps, id, patch);
    } catch (error) {
      if (error instanceof StaleApplication) return sendConflict(deps, reply, id);
      throw error;
    }
    return getApplicationDetail(deps.prisma, id, deps.clock());
  });

  app.post<{ Params: { id: string } }>("/applications/:id/follow-up-done", async (request) => {
    const { id } = request.params;
    assertId(id, "application");
    await markFollowedUp(deps, id);
    return getApplicationDetail(deps.prisma, id, deps.clock());
  });

  app.post<{ Params: { id: string } }>("/applications/:id/interviews", async (request, reply) => {
    const { id } = request.params;
    assertId(id, "application");
    const body = InterviewCreateSchema.parse(request.body);
    const interview = await createInterview(deps, id, body);
    return reply.code(201).send(interview);
  });

  app.post<{ Params: { id: string } }>("/applications/:id/merge", async (request) => {
    const { id } = request.params;
    assertId(id, "application");
    const { intoId } = ApplicationMergeSchema.parse(request.body);
    if (intoId === id) {
      throw new ApiError(400, "validation_failed", "Pick a different application to merge into.", {
        intoId: "same_application",
      });
    }
    assertId(intoId, "application");
    await mergeApplications(deps, id, intoId);
    return getApplicationDetail(deps.prisma, intoId, deps.clock());
  });
}
