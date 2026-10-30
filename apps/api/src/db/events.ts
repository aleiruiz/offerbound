import type { Actor, EventType, Prisma } from "@prisma/client";

/**
 * Timeline and audit events (DATA_MODEL §3.8, TECHNICAL_SPEC §6.5, §14). Every executed change
 * plan writes one event per affected record; its `change_set` lets undo compare versions and
 * restore the `before` fields.
 */

/** One record an event changed. `before` is null for a record the event created. */
export type ChangeSetEntry = {
  entity:
    | "application"
    | "lead"
    | "interview"
    | "company"
    | "contact"
    | "thread_link"
    | "gmail_message"
    | "daily_activity";
  id: string;
  created: boolean;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  /** The record's `version` after the change; null for entities that have none. */
  versionAfter: number | null;
};

export type NewEvent = {
  applicationId?: string;
  leadId?: string;
  companyId?: string;
  type: EventType;
  actor: Actor;
  occurredAt: Date;
  messageId?: string;
  summary: string;
  data?: object;
  changeSet?: ChangeSetEntry[];
  undoable: boolean;
};

/** JSON text for a jsonb parameter; dates become ISO strings. */
const json = (value: object | undefined): string | null =>
  value === undefined ? null : JSON.stringify(value);

/**
 * Writes an event and returns its id. An event with a `messageId` is idempotent on the unique
 * expression index `(message_id, type, coalesce(application_id, lead_id, '-'))`: writing it a
 * second time changes nothing and returns the id of the first. A conflicting insert inside a
 * transaction would abort it, so the conflict is resolved by the statement itself
 * (`ON CONFLICT DO NOTHING`), never by catching an error.
 */
export async function writeEvent(tx: Prisma.TransactionClient, e: NewEvent): Promise<string> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO event (application_id, lead_id, company_id, type, actor, occurred_at, message_id,
                       summary, data, change_set, undoable)
    VALUES (${e.applicationId ?? null}::uuid, ${e.leadId ?? null}::uuid,
            ${e.companyId ?? null}::uuid, ${e.type}::event_type, ${e.actor}::actor,
            ${e.occurredAt}, ${e.messageId ?? null}, ${e.summary},
            ${json(e.data)}::jsonb, ${json(e.changeSet)}::jsonb, ${e.undoable})
    ON CONFLICT (message_id, type, (coalesce(application_id::text, lead_id::text, '-')))
      WHERE message_id IS NOT NULL
    DO NOTHING
    RETURNING id::text AS id`;
  const [inserted] = rows;
  if (inserted) return inserted.id;
  if (e.messageId === undefined) throw new Error("The event was not written");

  const existing = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM event
    WHERE message_id = ${e.messageId}
      AND type = ${e.type}::event_type
      AND coalesce(application_id::text, lead_id::text, '-')
          = coalesce(${e.applicationId ?? null}::text, ${e.leadId ?? null}::text, '-')`;
  const [found] = existing;
  if (!found) throw new Error("The event was not written");
  return found.id;
}
