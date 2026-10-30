import type { Prisma } from "@prisma/client";
import {
  evaluateTimers,
  interviewsToComplete,
  timersGateOpen,
  type TimerAction,
} from "@offerbound/domain";
import type { WorkerCtx } from "../deps.js";
import { writeEvent, type ChangeSetEntry } from "../db/events.js";
import { withIntakeLock } from "../db/lock.js";
import { getSettings } from "../settings/service.js";

/**
 * `timers.tick` (TECHNICAL_SPEC §6.7; AC-7.1 to AC-7.6, AC-8.3), every 15 minutes, in one intake
 * lock transaction.
 *
 * Interviews whose time has passed are completed on every tick. Applications are touched only
 * once the gate is open: the Gmail backfill has finished and no message older than an hour is
 * still waiting in the pipeline, so an application is never abandoned before its emails are
 * applied.
 *
 * Every change is written as the owner would expect to see it undone (§6.6): a system event with
 * its own change set (the fields before and after, and the record's version after), so undo can
 * compare versions and restore the old values. Abandoning is undoable (AC-7.4); the flag and an
 * interview completing are recorded but are not offered for undo, because the next tick would
 * put them straight back.
 *
 * An undone abandonment restarts the application's clock at the undo (an undo that the next
 * tick reverted would be no undo), read from `event.undone_at`.
 *
 * Owner edits take no lock, so every write carries the version it was planned against. A record
 * the owner edited since it was read is skipped; the next tick looks at it again.
 *
 * Nothing here logs record content.
 */

type Tx = Prisma.TransactionClient;
type Counts = { abandoned: number; flagged: number; completed: number };

const PENDING_STATES = ["discovered", "job_related", "extracted"] as const;

export async function runTimersTick(ctx: WorkerCtx): Promise<Counts> {
  const now = ctx.clock();
  const counts = await withIntakeLock(ctx.prisma, async (tx) => {
    const result: Counts = {
      abandoned: 0,
      flagged: 0,
      completed: await completeInterviews(tx, now),
    };
    if (await gateIsOpen(tx, now)) {
      const { timers } = await getSettings(tx);
      Object.assign(result, await applyApplicationTimers(tx, timers, now));
    }
    return result;
  });
  if (counts.abandoned + counts.flagged + counts.completed > 0) {
    ctx.log.info(counts, "timers tick");
  }
  return counts;
}

async function gateIsOpen(tx: Tx, now: Date): Promise<boolean> {
  const connection = await tx.gmailConnection.findFirst({ select: { backfillState: true } });
  if (connection === null) return false;
  const pending = await tx.gmailMessage.aggregate({
    where: { state: { in: [...PENDING_STATES] } },
    _min: { internalDate: true },
  });
  return timersGateOpen(
    {
      backfillState: connection.backfillState,
      oldestPendingInternalDate: pending._min.internalDate,
    },
    now,
  );
}

// --- applications ----------------------------------------------------------------------------------

async function applyApplicationTimers(
  tx: Tx,
  timers: { followUpDays: number; abandonDays: number },
  now: Date,
): Promise<Pick<Counts, "abandoned" | "flagged">> {
  const rows = await tx.application.findMany({
    where: { status: { in: ["applied", "screening", "assessment", "interviewing"] } },
  });
  // One grouped query: when each application's abandonment was last undone.
  const undone = await tx.event.groupBy({
    by: ["applicationId"],
    where: {
      type: "abandoned",
      undoneAt: { not: null },
      applicationId: { in: rows.map((row) => row.id) },
    },
    _max: { undoneAt: true },
  });
  const undoneAt = new Map(undone.map((u) => [u.applicationId, u._max.undoneAt]));
  const actions = evaluateTimers(
    rows.map((row) => ({ ...row, undoneAbandonAt: undoneAt.get(row.id) ?? null })),
    timers,
    now,
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  let abandoned = 0;
  let flagged = 0;
  for (const action of actions) {
    const row = byId.get(action.applicationId);
    if (row === undefined) continue;
    const done =
      action.kind === "abandon"
        ? await abandon(tx, row, action, timers.abandonDays, now)
        : await flagFollowUp(tx, row, action, timers.followUpDays, now);
    if (!done) continue;
    if (action.kind === "abandon") abandoned += 1;
    else flagged += 1;
  }
  return { abandoned, flagged };
}

type ApplicationRow = Prisma.ApplicationGetPayload<object>;

async function abandon(
  tx: Tx,
  row: ApplicationRow,
  action: Extract<TimerAction, { kind: "abandon" }>,
  abandonDays: number,
  now: Date,
): Promise<boolean> {
  const after = {
    status: "abandoned" as const,
    statusBeforeAbandon: action.statusBefore,
    statusChangedAt: now,
    followUpDue: false,
    followUpDueSince: null,
  };
  const { count } = await tx.application.updateMany({
    where: { id: row.id, version: action.version },
    data: { ...after, version: { increment: 1 } },
  });
  if (count === 0) return false;
  await writeEvent(tx, {
    applicationId: row.id,
    companyId: row.companyId,
    type: "abandoned",
    actor: "system",
    occurredAt: now,
    summary: `Marked abandoned: no reply in ${abandonDays} days`,
    data: { statusBefore: action.statusBefore },
    changeSet: [
      {
        entity: "application",
        id: row.id,
        created: false,
        before: {
          status: row.status,
          statusBeforeAbandon: row.statusBeforeAbandon,
          statusChangedAt: row.statusChangedAt,
          followUpDue: row.followUpDue,
          followUpDueSince: row.followUpDueSince,
        },
        after,
        versionAfter: action.version + 1,
      },
    ],
    undoable: true,
  });
  return true;
}

async function flagFollowUp(
  tx: Tx,
  row: ApplicationRow,
  action: Extract<TimerAction, { kind: "flag_follow_up" }>,
  followUpDays: number,
  now: Date,
): Promise<boolean> {
  const after = { followUpDue: true, followUpDueSince: now };
  const { count } = await tx.application.updateMany({
    where: { id: row.id, version: action.version },
    data: { ...after, version: { increment: 1 } },
  });
  if (count === 0) return false;
  await writeEvent(tx, {
    applicationId: row.id,
    companyId: row.companyId,
    type: "follow_up_due",
    actor: "system",
    occurredAt: now,
    summary: `Follow-up due: no reply in ${followUpDays} days`,
    changeSet: [
      {
        entity: "application",
        id: row.id,
        created: false,
        before: { followUpDue: row.followUpDue, followUpDueSince: row.followUpDueSince },
        after,
        versionAfter: action.version + 1,
      },
    ],
    undoable: false,
  });
  return true;
}

// --- interviews --------------------------------------------------------------------------------------

async function completeInterviews(tx: Tx, now: Date): Promise<number> {
  const scheduled = await tx.interview.findMany({
    where: { status: "scheduled" },
    include: { application: { select: { companyId: true } } },
  });
  const ids = new Set(interviewsToComplete(scheduled, now));
  let completed = 0;
  for (const interview of scheduled) {
    if (!ids.has(interview.id)) continue;
    const { count } = await tx.interview.updateMany({
      where: { id: interview.id, version: interview.version, status: "scheduled" },
      data: { status: "completed", version: { increment: 1 } },
    });
    if (count === 0) continue;
    const entry: ChangeSetEntry = {
      entity: "interview",
      id: interview.id,
      created: false,
      before: { status: "scheduled" },
      after: { status: "completed" },
      versionAfter: interview.version + 1,
    };
    await writeEvent(tx, {
      applicationId: interview.applicationId,
      companyId: interview.application.companyId,
      type: "interview_completed",
      actor: "system",
      occurredAt: now,
      summary: "Interview completed",
      data: { interviewId: interview.id },
      changeSet: [entry],
      undoable: false,
    });
    completed += 1;
  }
  return completed;
}
