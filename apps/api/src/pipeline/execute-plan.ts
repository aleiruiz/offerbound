import type { Actor, Prisma } from "@prisma/client";
import type { ApplicationSet, ChangePlan, EntityRef, InterviewFields } from "@offerbound/domain";
import { writeEvent, type ChangeSetEntry } from "../db/events.js";

/**
 * Executes a change plan (TECHNICAL_SPEC §6.5, §14) inside the caller's intake-lock transaction.
 * The caller decides whether to run a plan at all: only a plan with `autoApply` is executed
 * (a plan that needs review is stored for display and planned again when the owner decides), and
 * a plan is always the product of `planChanges` on a snapshot read in this same transaction.
 *
 * Operations run in array order. A `{ ref }` names a record an earlier operation of the same
 * plan created (`new:company`, `new:contact`, `new:application`, `new:interview`, `new:lead:N`);
 * refs are also substituted inside event data. Every write to an application, lead or interview
 * carries the version the plan was made against, so an owner edit that landed since the
 * snapshot (owner edits take no lock) makes the update match nothing and the whole transaction
 * is abandoned with {@link VersionConflictError}. The message then stays `extracted` and the
 * next sweep plans it again.
 *
 * One event is written per planned event, each with only the change set of its own record (see
 * {@link sliceChangeSet}): undo works per event, and undoing one leaves the plan's other events
 * and records alone. A write that would change nothing (for example a reply that
 * finds `follow_up_due` already false) is skipped, so it neither bumps `version` nor appears in
 * the change set.
 *
 * Nothing here logs: it handles email-derived text.
 */

/** An update matched no row on `(id, version)`: the record changed (or went away) since the snapshot. */
export class VersionConflictError extends Error {
  constructor(message = "The record changed since it was read") {
    super(message);
    this.name = "VersionConflictError";
  }
}

/** A part of the plan that is not built yet. The apply stage fails the message instead of crashing. */
export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}

export type PlanContext = {
  messageId: string | null;
  /** The email's `internal_date` for email-driven plans. */
  occurredAt: Date;
  actor: Actor;
};

type Tx = Prisma.TransactionClient;

// --- change set --------------------------------------------------------------------------------

/**
 * The records a plan changed. A record written twice (created, then updated by a later operation)
 * is one entry: it keeps the first `before` (per field) and `created`, and the last `after` and
 * `versionAfter`.
 */
class ChangeSet {
  private readonly entries = new Map<string, ChangeSetEntry>();

  record(entry: ChangeSetEntry): void {
    const key = `${entry.entity}:${entry.id}`;
    const first = this.entries.get(key);
    if (first === undefined) {
      this.entries.set(key, entry);
      return;
    }
    this.entries.set(key, {
      entity: entry.entity,
      id: entry.id,
      created: first.created,
      before: first.before === null ? null : { ...entry.before, ...first.before },
      after: { ...first.after, ...entry.after },
      versionAfter: entry.versionAfter,
    });
  }

  list(): ChangeSetEntry[] {
    return [...this.entries.values()];
  }
}

/** The stored form of a record the plan created: what was written, without bookkeeping columns. */
function createdAfter(row: object): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...row };
  for (const column of ["version", "createdAt", "updatedAt"]) delete rest[column];
  return rest;
}

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => same(v, b[i]));
  }
  return a === b;
}

/** The fields of `wanted` that differ from `current`, with the old and new values. */
function diff(
  current: Record<string, unknown>,
  wanted: Record<string, unknown>,
): { data: Record<string, unknown>; before: Record<string, unknown> } | null {
  const data: Record<string, unknown> = {};
  const before: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(wanted)) {
    if (value === undefined || same(current[key], value)) continue;
    data[key] = value;
    before[key] = current[key];
  }
  return Object.keys(data).length === 0 ? null : { data, before };
}

// --- refs ----------------------------------------------------------------------------------------

class Refs {
  readonly map: Record<string, string> = {};

  resolve(target: EntityRef): string {
    if ("id" in target) return target.id;
    const id = this.map[target.ref];
    if (id === undefined) throw new Error(`The plan uses ${target.ref} before it is created`);
    return id;
  }

  set(ref: string, id: string): void {
    this.map[ref] = id;
  }

  /** Event data: any string that is a ref created by this plan becomes that record's id. */
  substitute(value: unknown): unknown {
    if (typeof value === "string") return this.map[value] ?? value;
    if (Array.isArray(value)) return value.map((v) => this.substitute(v));
    if (typeof value === "object" && value !== null && !(value instanceof Date)) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.substitute(v)]));
    }
    return value;
  }
}

// --- operations ------------------------------------------------------------------------------------

async function updateApplication(
  tx: Tx,
  id: string,
  expectedVersion: number | null,
  set: ApplicationSet,
  occurredAt: Date,
  changes: ChangeSet,
): Promise<void> {
  const row = await tx.application.findUnique({ where: { id } });
  if (row === null || (expectedVersion !== null && row.version !== expectedVersion)) {
    throw new VersionConflictError();
  }
  const wanted: Record<string, unknown> = { ...set };
  if (set.status !== undefined && set.status !== row.status) wanted.statusChangedAt = occurredAt;
  const change = diff(row, wanted);
  if (change === null) return;
  const { count } = await tx.application.updateMany({
    where: { id, version: row.version },
    data: { ...change.data, version: { increment: 1 } },
  });
  if (count === 0) throw new VersionConflictError();
  changes.record({
    entity: "application",
    id,
    created: false,
    before: change.before,
    after: change.data,
    versionAfter: row.version + 1,
  });
}

async function writeInterview(
  tx: Tx,
  op: Extract<ChangePlan["operations"][number], { op: "upsert_interview" }>,
  applicationId: string,
  ctx: PlanContext,
  refs: Refs,
  changes: ChangeSet,
): Promise<void> {
  const f: InterviewFields = op.fields;
  if (op.interviewId === null) {
    const row = await tx.interview.create({
      data: {
        applicationId,
        kind: f.kind,
        status: f.status,
        startsAt: f.startsAt,
        endsAt: f.endsAt,
        timezoneHint: f.timezoneHint,
        meetingUrl: f.meetingUrl,
        schedulingUrl: f.schedulingUrl,
        location: f.location,
        interviewers: f.interviewers,
        icsUid: f.icsUid,
        sourceMessageId: ctx.messageId,
      },
    });
    refs.set(op.ref, row.id);
    changes.record({
      entity: "interview",
      id: row.id,
      created: true,
      before: null,
      after: createdAfter(row),
      versionAfter: row.version,
    });
    return;
  }

  const row = await tx.interview.findUnique({ where: { id: op.interviewId } });
  if (row === null || (op.expectedVersion !== null && row.version !== op.expectedVersion)) {
    throw new VersionConflictError();
  }
  // A null link, location or zone, an empty interviewer list: "not provided", keep what is there.
  const change = diff(row, {
    kind: f.kind,
    status: f.status,
    startsAt: f.startsAt,
    endsAt: f.endsAt,
    timezoneHint: f.timezoneHint ?? row.timezoneHint,
    meetingUrl: f.meetingUrl ?? row.meetingUrl,
    schedulingUrl: f.schedulingUrl ?? row.schedulingUrl,
    location: f.location ?? row.location,
    interviewers: f.interviewers.length > 0 ? f.interviewers : row.interviewers,
    icsUid: f.icsUid ?? row.icsUid,
    sourceMessageId: ctx.messageId ?? row.sourceMessageId,
  });
  if (change === null) return;
  const { count } = await tx.interview.updateMany({
    where: { id: row.id, version: row.version },
    data: { ...change.data, version: { increment: 1 } },
  });
  if (count === 0) throw new VersionConflictError();
  changes.record({
    entity: "interview",
    id: row.id,
    created: false,
    before: change.before,
    after: change.data,
    versionAfter: row.version + 1,
  });
}

async function cancelInterview(
  tx: Tx,
  interviewId: string,
  expectedVersion: number,
  changes: ChangeSet,
): Promise<void> {
  const row = await tx.interview.findUnique({ where: { id: interviewId } });
  if (row === null || row.version !== expectedVersion) throw new VersionConflictError();
  if (row.status === "cancelled") return;
  const { count } = await tx.interview.updateMany({
    where: { id: row.id, version: row.version },
    data: { status: "cancelled", version: { increment: 1 } },
  });
  if (count === 0) throw new VersionConflictError();
  changes.record({
    entity: "interview",
    id: row.id,
    created: false,
    before: { status: row.status },
    after: { status: "cancelled" },
    versionAfter: row.version + 1,
  });
}

async function convertLead(
  tx: Tx,
  op: Extract<ChangePlan["operations"][number], { op: "convert_lead" }>,
  ctx: PlanContext,
  refs: Refs,
  changes: ChangeSet,
): Promise<void> {
  const lead = await tx.lead.findUnique({ where: { id: op.leadId } });
  if (lead === null || lead.version !== op.expectedVersion || lead.status === "applied") {
    throw new VersionConflictError();
  }
  const application = await tx.application.create({
    data: {
      companyId: lead.companyId,
      leadId: lead.id,
      title: lead.title,
      jobUrl: lead.jobUrl,
      jobKey: lead.jobKey,
      locationText: lead.locationText,
      country: lead.country,
      workMode: lead.workMode,
      compensationText: lead.compensationText,
      sponsorshipText: lead.sponsorshipText,
      status: op.status,
      statusChangedAt: ctx.occurredAt,
      appliedAt: op.appliedAt,
      source: "gmail",
    },
  });
  refs.set(op.applicationRef, application.id);
  changes.record({
    entity: "application",
    id: application.id,
    created: true,
    before: null,
    after: createdAfter(application),
    versionAfter: application.version,
  });

  const { count } = await tx.lead.updateMany({
    where: { id: lead.id, version: lead.version },
    data: {
      status: "applied",
      statusChangedAt: ctx.occurredAt,
      applicationId: application.id,
      version: { increment: 1 },
    },
  });
  if (count === 0) throw new VersionConflictError();
  changes.record({
    entity: "lead",
    id: lead.id,
    created: false,
    before: {
      status: lead.status,
      statusChangedAt: lead.statusChangedAt,
      applicationId: lead.applicationId,
    },
    after: { status: "applied", statusChangedAt: ctx.occurredAt, applicationId: application.id },
    versionAfter: lead.version + 1,
  });

  // The lead's threads now belong to the application too (DATA_MODEL §3.7).
  const links = await tx.threadLink.findMany({ where: { leadId: lead.id, applicationId: null } });
  for (const link of links) {
    await tx.threadLink.update({
      where: { threadId: link.threadId },
      data: { applicationId: application.id },
    });
    changes.record({
      entity: "thread_link",
      id: link.threadId,
      created: false,
      before: { applicationId: null },
      after: { applicationId: application.id },
      versionAfter: null,
    });
  }
}

/** Points a thread at an application or a lead, replacing whatever it was linked to. */
async function linkThread(
  tx: Tx,
  threadId: string,
  target: { applicationId: string; leadId: null } | { applicationId: null; leadId: string },
  changes: ChangeSet,
): Promise<void> {
  const existing = await tx.threadLink.findUnique({ where: { threadId } });
  if (
    existing !== null &&
    existing.applicationId === target.applicationId &&
    existing.leadId === target.leadId
  ) {
    return;
  }
  await tx.threadLink.upsert({
    where: { threadId },
    create: { threadId, ...target },
    update: target,
  });
  changes.record({
    entity: "thread_link",
    id: threadId,
    created: existing === null,
    before:
      existing === null ? null : { applicationId: existing.applicationId, leadId: existing.leadId },
    after: { ...target },
    versionAfter: null,
  });
}

async function attachMessage(
  tx: Tx,
  messageId: string,
  applicationId: string,
  changes: ChangeSet,
): Promise<void> {
  const message = await tx.gmailMessage.findUniqueOrThrow({
    where: { id: messageId },
    select: { applicationId: true },
  });
  if (message.applicationId === applicationId) return;
  await tx.gmailMessage.update({ where: { id: messageId }, data: { applicationId } });
  changes.record({
    entity: "gmail_message",
    id: messageId,
    created: false,
    before: { applicationId: message.applicationId },
    after: { applicationId },
    versionAfter: null,
  });
}

async function incrementDailyFollowUps(tx: Tx, day: string, changes: ChangeSet): Promise<void> {
  const date = new Date(`${day}T00:00:00.000Z`);
  const existing = await tx.dailyActivity.findUnique({ where: { day: date } });
  const followUps = (existing?.followUps ?? 0) + 1;
  await tx.dailyActivity.upsert({
    where: { day: date },
    create: { day: date, followUps },
    update: { followUps },
  });
  changes.record({
    entity: "daily_activity",
    id: day,
    created: existing === null,
    before: existing === null ? null : { followUps: existing.followUps },
    after: { followUps },
    versionAfter: null,
  });
}

// --- per-event change sets -----------------------------------------------------------------------

const INTERVIEW_EVENTS: readonly string[] = [
  "interview_created",
  "interview_updated",
  "interview_cancelled",
];

/**
 * Splits a plan's change set between its events, so undoing one event (TECHNICAL_SPEC §6.6)
 * reverts only that event's own records and leaves the others alone:
 * - an interview event carries the entries of the interview it names (`data.interview` or
 *   `data.interviewId`);
 * - everything else (the application, the company, contact, lead, thread link, message link and
 *   daily count it changed or created) goes to the plan's first other event, the one that says
 *   what happened to the application or lead. If every event is an interview event, the first.
 * An event left with no entries has no change set and is not undoable.
 *
 * Undoing the event that created an application removes the interviews hanging off it too (they
 * cascade with it); their own events go with them.
 */
function sliceChangeSet(
  events: { type: string; data: object | undefined }[],
  entries: ChangeSetEntry[],
): ChangeSetEntry[][] {
  const slices: ChangeSetEntry[][] = events.map(() => []);
  if (events.length === 0) return slices;
  const interviewOwner = new Map<string, number>();
  for (const [index, event] of events.entries()) {
    if (!INTERVIEW_EVENTS.includes(event.type)) continue;
    const data = (event.data ?? {}) as { interview?: unknown; interviewId?: unknown };
    for (const id of [data.interview, data.interviewId]) {
      if (typeof id === "string" && !interviewOwner.has(id)) interviewOwner.set(id, index);
    }
  }
  const primary = events.findIndex((event) => !INTERVIEW_EVENTS.includes(event.type));
  for (const entry of entries) {
    const owner = entry.entity === "interview" ? interviewOwner.get(entry.id) : undefined;
    slices[owner ?? (primary === -1 ? 0 : primary)]?.push(entry);
  }
  return slices;
}

// --- the executor ----------------------------------------------------------------------------------

export async function executePlan(
  tx: Tx,
  plan: ChangePlan,
  ctx: PlanContext,
): Promise<{ refs: Record<string, string>; eventIds: string[] }> {
  if (!plan.autoApply) {
    throw new Error("A plan that needs review is stored, not executed");
  }
  const refs = new Refs();
  const changes = new ChangeSet();

  for (const op of plan.operations) {
    switch (op.op) {
      case "create_company": {
        const row = await tx.company.create({
          data: {
            name: op.company.name,
            normalizedName: op.company.normalizedName,
            domains: op.company.domains,
            atsSlugs: op.company.atsSlugs,
            websiteDomain: op.company.websiteDomain,
            createdSource: "gmail",
          },
        });
        refs.set(op.ref, row.id);
        changes.record({
          entity: "company",
          id: row.id,
          created: true,
          before: null,
          after: createdAfter(row),
          versionAfter: row.version,
        });
        break;
      }
      case "create_contact": {
        const row = await tx.contact.create({
          data: {
            email: op.email,
            name: op.name,
            title: op.title,
            isAgency: op.isAgency,
            companyId: op.company === null ? null : refs.resolve(op.company),
          },
        });
        refs.set(op.ref, row.id);
        changes.record({
          entity: "contact",
          id: row.id,
          created: true,
          before: null,
          after: createdAfter(row),
          versionAfter: null,
        });
        break;
      }
      case "create_application": {
        const row = await tx.application.create({
          data: {
            companyId: refs.resolve(op.company),
            title: op.title,
            jobUrl: op.jobUrl,
            jobKey: op.jobKey,
            status: op.status,
            statusChangedAt: ctx.occurredAt,
            appliedAt: op.appliedAt,
            lastCompanyActivityAt: op.lastCompanyActivityAt,
            source: op.source,
          },
        });
        refs.set(op.ref, row.id);
        changes.record({
          entity: "application",
          id: row.id,
          created: true,
          before: null,
          after: createdAfter(row),
          versionAfter: row.version,
        });
        break;
      }
      case "convert_lead":
        await convertLead(tx, op, ctx, refs, changes);
        break;
      case "update_application":
        await updateApplication(
          tx,
          refs.resolve(op.application),
          op.expectedVersion,
          op.set,
          ctx.occurredAt,
          changes,
        );
        break;
      case "upsert_interview":
        await writeInterview(tx, op, refs.resolve(op.application), ctx, refs, changes);
        break;
      case "cancel_interview":
        await cancelInterview(tx, op.interviewId, op.expectedVersion, changes);
        break;
      case "create_leads":
        // TODO(T6.3, stream B): replace this with ingestLeads (apps/api/src/leads/intake.ts) and
        // write one lead_created event per stored lead (ingestLeads writes none), add the stored
        // leads' ids to `refs` as "new:lead:N", and call enqueueLeadChecks after the commit.
        throw new NotImplementedError("create_leads not wired (T6.3)");
      case "link_thread": {
        if (op.application !== null) {
          await linkThread(
            tx,
            op.threadId,
            { applicationId: refs.resolve(op.application), leadId: null },
            changes,
          );
        } else if (op.leadRef !== null) {
          // A lead that intake discarded (a duplicate) has no id: there is nothing to link.
          const leadId = refs.map[op.leadRef];
          if (leadId !== undefined) {
            await linkThread(tx, op.threadId, { applicationId: null, leadId }, changes);
          }
        }
        break;
      }
      case "attach_message":
        if (ctx.messageId !== null) {
          await attachMessage(tx, ctx.messageId, refs.resolve(op.application), changes);
        }
        break;
      case "increment_daily_follow_ups":
        await incrementDailyFollowUps(tx, op.day, changes);
        break;
    }
  }

  const planned = plan.events.map((event) => ({
    event,
    data: event.data === null ? undefined : (refs.substitute(event.data) as object),
  }));
  const slices = sliceChangeSet(
    planned.map(({ event, data }) => ({ type: event.type, data })),
    changes.list(),
  );
  const eventIds: string[] = [];
  for (const [index, { event, data }] of planned.entries()) {
    const changeSet = slices[index] ?? [];
    const subjectId = refs.resolve(event.subject);
    const owner =
      event.subjectType === "application"
        ? await tx.application.findUnique({ where: { id: subjectId }, select: { companyId: true } })
        : await tx.lead.findUnique({ where: { id: subjectId }, select: { companyId: true } });
    eventIds.push(
      await writeEvent(tx, {
        ...(event.subjectType === "application"
          ? { applicationId: subjectId }
          : { leadId: subjectId }),
        ...(owner === null ? {} : { companyId: owner.companyId }),
        type: event.type,
        actor: ctx.actor,
        occurredAt: ctx.occurredAt,
        ...(ctx.messageId === null ? {} : { messageId: ctx.messageId }),
        summary: event.summary,
        ...(data === undefined ? {} : { data }),
        ...(changeSet.length === 0 ? {} : { changeSet }),
        undoable: changeSet.length > 0,
      }),
    );
  }
  return { refs: refs.map, eventIds };
}
