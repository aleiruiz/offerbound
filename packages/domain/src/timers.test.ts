import { describe, expect, it } from "vitest";
import { evaluateTimers, interviewsToComplete, timersGateOpen, type TimerApp } from "./timers.js";

const NOW = new Date("2026-10-30T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const T = { followUpDays: 7, abandonDays: 14 };

const app = (over: Partial<TimerApp> = {}): TimerApp => ({
  id: "a1",
  version: 4,
  status: "applied",
  lastCompanyActivityAt: null,
  appliedAt: null,
  createdAt: ago(100 * DAY),
  followUpDue: false,
  followUpDoneAt: null,
  clockRestartedAt: null,
  ...over,
});

describe("evaluateTimers", () => {
  it("the clock is lastCompanyActivityAt, else appliedAt, else createdAt", () => {
    // AC-7.1: each clock source alone decides, and an earlier source wins over a later one.
    const old = ago(8 * DAY);
    const recent = ago(1 * DAY);
    expect(evaluateTimers([app({ createdAt: old })], T, NOW)).toEqual([
      { kind: "flag_follow_up", applicationId: "a1", version: 4 },
    ]);
    expect(
      evaluateTimers([app({ appliedAt: old, createdAt: recent })], T, NOW).map((a) => a.kind),
    ).toEqual(["flag_follow_up"]);
    expect(
      evaluateTimers(
        [app({ lastCompanyActivityAt: recent, appliedAt: old, createdAt: old })],
        T,
        NOW,
      ),
    ).toEqual([]);
    expect(
      evaluateTimers([app({ lastCompanyActivityAt: old, appliedAt: recent })], T, NOW).map(
        (a) => a.kind,
      ),
    ).toEqual(["flag_follow_up"]);
  });

  it("exactly 7 days → flag_follow_up; 6 days 23 hours → nothing", () => {
    expect(evaluateTimers([app({ appliedAt: ago(7 * DAY) })], T, NOW)).toEqual([
      { kind: "flag_follow_up", applicationId: "a1", version: 4 },
    ]);
    expect(evaluateTimers([app({ appliedAt: ago(7 * DAY - HOUR) })], T, NOW)).toEqual([]);
  });

  it("14 days → abandon with statusBefore", () => {
    expect(
      evaluateTimers([app({ status: "interviewing", appliedAt: ago(14 * DAY) })], T, NOW),
    ).toEqual([{ kind: "abandon", applicationId: "a1", version: 4, statusBefore: "interviewing" }]);
    expect(
      evaluateTimers([app({ appliedAt: ago(14 * DAY - HOUR) })], T, NOW).map((a) => a.kind),
    ).toEqual(["flag_follow_up"]);
  });

  it("an undone abandonment restarts the clock: the later of the clock and the undo decides", () => {
    // Applied 30 days ago, abandoned, then undone 2 days ago: a fresh window from the undo.
    const old = { appliedAt: ago(30 * DAY), clockRestartedAt: ago(2 * DAY) };
    expect(evaluateTimers([app(old)], T, NOW)).toEqual([]);
    expect(
      evaluateTimers([app({ ...old, clockRestartedAt: ago(7 * DAY) })], T, NOW).map((a) => a.kind),
    ).toEqual(["flag_follow_up"]);
    expect(
      evaluateTimers([app({ ...old, clockRestartedAt: ago(14 * DAY) })], T, NOW).map((a) => a.kind),
    ).toEqual(["abandon"]);
    // Company mail after the undo is the later clock.
    expect(
      evaluateTimers(
        [app({ ...old, clockRestartedAt: ago(10 * DAY), lastCompanyActivityAt: ago(1 * DAY) })],
        T,
        NOW,
      ),
    ).toEqual([]);
  });

  it("an application already flagged is not flagged again", () => {
    expect(evaluateTimers([app({ appliedAt: ago(9 * DAY), followUpDue: true })], T, NOW)).toEqual(
      [],
    );
  });

  it("followed up 3 days ago with the clock at 10 days → nothing; followed up 7 days ago with no reply → flag again", () => {
    const clock = ago(10 * DAY);
    expect(
      evaluateTimers([app({ appliedAt: clock, followUpDoneAt: ago(3 * DAY) })], T, NOW),
    ).toEqual([]);
    expect(
      evaluateTimers([app({ appliedAt: clock, followUpDoneAt: ago(7 * DAY) })], T, NOW),
    ).toEqual([{ kind: "flag_follow_up", applicationId: "a1", version: 4 }]);
  });

  it("a follow-up older than the clock does not count: a later reply restarts the wait", () => {
    // The follow-up was 30 days ago, the company replied 8 days ago: measure from the reply.
    expect(
      evaluateTimers(
        [app({ lastCompanyActivityAt: ago(8 * DAY), followUpDoneAt: ago(30 * DAY) })],
        T,
        NOW,
      ),
    ).toEqual([{ kind: "flag_follow_up", applicationId: "a1", version: 4 }]);
  });

  it("the owner's follow-ups never delay abandonment", () => {
    expect(
      evaluateTimers([app({ appliedAt: ago(14 * DAY), followUpDoneAt: ago(1 * HOUR) })], T, NOW),
    ).toEqual([{ kind: "abandon", applicationId: "a1", version: 4, statusBefore: "applied" }]);
  });

  it("only Applied, Screening, Assessment and Interviewing are evaluated", () => {
    const statuses = [
      "applied",
      "screening",
      "assessment",
      "interviewing",
      "offer",
      "accepted",
      "rejected",
      "withdrawn",
      "abandoned",
    ] as const;
    const apps = statuses.map((status) => app({ id: status, status, appliedAt: ago(30 * DAY) }));
    expect(evaluateTimers(apps, T, NOW).map((a) => a.applicationId)).toEqual([
      "applied",
      "screening",
      "assessment",
      "interviewing",
    ]);
  });

  it("uses the configured days", () => {
    const tight = { followUpDays: 2, abandonDays: 3 };
    expect(
      evaluateTimers([app({ appliedAt: ago(2 * DAY) })], tight, NOW).map((a) => a.kind),
    ).toEqual(["flag_follow_up"]);
    expect(
      evaluateTimers([app({ appliedAt: ago(3 * DAY) })], tight, NOW).map((a) => a.kind),
    ).toEqual(["abandon"]);
  });
});

describe("timersGateOpen", () => {
  it("the gate is closed while backfill runs or a message older than one hour is pending; open otherwise", () => {
    // AC-7.6
    const open = { backfillState: "done", oldestPendingInternalDate: null } as const;
    expect(timersGateOpen(open, NOW)).toBe(true);
    expect(timersGateOpen({ ...open, oldestPendingInternalDate: ago(30 * 60_000) }, NOW)).toBe(
      true,
    );
    expect(timersGateOpen({ ...open, oldestPendingInternalDate: ago(HOUR) }, NOW)).toBe(true);
    expect(timersGateOpen({ ...open, oldestPendingInternalDate: ago(HOUR + 1) }, NOW)).toBe(false);
    for (const backfillState of ["not_started", "running", "failed"] as const) {
      expect(timersGateOpen({ ...open, backfillState }, NOW)).toBe(false);
    }
  });
});

describe("interviewsToComplete", () => {
  const iv = (
    over: Partial<Parameters<typeof interviewsToComplete>[0][number]> & { id: string },
  ) => ({
    status: "scheduled" as const,
    startsAt: null,
    endsAt: null,
    ...over,
  });

  it("a scheduled interview completes when ends_at has passed, else starts_at + 60 min", () => {
    // AC-8.3
    const list = [
      iv({ id: "ended", startsAt: ago(3 * HOUR), endsAt: ago(1) }),
      iv({ id: "still-running", startsAt: ago(3 * HOUR), endsAt: new Date(NOW.getTime() + 1) }),
      iv({ id: "ends-exactly-now", startsAt: ago(HOUR), endsAt: NOW }),
      iv({ id: "no-end-61-min", startsAt: ago(61 * 60_000) }),
      iv({ id: "no-end-59-min", startsAt: ago(59 * 60_000) }),
      iv({ id: "no-end-60-min", startsAt: ago(60 * 60_000) }),
      iv({ id: "no-times" }),
      iv({ id: "end-only", endsAt: ago(HOUR) }),
      iv({ id: "to-schedule", status: "to_schedule", startsAt: ago(DAY) }),
      iv({ id: "done", status: "completed", startsAt: ago(DAY) }),
      iv({ id: "cancelled", status: "cancelled", startsAt: ago(DAY) }),
    ];
    expect(interviewsToComplete(list, NOW)).toEqual(["ended", "no-end-61-min", "end-only"]);
  });
});
