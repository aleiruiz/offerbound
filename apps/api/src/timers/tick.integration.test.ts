import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDb, testPrisma } from "../../test/db.js";
import { testWorkerCtx } from "../../test/worker.js";
import type { ChangeSetEntry } from "../db/events.js";
import { HANDLERS } from "../jobs/handlers.js";
import { QUEUES } from "../jobs/queues.js";
import { saveSettings } from "../settings/service.js";
import { DEFAULT_SETTINGS } from "@offerbound/contracts";
import { runTimersTick } from "./tick.js";

const prisma = testPrisma();
const NOW = new Date("2026-10-30T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const ctx = () => testWorkerCtx({ clock: () => NOW });

beforeEach(async () => {
  await resetDb(prisma);
  await seedConnection("done");
});

async function seedConnection(backfillState: "not_started" | "running" | "done" | "failed") {
  await prisma.gmailConnection.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      googleSub: "google-sub-owner",
      email: "owner@example.com",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      status: "active",
      backfillSince: new Date("2026-09-01"),
      backfillState,
    },
    update: { backfillState },
  });
}

async function seedApplication(over: Partial<Prisma.ApplicationUncheckedCreateInput> = {}) {
  const company =
    (await prisma.company.findFirst()) ??
    (await prisma.company.create({
      data: { name: "Quarry AI", normalizedName: "quarry ai", createdSource: "manual" },
    }));
  return prisma.application.create({
    data: {
      companyId: company.id,
      title: "Platform Engineer",
      status: "applied",
      statusChangedAt: ago(30 * DAY),
      appliedAt: ago(30 * DAY),
      source: "manual",
      ...over,
    },
  });
}

const eventsOf = (applicationId: string) =>
  prisma.event.findMany({ where: { applicationId }, orderBy: { occurredAt: "asc" } });

describe("runTimersTick", () => {
  it("abandoning writes an undoable abandoned event; flagging writes a follow_up_due event and sets follow_up_due_since", async () => {
    const stale = await seedApplication({
      status: "interviewing",
      appliedAt: ago(20 * DAY),
      lastCompanyActivityAt: ago(15 * DAY),
      followUpDue: true,
      followUpDueSince: ago(8 * DAY),
    });
    const due = await seedApplication({ title: "Data Engineer", appliedAt: ago(8 * DAY) });
    const fresh = await seedApplication({ title: "SRE", appliedAt: ago(2 * DAY) });

    const result = await runTimersTick(ctx());
    expect(result).toEqual({ abandoned: 1, flagged: 1, completed: 0 });

    const abandoned = await prisma.application.findUniqueOrThrow({ where: { id: stale.id } });
    expect(abandoned).toMatchObject({
      status: "abandoned",
      statusBeforeAbandon: "interviewing",
      followUpDue: false,
      followUpDueSince: null,
      statusChangedAt: NOW,
      version: stale.version + 1,
    });
    const [abandonEvent, ...rest] = await eventsOf(stale.id);
    expect(rest).toEqual([]);
    expect(abandonEvent).toMatchObject({
      type: "abandoned",
      actor: "system",
      occurredAt: NOW,
      undoable: true,
      companyId: stale.companyId,
      messageId: null,
    });
    const [entry, ...others] = abandonEvent?.changeSet as unknown as ChangeSetEntry[];
    expect(others).toEqual([]);
    expect(entry).toMatchObject({
      entity: "application",
      id: stale.id,
      created: false,
      versionAfter: stale.version + 1,
      before: {
        status: "interviewing",
        statusBeforeAbandon: null,
        followUpDue: true,
        statusChangedAt: stale.statusChangedAt.toISOString(),
        followUpDueSince: stale.followUpDueSince?.toISOString(),
      },
      after: { status: "abandoned", statusBeforeAbandon: "interviewing", followUpDue: false },
    });

    const flagged = await prisma.application.findUniqueOrThrow({ where: { id: due.id } });
    expect(flagged).toMatchObject({
      status: "applied",
      followUpDue: true,
      followUpDueSince: NOW,
      version: due.version + 1,
    });
    const [flagEvent, ...flagRest] = await eventsOf(due.id);
    expect(flagRest).toEqual([]);
    expect(flagEvent).toMatchObject({ type: "follow_up_due", actor: "system", occurredAt: NOW });
    expect(flagEvent?.changeSet).toEqual([
      expect.objectContaining({
        entity: "application",
        id: due.id,
        before: { followUpDue: false, followUpDueSince: null },
        after: { followUpDue: true, followUpDueSince: NOW.toISOString() },
        versionAfter: due.version + 1,
      }),
    ]);

    expect(await eventsOf(fresh.id)).toEqual([]);
    expect((await prisma.application.findUniqueOrThrow({ where: { id: fresh.id } })).version).toBe(
      fresh.version,
    );
  });

  it("a second tick changes nothing: no new versions, no new events", async () => {
    await seedApplication({ appliedAt: ago(8 * DAY) });
    await seedApplication({ title: "Data Engineer", appliedAt: ago(20 * DAY) });
    expect(await runTimersTick(ctx())).toEqual({ abandoned: 1, flagged: 1, completed: 0 });
    const events = await prisma.event.count();
    expect(await runTimersTick(ctx())).toEqual({ abandoned: 0, flagged: 0, completed: 0 });
    expect(await prisma.event.count()).toBe(events);
  });

  it("uses the follow-up and abandon days from settings", async () => {
    await saveSettings(prisma, {
      ...DEFAULT_SETTINGS,
      timers: { followUpDays: 3, abandonDays: 5 },
    });
    await seedApplication({ appliedAt: ago(3 * DAY) });
    await seedApplication({ title: "Data Engineer", appliedAt: ago(5 * DAY) });
    expect(await runTimersTick(ctx())).toEqual({ abandoned: 1, flagged: 1, completed: 0 });
  });

  it("interviews complete even while the gate is closed", async () => {
    await seedConnection("running");
    const app = await seedApplication({ appliedAt: ago(30 * DAY) });
    const over = await prisma.interview.create({
      data: {
        applicationId: app.id,
        kind: "technical",
        status: "scheduled",
        startsAt: ago(3 * HOUR),
        endsAt: ago(2 * HOUR),
      },
    });
    const noEnd = await prisma.interview.create({
      data: {
        applicationId: app.id,
        kind: "recruiter_screen",
        status: "scheduled",
        startsAt: ago(90 * 60_000),
      },
    });
    const upcoming = await prisma.interview.create({
      data: {
        applicationId: app.id,
        kind: "onsite_loop",
        status: "scheduled",
        startsAt: new Date(NOW.getTime() + DAY),
      },
    });

    expect(await runTimersTick(ctx())).toEqual({ abandoned: 0, flagged: 0, completed: 2 });

    const statuses = await prisma.interview.findMany({ orderBy: { createdAt: "asc" } });
    expect(Object.fromEntries(statuses.map((i) => [i.id, i.status]))).toEqual({
      [over.id]: "completed",
      [noEnd.id]: "completed",
      [upcoming.id]: "scheduled",
    });
    const completedRow = statuses.find((i) => i.id === over.id);
    expect(completedRow?.version).toBe(over.version + 1);

    // The application was left alone: the gate was closed.
    const unchanged = await prisma.application.findUniqueOrThrow({ where: { id: app.id } });
    expect(unchanged).toMatchObject({ status: "applied", version: app.version });

    const events = await prisma.event.findMany({ where: { type: "interview_completed" } });
    expect(events).toHaveLength(2);
    const forOver = events.find(
      (e) => (e.changeSet as unknown as ChangeSetEntry[])[0]?.id === over.id,
    );
    expect(forOver).toMatchObject({
      applicationId: app.id,
      companyId: app.companyId,
      actor: "system",
      occurredAt: NOW,
    });
    expect(forOver?.changeSet).toEqual([
      {
        entity: "interview",
        id: over.id,
        created: false,
        before: { status: "scheduled" },
        after: { status: "completed" },
        versionAfter: over.version + 1,
      },
    ]);
  });

  describe("the gate (AC-7.6)", () => {
    const stale = () => seedApplication({ appliedAt: ago(30 * DAY) });
    const gmailMessage = (
      state: "discovered" | "job_related" | "extracted" | "applied",
      age: number,
    ) =>
      prisma.gmailMessage.create({
        data: {
          id: `m-${state}-${age}`,
          threadId: "t1",
          internalDate: ago(age),
          direction: "inbound",
          labelIds: [],
          state,
        },
      });

    it.each(["not_started", "running", "failed"] as const)(
      "does nothing to applications while backfill is %s",
      async (state) => {
        await seedConnection(state);
        const app = await stale();
        expect(await runTimersTick(ctx())).toEqual({ abandoned: 0, flagged: 0, completed: 0 });
        expect((await prisma.application.findUniqueOrThrow({ where: { id: app.id } })).status).toBe(
          "applied",
        );
      },
    );

    it("does nothing without a Gmail connection", async () => {
      await prisma.gmailConnection.deleteMany();
      await stale();
      expect(await runTimersTick(ctx())).toEqual({ abandoned: 0, flagged: 0, completed: 0 });
    });

    it.each(["discovered", "job_related", "extracted"] as const)(
      "waits while a %s message older than an hour is pending",
      async (state) => {
        await gmailMessage(state, HOUR + 60_000);
        await stale();
        expect(await runTimersTick(ctx())).toEqual({ abandoned: 0, flagged: 0, completed: 0 });
      },
    );

    it("runs when pending messages are recent and old ones are already applied", async () => {
      await gmailMessage("extracted", 10 * 60_000);
      await gmailMessage("applied", 5 * DAY);
      await stale();
      expect(await runTimersTick(ctx())).toEqual({ abandoned: 1, flagged: 0, completed: 0 });
    });
  });

  describe("imported applications (documents the §6.7 rule as written)", () => {
    it("an imported Applied application older than abandonDays with no company activity is abandoned on the first tick", async () => {
      // A spreadsheet import keeps the old applied date (T7.5) and sets no company activity.
      const imported = await seedApplication({
        source: "sheet_import",
        status: "applied",
        appliedAt: ago(60 * DAY),
        lastCompanyActivityAt: null,
      });
      const interviewing = await seedApplication({
        title: "Staff Engineer",
        source: "sheet_import",
        status: "interviewing",
        appliedAt: ago(45 * DAY),
        lastCompanyActivityAt: null,
      });
      const recent = await seedApplication({
        title: "Platform Engineer II",
        source: "sheet_import",
        appliedAt: ago(3 * DAY),
      });

      expect(await runTimersTick(ctx())).toEqual({ abandoned: 2, flagged: 0, completed: 0 });
      const rows = await prisma.application.findMany({ orderBy: { createdAt: "asc" } });
      expect(rows.map((r) => [r.id, r.status, r.statusBeforeAbandon])).toEqual([
        [imported.id, "abandoned", "applied"],
        [interviewing.id, "abandoned", "interviewing"],
        [recent.id, "applied", null],
      ]);
    });
  });

  describe("an undone abandonment restarts the clock", () => {
    const undoLastAbandon = async (applicationId: string, at: Date) => {
      // What undo does (T5.1): restore the fields and stamp the event.
      const event = await prisma.event.findFirstOrThrow({
        where: { applicationId, type: "abandoned" },
      });
      await prisma.event.update({ where: { id: event.id }, data: { undoneAt: at } });
      await prisma.application.update({
        where: { id: applicationId },
        data: { status: "applied", statusBeforeAbandon: null, version: { increment: 1 } },
      });
    };

    it("is not abandoned again right after the undo, but is once abandonDays have passed since it", async () => {
      const app = await seedApplication({ appliedAt: ago(30 * DAY) });
      expect(await runTimersTick(ctx())).toEqual({ abandoned: 1, flagged: 0, completed: 0 });
      await undoLastAbandon(app.id, NOW);

      expect(await runTimersTick(ctx())).toEqual({ abandoned: 0, flagged: 0, completed: 0 });
      expect((await prisma.application.findUniqueOrThrow({ where: { id: app.id } })).status).toBe(
        "applied",
      );

      const sevenDays = new Date(NOW.getTime() + 7 * DAY);
      expect(await runTimersTick(testWorkerCtx({ clock: () => sevenDays }))).toEqual({
        abandoned: 0,
        flagged: 1,
        completed: 0,
      });

      const fourteenDays = new Date(NOW.getTime() + 14 * DAY);
      expect(await runTimersTick(testWorkerCtx({ clock: () => fourteenDays }))).toEqual({
        abandoned: 1,
        flagged: 0,
        completed: 0,
      });
      expect((await prisma.application.findUniqueOrThrow({ where: { id: app.id } })).status).toBe(
        "abandoned",
      );
    });

    it("counts only the undo of its own application", async () => {
      const first = await seedApplication({ appliedAt: ago(30 * DAY) });
      const other = await seedApplication({ title: "SRE", appliedAt: ago(30 * DAY) });
      await runTimersTick(ctx());
      await undoLastAbandon(first.id, ago(1 * DAY));
      expect(await runTimersTick(ctx())).toEqual({ abandoned: 0, flagged: 0, completed: 0 });
      expect((await prisma.application.findUniqueOrThrow({ where: { id: other.id } })).status).toBe(
        "abandoned",
      );
    });
  });

  it("is the handler of the timers.tick queue", async () => {
    await seedApplication({ appliedAt: ago(30 * DAY) });
    const handler = HANDLERS[QUEUES.timersTick];
    expect(handler).toBeDefined();
    await handler?.(ctx(), { data: {}, retryCount: 0, retryLimit: 1 });
    expect(await prisma.application.count({ where: { status: "abandoned" } })).toBe(1);
  });
});
