import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import {
  LeadSortSchema,
  type Lead as LeadDto,
  type LeadCreate,
  type LeadPatch,
  type LeadsQuery,
  type Page,
} from "@offerbound/contracts";
import type { IncomingLead } from "@offerbound/domain";
import type { AppDeps } from "../deps.js";
import { withIntakeLock } from "../db/lock.js";
import { ApiError } from "../http/errors.js";
import { QUEUES } from "../jobs/queues.js";
import { getSettings } from "../settings/service.js";
import { LEAD_INCLUDE, newApplicationDetail, toLeadDto } from "./dto.js";
import { enqueueLeadChecks, ingestLeads } from "./intake.js";

/**
 * What the owner does to leads from the Leads page (TECHNICAL_SPEC §10.1, AC-9.2, AC-9.6, AC-9.7,
 * AC-11.4, AC-12.4). The routes in `routes/leads.ts` are thin wrappers around these.
 */

export type LeadActionCtx = Pick<AppDeps, "prisma" | "queue" | "clock"> & {
  log?: { error: (obj: Record<string, unknown>, msg: string) => void };
};

/**
 * A 409 `version_conflict` that carries the record as it is now. The route sends it as
 * `{ error, current }` (TECHNICAL_SPEC §10); a handler that forgets to catch it still answers with
 * the plain envelope.
 */
export class VersionConflictError<T> extends ApiError {
  constructor(
    readonly current: T,
    message = "This was changed elsewhere. Showing the latest version.",
  ) {
    super(409, "version_conflict", message);
    this.name = "VersionConflictError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Rejects a path id that cannot be a uuid before the database sees it. */
export function assertId(id: string, what: string): void {
  if (!UUID.test(id)) throw new ApiError(404, "not_found", `No such ${what}.`);
}

const notFound = () => new ApiError(404, "not_found", "No such lead.");

type Db = Prisma.TransactionClient | PrismaClient;

/** A lead the owner can act on: leads still being checked or ranked are not shown anywhere yet. */
async function loadActionable(db: Db, id: string) {
  assertId(id, "lead");
  const row = await db.lead.findUnique({ where: { id }, include: LEAD_INCLUDE });
  if (row === null || row.pipelineState !== "ready") throw notFound();
  return row;
}

// --- list ---------------------------------------------------------------------------------------

/** Track priority of a lead whose track is not (or no longer) configured: after every real one. */
const NO_TRACK_RANK = 1000;

const CursorSchema = z.object({
  /** The sort the cursor was made for. */
  s: LeadSortSchema,
  /** Track rank, fit key and found date of the last row of the page (`r` and `f` only for track_fit). */
  r: z.number().int(),
  f: z.number().int(),
  t: z.iso.datetime(),
  i: z.uuid(),
});
type Cursor = z.infer<typeof CursorSchema>;

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(raw: string, sort: LeadsQuery["sort"]): Cursor {
  const invalid = (reason: string) =>
    new ApiError(400, "validation_failed", "The cursor is not valid.", { cursor: reason });
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw invalid("invalid");
  }
  const result = CursorSchema.safeParse(parsed);
  if (!result.success) throw invalid("invalid");
  if (result.data.s !== sort) throw invalid("wrong_sort");
  return result.data;
}

/** `%` and `_` in the owner's search text are letters, not wildcards. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, "\\$&")}%`;
}

type ListedKey = { id: string; rank: number; fit: number; foundAt: Date };

/**
 * `GET /leads`: ready leads only (AC-9.8: a lead is listed after its link check and ranking),
 * filtered by status, track and a search on company or title. Two orders (AC-12.4):
 * `track_fit` is track priority (the owner's configured priorities; no track last), fit score
 * descending (unranked last), then found date newest; `newest` is found date then id, both
 * descending. The id always breaks ties, so a cursor never skips or repeats a row.
 */
export async function listLeads(prisma: PrismaClient, query: LeadsQuery): Promise<Page<LeadDto>> {
  const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor, query.sort);

  const { tracks } = (await getSettings(prisma)).search;
  const rankExpr =
    tracks.length === 0
      ? Prisma.sql`${NO_TRACK_RANK}::int`
      : Prisma.sql`case l.track ${Prisma.join(
          tracks.map((t) => Prisma.sql`when ${t.key} then ${t.priority}::int`),
          " ",
        )} else ${NO_TRACK_RANK}::int end`;
  const fitExpr = Prisma.sql`coalesce(l.fit_score, -1)::int`;

  const where: Prisma.Sql[] = [Prisma.sql`l.pipeline_state = 'ready'`];
  if (query.status !== undefined) where.push(Prisma.sql`l.status = ${query.status}::lead_status`);
  if (query.track !== undefined) where.push(Prisma.sql`l.track = ${query.track}`);
  if (query.q !== undefined) {
    const pattern = likePattern(query.q);
    where.push(
      Prisma.sql`(c.name ilike ${pattern} escape '\\' or l.title ilike ${pattern} escape '\\')`,
    );
  }
  if (cursor !== null) {
    const at = new Date(cursor.t);
    where.push(
      query.sort === "newest"
        ? Prisma.sql`(l.found_at < ${at} or (l.found_at = ${at} and l.id < ${cursor.i}::uuid))`
        : Prisma.sql`(${rankExpr} > ${cursor.r}::int
            or (${rankExpr} = ${cursor.r}::int and (${fitExpr} < ${cursor.f}::int
              or (${fitExpr} = ${cursor.f}::int and (l.found_at < ${at}
                or (l.found_at = ${at} and l.id < ${cursor.i}::uuid))))))`,
    );
  }
  const order =
    query.sort === "newest"
      ? Prisma.sql`l.found_at desc, l.id desc`
      : Prisma.sql`${rankExpr} asc, ${fitExpr} desc, l.found_at desc, l.id desc`;

  const keys = await prisma.$queryRaw<ListedKey[]>`
    select l.id::text as id, ${rankExpr} as rank, ${fitExpr} as fit, l.found_at as "foundAt"
    from lead l join company c on c.id = l.company_id
    where ${Prisma.join(where, " and ")}
    order by ${order}
    limit ${query.limit + 1}`;

  const pageKeys = keys.slice(0, query.limit);
  const rows = await prisma.lead.findMany({
    where: { id: { in: pageKeys.map((k) => k.id) } },
    include: LEAD_INCLUDE,
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const items = pageKeys.flatMap((k) => {
    const row = byId.get(k.id);
    return row === undefined ? [] : [toLeadDto(row)];
  });

  const last = pageKeys[pageKeys.length - 1];
  const nextCursor =
    keys.length > query.limit && last !== undefined
      ? encodeCursor({
          s: query.sort,
          r: query.sort === "newest" ? 0 : Number(last.rank),
          f: query.sort === "newest" ? 0 : Number(last.fit),
          t: last.foundAt.toISOString(),
          i: last.id,
        })
      : null;
  return { items, nextCursor };
}

// --- create -------------------------------------------------------------------------------------

/**
 * `POST /leads`: a lead the owner typed in. It goes through the same intake as every other lead,
 * in a `manual` batch, which skips the company-seen rule and finalize (AC-9.3); the link check and
 * ranking follow like for any lead. A posting that is already a lead or an application is refused.
 */
export async function createManualLead(ctx: LeadActionCtx, input: LeadCreate): Promise<LeadDto> {
  const now = ctx.clock();
  const incoming: IncomingLead = {
    ref: "manual",
    order: 0,
    source: "manual",
    companyName: input.companyName,
    companyDomain: null,
    title: input.title,
    jobUrl: input.jobUrl,
    locationText: input.locationText,
    country: input.country,
    workMode: input.workMode,
    compensationText: input.compensationText,
    sponsorshipText: null,
    postedAt: null,
    seniority: null,
    ranking: null,
    verification: null,
    pageExcerpt: null,
    sheetStatus: null,
    notes: input.notes,
    contactEmail: null,
  };

  const result = await withIntakeLock(ctx.prisma, async (tx) => {
    const settings = await getSettings(tx);
    const ingested = await ingestLeads(tx, { kind: "manual" }, [incoming], { settings, now });
    const leadId = ingested.leadIds[0];
    if (leadId === undefined) {
      // Throwing rolls the batch back with it.
      throw new ApiError(400, "validation_failed", "That posting is already in Offerbound.", {
        [input.jobUrl === null ? "title" : "jobUrl"]: "already_exists",
      });
    }
    const lead = await tx.lead.findUniqueOrThrow({ where: { id: leadId } });
    await tx.event.create({
      data: {
        leadId,
        companyId: lead.companyId,
        type: "lead_created",
        actor: "owner",
        occurredAt: now,
        summary: "Added manually",
        data: { source: "manual", status: lead.status },
        undoable: false,
      },
    });
    return ingested;
  });

  // After the commit, so the worker finds the lead. A send that fails is picked up by the sweep.
  await enqueueLeadChecks(ctx.queue, result, ctx.log);
  const [leadId] = result.leadIds;
  const row = await ctx.prisma.lead.findUniqueOrThrow({
    where: { id: leadId ?? "" },
    include: LEAD_INCLUDE,
  });
  return toLeadDto(row);
}

// --- patch --------------------------------------------------------------------------------------

/**
 * `PATCH /leads/:id`: shortlist, dismiss (with a reason), put back to New (also from Dismissed),
 * or edit notes. An owner edit: no lock, the `version` guards it. A converted lead is final here
 * (409 with the lead as it is); a suppressed lead comes back through *Reconsider*.
 */
export async function patchLead(ctx: LeadActionCtx, id: string, body: LeadPatch): Promise<LeadDto> {
  const now = ctx.clock();
  const lead = await loadActionable(ctx.prisma, id);
  if (lead.version !== body.version) throw new VersionConflictError(toLeadDto(lead));

  const data: Prisma.LeadUncheckedUpdateManyInput = {};
  const target = body.status ?? lead.status;
  if (body.status !== undefined && body.status !== lead.status) {
    if (lead.status === "applied") throw new VersionConflictError(toLeadDto(lead));
    if (lead.status === "suppressed") {
      throw new ApiError(400, "validation_failed", "Use Reconsider for a suppressed lead.", {
        status: "use_reconsider",
      });
    }
    data.status = body.status;
    data.statusChangedAt = now;
    data.dismissedReason = null;
  }
  if (body.dismissedReason !== undefined) {
    if (target !== "dismissed") {
      throw new ApiError(400, "validation_failed", "A reason only goes with a dismissed lead.", {
        dismissedReason: "only_when_dismissed",
      });
    }
    data.dismissedReason = body.dismissedReason.trim() === "" ? null : body.dismissedReason.trim();
  }
  if (body.notes !== undefined) {
    data.notes = body.notes === null || body.notes.trim() === "" ? null : body.notes;
  }
  if (Object.keys(data).length === 0) return toLeadDto(lead);

  const { count } = await ctx.prisma.lead.updateMany({
    where: { id, version: body.version },
    data: { ...data, updatedAt: now, version: { increment: 1 } },
  });
  const fresh = await ctx.prisma.lead.findUniqueOrThrow({ where: { id }, include: LEAD_INCLUDE });
  if (count === 0) throw new VersionConflictError(toLeadDto(fresh));
  return toLeadDto(fresh);
}

// --- mark applied -------------------------------------------------------------------------------

/**
 * One record an event changed, in the form undo reads (TECHNICAL_SPEC §6.5, §6.6): `before` is
 * null for a record the event created, `versionAfter` is the record's version after the change
 * (null where the table has none).
 */
export type ChangeSetEntry = {
  entity: "application" | "lead" | "thread_link";
  id: string;
  created: boolean;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  versionAfter: number | null;
};

/** The stored form of a row the change created: what was written, without bookkeeping columns. */
function createdAfter(row: object): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...row };
  for (const column of ["version", "createdAt", "updatedAt"]) delete rest[column];
  return rest;
}

/**
 * *Mark applied* (AC-9.6): converts a lead into an application with status `applied`, applied
 * `now`, source `lead_conversion`, and links both ways. Under the intake lock. Writes one
 * `lead_converted` event on the application's timeline, and it is undoable: its change set holds
 * the application it created (undo deletes it) and the lead as it was (status, status date,
 * application id, suppressed and dismissed reasons), so undo can restore the lead (§6.6).
 * The lead's threads follow it to the application. Returns the new application's id.
 *
 * The lead keeps its job key. If another application already holds that key (the same posting
 * applied to through an email), the new application goes without one rather than failing.
 * A lead that is already converted → `VersionConflictError`.
 */
export async function markLeadApplied(
  ctx: Pick<LeadActionCtx, "prisma">,
  leadId: string,
  now: Date,
): Promise<string> {
  assertId(leadId, "lead");
  return withIntakeLock(ctx.prisma, async (tx) => {
    const lead = await tx.lead.findUnique({ where: { id: leadId }, include: LEAD_INCLUDE });
    if (lead === null || lead.pipelineState !== "ready") throw notFound();
    if (lead.status === "applied" || lead.applicationId !== null) {
      throw new VersionConflictError(toLeadDto(lead), "This lead was already marked as applied.");
    }

    const keyTaken =
      lead.jobKey !== null &&
      (await tx.application.findFirst({ where: { jobKey: lead.jobKey }, select: { id: true } })) !==
        null;
    const application = await tx.application.create({
      data: {
        companyId: lead.companyId,
        leadId: lead.id,
        title: lead.title,
        jobUrl: lead.jobUrl,
        jobKey: keyTaken ? null : lead.jobKey,
        locationText: lead.locationText,
        country: lead.country,
        workMode: lead.workMode,
        compensationText: lead.compensationText,
        sponsorshipText: lead.sponsorshipText,
        status: "applied",
        statusChangedAt: now,
        appliedAt: now,
        source: "lead_conversion",
        notes: lead.notes,
        createdAt: now,
        updatedAt: now,
      },
    });
    const changes: ChangeSetEntry[] = [
      {
        entity: "application",
        id: application.id,
        created: true,
        before: null,
        after: createdAfter(application),
        versionAfter: application.version,
      },
    ];

    const { count } = await tx.lead.updateMany({
      where: { id: lead.id, version: lead.version },
      data: {
        status: "applied",
        statusChangedAt: now,
        applicationId: application.id,
        suppressedReason: null,
        dismissedReason: null,
        updatedAt: now,
        version: { increment: 1 },
      },
    });
    if (count === 0) throw notFound();
    changes.push({
      entity: "lead",
      id: lead.id,
      created: false,
      before: {
        status: lead.status,
        statusChangedAt: lead.statusChangedAt,
        applicationId: lead.applicationId,
        suppressedReason: lead.suppressedReason,
        dismissedReason: lead.dismissedReason,
      },
      after: {
        status: "applied",
        statusChangedAt: now,
        applicationId: application.id,
        suppressedReason: null,
        dismissedReason: null,
      },
      versionAfter: lead.version + 1,
    });

    // The lead's threads now belong to the application too (DATA_MODEL §3.7).
    const links = await tx.threadLink.findMany({
      where: { leadId: lead.id, applicationId: null },
    });
    for (const link of links) {
      await tx.threadLink.update({
        where: { threadId: link.threadId },
        data: { applicationId: application.id },
      });
      changes.push({
        entity: "thread_link",
        id: link.threadId,
        created: false,
        before: { applicationId: null },
        after: { applicationId: application.id },
        versionAfter: null,
      });
    }

    await tx.event.create({
      data: {
        applicationId: application.id,
        leadId: lead.id,
        companyId: lead.companyId,
        type: "lead_converted",
        actor: "owner",
        occurredAt: now,
        summary: "Marked as applied",
        data: { toStatus: "applied", fromLeadStatus: lead.status },
        // Plain JSON: dates become ISO strings, as they do in a stored change set.
        changeSet: JSON.parse(JSON.stringify(changes)) as Prisma.InputJsonValue,
        undoable: true,
      },
    });
    return application.id;
  });
}

/** The application as `POST /leads/:id/mark-applied` returns it. */
export async function loadNewApplicationDetail(prisma: PrismaClient, applicationId: string) {
  const row = await prisma.application.findUniqueOrThrow({
    where: { id: applicationId },
    include: { company: { select: { id: true, name: true } }, events: true },
  });
  return newApplicationDetail(row);
}

// --- reconsider ---------------------------------------------------------------------------------

/**
 * *Reconsider* (AC-9.7): a suppressed lead goes back to New. One that was never link-checked
 * (suppressed at intake, before any check) goes to `checking` and gets its `leads.check` job, so
 * it reaches the list only after the check and ranking like any new lead; one that was checked is
 * listed at once. Anything else → `VersionConflictError`: it is not suppressed (any more).
 */
export async function reconsiderLead(ctx: LeadActionCtx, id: string): Promise<LeadDto> {
  const now = ctx.clock();
  const outcome = await withIntakeLock(ctx.prisma, async (tx) => {
    const lead = await loadActionable(tx, id);
    if (lead.status !== "suppressed") throw new VersionConflictError(toLeadDto(lead));
    const check = lead.verifiedAt === null;
    const { count } = await tx.lead.updateMany({
      where: { id, version: lead.version },
      data: {
        status: "new",
        suppressedReason: null,
        statusChangedAt: now,
        pipelineState: check ? "checking" : "ready",
        updatedAt: now,
        version: { increment: 1 },
      },
    });
    if (count === 0) throw notFound();
    const fresh = await tx.lead.findUniqueOrThrow({ where: { id }, include: LEAD_INCLUDE });
    return { lead: fresh, check };
  });
  if (outcome.check) {
    await enqueueLeadChecks(
      ctx.queue,
      { checkIds: [id], batchId: outcome.lead.intakeBatchId },
      ctx.log,
    );
  }
  return toLeadDto(outcome.lead);
}

// --- rerank -------------------------------------------------------------------------------------

/**
 * *Re-rank new leads* (AC-11.4): every listed `new` lead goes back to `ranking` and one
 * `leads.rank` job follows; the job takes them ten at a time and queues itself again while any
 * wait. Their versions go up, so an open page that edits one gets a 409 and refreshes. Leads still
 * being checked or ranked are left alone. If the job cannot be queued the leads are put back, so
 * none waits for a job that does not exist. Returns how many leads were put back in ranking.
 */
export async function rerankNewLeads(ctx: LeadActionCtx): Promise<number> {
  const now = ctx.clock();
  const ids = await withIntakeLock(ctx.prisma, async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      update lead set pipeline_state = 'ranking', updated_at = ${now}, version = version + 1
      where status = 'new' and pipeline_state = 'ready'
      returning id::text as id`;
    return rows.map((row) => row.id);
  });
  if (ids.length === 0) return 0;
  try {
    await ctx.queue.send(QUEUES.leadsRank, {});
  } catch (error) {
    await ctx.prisma.lead.updateMany({
      where: { id: { in: ids }, pipelineState: "ranking", status: "new" },
      data: { pipelineState: "ready", updatedAt: now, version: { increment: 1 } },
    });
    throw error;
  }
  return ids.length;
}
