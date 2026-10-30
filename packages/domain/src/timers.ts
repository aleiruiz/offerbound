import type { ApplicationStatus, BackfillState, InterviewStatus } from "@offerbound/contracts";

/**
 * Timers (TECHNICAL_SPEC §6.7; AC-7.1 to AC-7.6, AC-8.3). Pure: the worker loads the rows, asks
 * what to do here, and writes the changes. Durations are plain elapsed time (n x 24 hours), as
 * the spec words them ("now - clock >= abandonDays"), not owner-local calendar days.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** How old a message waiting in the pipeline may be before the timers hold back (AC-7.6). */
const PENDING_MESSAGE_GRACE_MS = HOUR_MS;

/** Interviews without an end time are taken to last this long (AC-8.3). */
const DEFAULT_INTERVIEW_MS = 60 * MINUTE_MS;

/** The statuses whose applications have a company clock (AC-7.1). */
const TIMED_STATUSES: readonly ApplicationStatus[] = [
  "applied",
  "screening",
  "assessment",
  "interviewing",
];

export type TimerApp = {
  id: string;
  version: number;
  status: ApplicationStatus;
  lastCompanyActivityAt: Date | null;
  appliedAt: Date | null;
  createdAt: Date;
  followUpDue: boolean;
  followUpDoneAt: Date | null;
  /**
   * When the owner last undid an abandonment of this application, or null. An undone abandonment
   * must stick, so the clock restarts there: the owner gets a fresh window.
   */
  undoneAbandonAt: Date | null;
};

export type TimerAction =
  | { kind: "abandon"; applicationId: string; version: number; statusBefore: ApplicationStatus }
  | { kind: "flag_follow_up"; applicationId: string; version: number };

/**
 * Whether the timers may touch applications. They wait until the Gmail backfill has finished and
 * no message older than one hour is still in `discovered`, `job_related` or `extracted`, so a
 * backfilled or imported application is never abandoned before its emails are applied (AC-7.6).
 * `oldestPendingInternalDate` is the oldest `internal_date` among those messages, or null.
 */
export function timersGateOpen(
  p: { backfillState: BackfillState; oldestPendingInternalDate: Date | null },
  now: Date,
): boolean {
  if (p.backfillState !== "done") return false;
  if (p.oldestPendingInternalDate === null) return true;
  return now.getTime() - p.oldestPendingInternalDate.getTime() <= PENDING_MESSAGE_GRACE_MS;
}

/**
 * What to do for each application in Applied, Screening, Assessment or Interviewing:
 * the company clock is the latest company email, else the applied date, else creation (AC-7.1),
 * or the time an abandonment was last undone when that is later.
 * At `abandonDays` it is abandoned, whatever the owner's follow-ups (AC-7.4). At `followUpDays`
 * it is flagged, unless it already is, or the owner followed up less than `followUpDays` ago
 * (measured from the later of the follow-up and the clock, AC-7.3). Other statuses get nothing.
 */
export function evaluateTimers(
  apps: TimerApp[],
  t: { followUpDays: number; abandonDays: number },
  now: Date,
): TimerAction[] {
  const followUpMs = t.followUpDays * DAY_MS;
  const abandonMs = t.abandonDays * DAY_MS;
  const actions: TimerAction[] = [];
  for (const a of apps) {
    if (!TIMED_STATUSES.includes(a.status)) continue;
    const clock = Math.max(
      (a.lastCompanyActivityAt ?? a.appliedAt ?? a.createdAt).getTime(),
      a.undoneAbandonAt?.getTime() ?? Number.NEGATIVE_INFINITY,
    );
    const elapsed = now.getTime() - clock;
    if (elapsed >= abandonMs) {
      actions.push({
        kind: "abandon",
        applicationId: a.id,
        version: a.version,
        statusBefore: a.status,
      });
    } else if (elapsed >= followUpMs && !a.followUpDue) {
      const since = a.followUpDoneAt === null ? clock : Math.max(a.followUpDoneAt.getTime(), clock);
      if (now.getTime() - since >= followUpMs) {
        actions.push({ kind: "flag_follow_up", applicationId: a.id, version: a.version });
      }
    }
  }
  return actions;
}

/**
 * Ids of `scheduled` interviews that are over: `ends_at` has passed, else `starts_at` + 60
 * minutes has (AC-8.3). An interview with neither time stays as it is.
 */
export function interviewsToComplete(
  list: { id: string; status: InterviewStatus; startsAt: Date | null; endsAt: Date | null }[],
  now: Date,
): string[] {
  return list
    .filter((i) => {
      if (i.status !== "scheduled") return false;
      const end =
        i.endsAt?.getTime() ??
        (i.startsAt === null ? null : i.startsAt.getTime() + DEFAULT_INTERVIEW_MS);
      return end !== null && end < now.getTime();
    })
    .map((i) => i.id);
}
