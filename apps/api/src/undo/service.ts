import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { writeEvent, type ChangeSetEntry } from "../db/events.js";
import { withIntakeLock } from "../db/lock.js";
import { ApiError } from "../http/errors.js";
import { createReviewItem } from "../review/create.js";

/**
 * Undo (TECHNICAL_SPEC §6.6, AC-4.3, AC-4.4). Undo works per event: it reverts the records in that
 * one event's change set and leaves the plan's other events and records alone (see
 * `sliceChangeSet` in the plan executor).
 *
 * Everything runs in the intake-lock transaction, and every write that touches a versioned record
 * names the `version` the event left it at. A record the owner (who takes no lock) or a later
 * change has edited since matches nothing, the transaction is abandoned and the answer is
 * `409 changed_since` with nothing changed.
 *
 * Nothing here logs: the records hold email-derived text.
 */

type Tx = Prisma.TransactionClient;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EntrySchema = z.object({
  entity: z.enum([
    "application",
    "lead",
    "interview",
    "company",
    "contact",
    "thread_link",
    "gmail_message",
    "daily_activity",
  ]),
  id: z.string(),
  created: z.boolean(),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()),
  versionAfter: z.number().int().nullable(),
});
const ChangeSetSchema = z.array(EntrySchema);

const changedSince = (message: string) => new ApiError(409, "changed_since", message);

const NOT_UNDOABLE = "This change can't be undone.";

/** The part of a Prisma model delegate undo uses, so one code path serves every entity. */
type Delegate = {
  updateMany(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<{ count: number }>;
  deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
};

function delegateFor(tx: Tx, entity: "application" | "lead" | "interview" | "company" | "contact") {
  const delegates = {
    application: tx.application,
    lead: tx.lead,
    interview: tx.interview,
    company: tx.company,
    contact: tx.contact,
  };
  return delegates[entity] as unknown as Delegate;
}

const MODEL_NAME = {
  application: "Application",
  lead: "Lead",
  interview: "Interview",
  company: "Company",
  contact: "Contact",
} as const;

/** Column names and kinds of a model, from Prisma's own schema. */
function fieldKinds(model: string): Map<string, string> {
  const found = Prisma.dmmf.datamodel.models.find((m) => m.name === model);
  return new Map((found?.fields ?? []).map((f) => [f.name, f.type]));
}

/**
 * A `before` object as update data: only real columns, never the key, `version` or `createdAt`;
 * dates stored as ISO strings in the change set (JSON) read back as `Date`.
 */
function restoreData(
  entity: keyof typeof MODEL_NAME,
  before: Record<string, unknown> | null,
  now: Date,
): Record<string, unknown> {
  const kinds = fieldKinds(MODEL_NAME[entity]);
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(before ?? {})) {
    const kind = kinds.get(key);
    if (kind === undefined || ["id", "version", "createdAt", "updatedAt"].includes(key)) continue;
    data[key] = kind === "DateTime" && typeof value === "string" ? new Date(value) : value;
  }
  if (kinds.has("updatedAt")) data.updatedAt = now;
  return data;
}

/** The ids of created entries of one entity, with the version the change left them at. */
function createdIds(entries: ChangeSetEntry[], entity: ChangeSetEntry["entity"]) {
  return entries.filter((e) => e.created && e.entity === entity);
}

/**
 * Refuses to delete a created application or lead that has grown history the event doesn't own
 * (TECHNICAL_SPEC §6.6 doesn't cover this; the FK cascade would silently delete it). Allowed:
 * what the same email's plan wrote, i.e. events with the event's own message and the interviews
 * those events created and nobody has edited since. Anything else, such as an owner edit or a
 * later email's event or interview, → `changed_since`.
 */
async function assertNoLaterChildren(
  tx: Tx,
  event: { id: string; messageId: string | null },
  entries: ChangeSetEntry[],
): Promise<void> {
  const allowedInterviews = new Map<string, number | null>();
  for (const e of createdIds(entries, "interview")) allowedInterviews.set(e.id, e.versionAfter);

  const siblingIds = async (where: { applicationId: string } | { leadId: string }) => {
    const others = await tx.event.findMany({ where: { ...where, id: { not: event.id } } });
    for (const other of others) {
      // An `undone` event carries its email in `data`, not in `message_id`.
      const data = other.data as { messageId?: unknown } | null;
      const otherMessage = other.type === "undone" ? (data?.messageId ?? null) : other.messageId;
      if (event.messageId === null || otherMessage !== event.messageId) {
        throw changedSince("Records were added after this change. Edit them directly.");
      }
      const parsed = ChangeSetSchema.safeParse(other.changeSet);
      if (!parsed.success) continue;
      for (const e of createdIds(parsed.data, "interview")) {
        allowedInterviews.set(e.id, e.versionAfter);
      }
    }
  };

  for (const app of createdIds(entries, "application")) {
    await siblingIds({ applicationId: app.id });
    const interviews = await tx.interview.findMany({ where: { applicationId: app.id } });
    for (const interview of interviews) {
      const allowed = allowedInterviews.get(interview.id);
      if (allowed === undefined || (allowed !== null && allowed !== interview.version)) {
        throw changedSince("Records were added after this change. Edit them directly.");
      }
    }
  }
  for (const lead of createdIds(entries, "lead")) {
    await siblingIds({ leadId: lead.id });
    const row = await tx.lead.findUnique({ where: { id: lead.id } });
    if (row?.applicationId != null) {
      throw changedSince("This lead was converted after this change.");
    }
  }
}

/** Puts a record back to its `before` fields, if it is still at `versionAfter`. */
async function restoreVersioned(tx: Tx, entry: ChangeSetEntry, now: Date): Promise<void> {
  const entity = entry.entity as keyof typeof MODEL_NAME;
  const guard = entry.versionAfter === null ? {} : { version: entry.versionAfter };
  const versionBump = entity === "contact" ? {} : { version: { increment: 1 } };
  const { count } = await delegateFor(tx, entity).updateMany({
    where: { id: entry.id, ...guard },
    data: { ...restoreData(entity, entry.before, now), ...versionBump },
  });
  if (count === 0) throw changedSince("A record changed after this change.");
}

async function deleteVersioned(tx: Tx, entry: ChangeSetEntry): Promise<void> {
  const entity = entry.entity as keyof typeof MODEL_NAME;
  const guard = entry.versionAfter === null ? {} : { version: entry.versionAfter };
  if (entity === "lead") return deleteCreatedLead(tx, entry);
  const { count } = await delegateFor(tx, entity).deleteMany({ where: { id: entry.id, ...guard } });
  if (count === 0) throw changedSince("A record changed after this change.");
}

/**
 * A lead the change created is deleted while the owner has not acted on it: it is still `new` (or
 * suppressed by the pipeline) and has no application. Its `version` is not compared: the link
 * check and the rank always bump it, so the version the event left is stale by the time anyone
 * undoes. Owner actions (shortlist, dismiss, mark applied) change `status`.
 */
async function deleteCreatedLead(tx: Tx, entry: ChangeSetEntry): Promise<void> {
  const { count } = await tx.lead.deleteMany({
    where: { id: entry.id, status: { in: ["new", "suppressed"] }, applicationId: null },
  });
  if (count === 0) throw changedSince("This lead was changed after it was created.");
}

/** A thread link is restored or removed only while it still points where the change left it. */
async function undoThreadLink(tx: Tx, entry: ChangeSetEntry): Promise<void> {
  const current = await tx.threadLink.findUnique({ where: { threadId: entry.id } });
  if (current === null) return;
  const stillAsLeft = Object.entries(entry.after).every(
    ([key, value]) => current[key as "applicationId" | "leadId"] === value,
  );
  if (!stillAsLeft) return;
  if (entry.before === null) {
    await tx.threadLink.delete({ where: { threadId: entry.id } });
    return;
  }
  const data: { applicationId?: string | null; leadId?: string | null } = {};
  for (const key of ["applicationId", "leadId"] as const) {
    const value = entry.before[key];
    if (value === null || typeof value === "string") data[key] = value;
  }
  await tx.threadLink.update({ where: { threadId: entry.id }, data });
}

/** A message the change attached to an application goes back to what it was linked to. */
async function undoMessageLink(tx: Tx, entry: ChangeSetEntry): Promise<void> {
  const previous = entry.before?.applicationId;
  await tx.gmailMessage.updateMany({
    where: { id: entry.id, applicationId: (entry.after.applicationId as string | null) ?? null },
    data: { applicationId: typeof previous === "string" ? previous : null },
  });
}

/**
 * The follow-up count is a number the owner can edit any time, so it is lowered by what the
 * change added rather than set back to an old value that may no longer be right.
 */
async function undoDailyActivity(tx: Tx, entry: ChangeSetEntry): Promise<void> {
  const day = new Date(`${entry.id}T00:00:00.000Z`);
  const row = await tx.dailyActivity.findUnique({ where: { day } });
  if (row === null) return;
  const added = Number(entry.after.followUps ?? 0) - Number(entry.before?.followUps ?? 0);
  const followUps = Math.max(0, row.followUps - added);
  if (entry.created && followUps === 0 && row.outreachCount === 0 && row.prepMinutes === 0) {
    await tx.dailyActivity.delete({ where: { day } });
    return;
  }
  await tx.dailyActivity.update({ where: { day }, data: { followUps } });
}

/**
 * A lead whose application is deleted for any reason goes back to Shortlisted with no
 * application (TECHNICAL_SPEC §6.6). Leads the change set already restored have no application
 * by now, so this only catches a lead linked by some other path.
 */
async function releaseLeads(tx: Tx, applicationId: string, now: Date): Promise<void> {
  const leads = await tx.lead.findMany({ where: { applicationId } });
  for (const lead of leads) {
    const { count } = await tx.lead.updateMany({
      where: { id: lead.id, version: lead.version },
      data: {
        status: "shortlisted",
        statusChangedAt: now,
        applicationId: null,
        suppressedReason: null,
        updatedAt: now,
        version: { increment: 1 },
      },
    });
    if (count === 0) throw changedSince("A record changed after this change.");
  }
}

/** Deletes a created company or contact only if nothing references it; otherwise it stays. */
async function deleteIfUnreferenced(tx: Tx, entry: ChangeSetEntry): Promise<void> {
  if (entry.entity === "contact") {
    if ((await tx.lead.count({ where: { contactId: entry.id } })) === 0) {
      await tx.contact.deleteMany({ where: { id: entry.id } });
    }
    return;
  }
  const [applications, leads, contacts, members] = await Promise.all([
    tx.application.count({ where: { companyId: entry.id } }),
    tx.lead.count({ where: { companyId: entry.id } }),
    tx.contact.count({ where: { companyId: entry.id } }),
    tx.company.count({ where: { groupId: entry.id } }),
  ]);
  if (applications + leads + contacts + members > 0) return;
  // An edited company (its version moved on) is kept: deleting it would lose the edit.
  await tx.company.deleteMany({
    where: {
      id: entry.id,
      ...(entry.versionAfter === null ? {} : { version: entry.versionAfter }),
    },
  });
}

/**
 * Undoes one event (AC-4.3): restores the `before` fields of the records it changed and bumps their
 * versions, deletes the records it created, then records the undo (AC-4.4).
 *
 * - `404 not_found`: no such event.
 * - `409 changed_since`: the event was already undone, or a record it touched has changed since
 *   (its version is no longer the one the event left), or an application or lead it created has
 *   history that is not the event's own. Nothing is changed.
 * - `400 validation_failed`: the event isn't undoable (`imported`, `undone`, owner edits, or an
 *   event with nothing to undo).
 *
 * Deleting an application cascades to its interviews, events, thread links and review items. The
 * `undone` event is written against what survives: the event's own subject when its row is still
 * there, else the lead, else the company. A created company or contact is deleted only when
 * nothing else references it (and, for a company, nobody has edited it).
 */
export async function undoEvent(prisma: PrismaClient, eventId: string, now: Date): Promise<void> {
  if (!UUID.test(eventId)) throw new ApiError(404, "not_found", "No such event.");

  await withIntakeLock(prisma, async (tx) => {
    const event = await tx.event.findUnique({ where: { id: eventId } });
    if (event === null) throw new ApiError(404, "not_found", "No such event.");
    if (event.undoneAt !== null) throw changedSince("This change was already undone.");
    if (!event.undoable || event.type === "imported" || event.type === "undone") {
      throw new ApiError(400, "validation_failed", NOT_UNDOABLE);
    }
    const parsed = ChangeSetSchema.safeParse(event.changeSet);
    if (!parsed.success || parsed.data.length === 0) {
      throw new ApiError(400, "validation_failed", NOT_UNDOABLE);
    }
    const entries = parsed.data;

    await assertNoLaterChildren(tx, event, entries);

    // 1. Put changed records back. Leads first: a converted lead must let go of its application
    //    before the application is deleted.
    const order = ["lead", "application", "interview", "company", "contact"] as const;
    for (const entity of order) {
      for (const entry of entries) {
        if (entry.entity === entity && !entry.created) await restoreVersioned(tx, entry, now);
      }
    }
    for (const entry of entries) {
      if (entry.entity === "gmail_message") await undoMessageLink(tx, entry);
      else if (entry.entity === "thread_link") await undoThreadLink(tx, entry);
      else if (entry.entity === "daily_activity") await undoDailyActivity(tx, entry);
    }

    // 2. Delete what the change created, children before parents.
    for (const entry of createdIds(entries, "interview")) await deleteVersioned(tx, entry);
    for (const entry of createdIds(entries, "application")) {
      await releaseLeads(tx, entry.id, now);
      await deleteVersioned(tx, entry);
    }
    for (const entry of createdIds(entries, "lead")) await deleteVersioned(tx, entry);
    for (const entry of createdIds(entries, "contact")) await deleteIfUnreferenced(tx, entry);
    for (const entry of createdIds(entries, "company")) await deleteIfUnreferenced(tx, entry);

    // 3. Record the undo. The event's own row survives when its subject does.
    const own = await tx.event.findUnique({ where: { id: event.id } });
    const restoredLeadId = entries.find((e) => e.entity === "lead" && !e.created)?.id ?? null;
    const leadId = own?.leadId ?? event.leadId ?? restoredLeadId;
    const lead = leadId === null ? null : await tx.lead.findUnique({ where: { id: leadId } });
    const applicationId = own?.applicationId ?? null;
    const company =
      event.companyId === null
        ? null
        : await tx.company.findUnique({ where: { id: event.companyId }, select: { id: true } });

    // Not given the message: an event with a message is unique per (message, type, subject), and
    // two events of one email undone against the same record would collide. The message is in
    // `data`, and the review item below carries it.
    const undoneId = await writeEvent(tx, {
      ...(applicationId === null ? {} : { applicationId }),
      ...(lead === null ? {} : { leadId: lead.id }),
      ...(company === null ? {} : { companyId: company.id }),
      type: "undone",
      actor: "owner",
      occurredAt: now,
      summary: `Undid: ${event.summary}`,
      data: { undoes: event.id, undoneType: event.type, messageId: event.messageId },
      undoable: false,
    });
    await tx.event.updateMany({
      where: { id: event.id },
      data: { undoneAt: now, undoneByEventId: undoneId },
    });

    // *Undone change* for the source email, with Reprocess and Ignore (AC-4.4). An owner action
    // such as Mark applied has no email, so it opens nothing.
    if (event.messageId !== null) {
      await createReviewItem(tx, {
        kind: "undone_change",
        messageId: event.messageId,
        ...(applicationId === null ? {} : { applicationId }),
        ...(lead === null ? {} : { leadId: lead.id }),
        confidence: null,
        plan: null,
        candidates: [],
        reasons: ["undone"],
      });
    }
  });
}
