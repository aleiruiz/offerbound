import type { Prisma } from "@prisma/client";
import type { ChangePlan, Operation, PlannedEvent } from "@offerbound/domain";
import { beforeEach, describe, expect, it } from "vitest";
import { extraction } from "../../test/apply.js";
import { resetDb, testPrisma } from "../../test/db.js";
import { writeEvent } from "../db/events.js";
import { withIntakeLock } from "../db/lock.js";
import { createReviewItem } from "../review/create.js";
import {
  executePlan,
  NotImplementedError,
  VersionConflictError,
  type PlanContext,
} from "./execute-plan.js";
import { loadPlanSnapshot } from "./snapshot.js";

const prisma = testPrisma();
const AT = new Date("2026-10-05T10:00:00.000Z");

beforeEach(async () => {
  await resetDb(prisma);
  await prisma.gmailMessage.create({
    data: {
      id: "m1",
      threadId: "thr-1",
      internalDate: AT,
      direction: "inbound",
      labelIds: [],
      state: "extracted",
    },
  });
});

const ctxFor = (over: Partial<PlanContext> = {}): PlanContext => ({
  messageId: "m1",
  occurredAt: AT,
  actor: "system",
  ...over,
});

function plan(
  operations: Operation[],
  events: PlannedEvent[] = [],
  over: Partial<ChangePlan> = {},
): ChangePlan {
  return {
    operations,
    events,
    autoApply: true,
    confidence: 0.95,
    review: null,
    notices: [],
    messageOutcome: "applied",
    ...over,
  };
}

const run = (p: ChangePlan, ctx = ctxFor()) =>
  withIntakeLock(prisma, (tx) => executePlan(tx, p, ctx));

async function seedApplication(over: Partial<Prisma.ApplicationUncheckedCreateInput> = {}) {
  const company = await prisma.company.create({
    data: { name: "Quarry AI", normalizedName: "quarry ai", createdSource: "manual" },
  });
  return prisma.application.create({
    data: {
      companyId: company.id,
      title: "Platform Engineer",
      status: "applied",
      statusChangedAt: new Date("2026-09-01T00:00:00Z"),
      source: "manual",
      ...over,
    },
  });
}

const fields = (over = {}) => ({
  kind: "technical" as const,
  status: "scheduled" as const,
  startsAt: new Date("2026-10-08T21:00:00.000Z"),
  endsAt: null,
  timezoneHint: null,
  meetingUrl: null,
  schedulingUrl: null,
  location: null,
  interviewers: [],
  icsUid: null,
  ...over,
});

describe("executePlan", () => {
  it("refuses a plan that needs review: it is stored, never run", async () => {
    await expect(
      run(
        plan([{ op: "create_company", ref: "new:company", company: company() }], [], {
          autoApply: false,
        }),
      ),
    ).rejects.toThrow(/needs review/);
    expect(await prisma.company.count()).toBe(0);
  });

  it("resolves refs created earlier in the plan, in array order, including inside event data", async () => {
    const result = await run(
      plan(
        [
          { op: "create_company", ref: "new:company", company: company() },
          {
            op: "create_contact",
            ref: "new:contact",
            email: "priya@quarry.example",
            name: "Priya Ramanathan",
            title: null,
            isAgency: false,
            company: { ref: "new:company" },
          },
          {
            op: "create_application",
            ref: "new:application",
            company: { ref: "new:company" },
            title: "Platform Engineer",
            jobUrl: null,
            jobKey: null,
            status: "interviewing",
            appliedAt: null,
            lastCompanyActivityAt: AT,
            source: "gmail",
          },
          {
            op: "upsert_interview",
            application: { ref: "new:application" },
            interviewId: null,
            expectedVersion: null,
            ref: "new:interview",
            fields: fields({ icsUid: "uid-1" }),
          },
          {
            op: "link_thread",
            threadId: "thr-1",
            application: { ref: "new:application" },
            leadRef: null,
          },
          { op: "attach_message", application: { ref: "new:application" } },
        ],
        [
          {
            subject: { ref: "new:application" },
            subjectType: "application",
            type: "application_created",
            summary: "Moved to Interviewing",
            data: { toStatus: "interviewing" },
          },
          {
            subject: { ref: "new:application" },
            subjectType: "application",
            type: "interview_created",
            summary: "Interview scheduled",
            data: { interview: "new:interview" },
          },
        ],
      ),
    );

    const application = await prisma.application.findFirstOrThrow();
    const interview = await prisma.interview.findFirstOrThrow();
    const contact = await prisma.contact.findFirstOrThrow();
    const created = await prisma.company.findFirstOrThrow();
    expect(result.refs).toEqual({
      "new:company": created.id,
      "new:contact": contact.id,
      "new:application": application.id,
      "new:interview": interview.id,
    });
    expect(contact.companyId).toBe(created.id);
    expect(application.companyId).toBe(created.id);
    expect(interview).toMatchObject({ applicationId: application.id, sourceMessageId: "m1" });
    expect(
      (await prisma.threadLink.findUniqueOrThrow({ where: { threadId: "thr-1" } })).applicationId,
    ).toBe(application.id);
    expect(
      (await prisma.gmailMessage.findUniqueOrThrow({ where: { id: "m1" } })).applicationId,
    ).toBe(application.id);
    const events = await prisma.event.findMany({ orderBy: { type: "asc" } });
    expect(events.map((e) => e.id).sort()).toEqual([...result.eventIds].sort());
    expect(events.find((e) => e.type === "interview_created")?.data).toEqual({
      interview: interview.id,
    });
    expect(events.find((e) => e.type === "application_created")).toMatchObject({
      applicationId: application.id,
      companyId: created.id,
      data: { toStatus: "interviewing" },
    });
  });

  it("an update that changes nothing does not bump the version or enter the change set", async () => {
    const application = await seedApplication();
    const result = await run(
      plan(
        [
          {
            op: "update_application",
            application: { id: application.id },
            expectedVersion: 1,
            set: { followUpDue: false, followUpDueSince: null },
          },
        ],
        [
          {
            subject: { id: application.id },
            subjectType: "application",
            type: "email_received",
            summary: "Email",
            data: null,
          },
        ],
      ),
    );
    expect(
      (await prisma.application.findUniqueOrThrow({ where: { id: application.id } })).version,
    ).toBe(1);
    const event = await prisma.event.findUniqueOrThrow({ where: { id: result.eventIds[0] ?? "" } });
    // Nothing changed, so there is nothing to undo.
    expect(event).toMatchObject({ changeSet: null, undoable: false });
  });

  it("an update with the wrong expected version throws and rolls the whole plan back", async () => {
    const application = await seedApplication({ version: 2 });
    await expect(
      run(
        plan([
          { op: "create_company", ref: "new:company", company: company("Other Co") },
          {
            op: "update_application",
            application: { id: application.id },
            expectedVersion: 1,
            set: { status: "rejected" },
          },
        ]),
      ),
    ).rejects.toBeInstanceOf(VersionConflictError);
    expect(await prisma.company.count()).toBe(1); // only the seeded one
    expect(
      (await prisma.application.findUniqueOrThrow({ where: { id: application.id } })).status,
    ).toBe("applied");
  });

  it("an application the owner deleted is a conflict too", async () => {
    await expect(
      run(
        plan([
          {
            op: "update_application",
            application: { id: "00000000-0000-4000-8000-000000000001" },
            expectedVersion: 1,
            set: { status: "rejected" },
          },
        ]),
      ),
    ).rejects.toBeInstanceOf(VersionConflictError);
  });

  it("an interview update keeps existing links, location, interviewers and zone that the email does not give", async () => {
    const application = await seedApplication();
    const interview = await prisma.interview.create({
      data: {
        applicationId: application.id,
        kind: "technical",
        status: "scheduled",
        startsAt: new Date("2026-10-07T21:00:00.000Z"),
        timezoneHint: "America/Monterrey",
        meetingUrl: "https://meet.quarry.example/room",
        schedulingUrl: "https://schedule.quarry.example/x",
        location: "Room 4",
        interviewers: ["Priya Ramanathan"],
        icsUid: "uid-1",
      },
    });
    await run(
      plan([
        {
          op: "upsert_interview",
          application: { id: application.id },
          interviewId: interview.id,
          expectedVersion: 1,
          ref: interview.id,
          fields: fields({ icsUid: "uid-1" }),
        },
      ]),
    );
    expect(await prisma.interview.findUniqueOrThrow({ where: { id: interview.id } })).toMatchObject(
      {
        startsAt: new Date("2026-10-08T21:00:00.000Z"),
        timezoneHint: "America/Monterrey",
        meetingUrl: "https://meet.quarry.example/room",
        schedulingUrl: "https://schedule.quarry.example/x",
        location: "Room 4",
        interviewers: ["Priya Ramanathan"],
        version: 2,
      },
    );

    // Given values replace the old ones.
    await run(
      plan(
        [
          {
            op: "upsert_interview",
            application: { id: application.id },
            interviewId: interview.id,
            expectedVersion: 2,
            ref: interview.id,
            fields: fields({
              meetingUrl: "https://meet.quarry.example/new",
              interviewers: ["Sam Okafor"],
              icsUid: "uid-1",
            }),
          },
        ],
        [],
      ),
      ctxFor({ messageId: null }),
    );
    expect(await prisma.interview.findUniqueOrThrow({ where: { id: interview.id } })).toMatchObject(
      {
        meetingUrl: "https://meet.quarry.example/new",
        interviewers: ["Sam Okafor"],
        version: 3,
      },
    );
  });

  it("cancels an interview, and a stale version conflicts", async () => {
    const application = await seedApplication();
    const interview = await prisma.interview.create({
      data: { applicationId: application.id, kind: "technical", status: "scheduled", startsAt: AT },
    });
    await expect(
      run(plan([{ op: "cancel_interview", interviewId: interview.id, expectedVersion: 5 }])),
    ).rejects.toBeInstanceOf(VersionConflictError);
    await run(plan([{ op: "cancel_interview", interviewId: interview.id, expectedVersion: 1 }]));
    expect(await prisma.interview.findUniqueOrThrow({ where: { id: interview.id } })).toMatchObject(
      {
        status: "cancelled",
        version: 2,
      },
    );
  });

  it("link_thread replaces an existing lead link", async () => {
    const application = await seedApplication();
    const batch = await prisma.intakeBatch.create({ data: { kind: "manual", counts: {} } });
    const lead = await prisma.lead.create({
      data: {
        companyId: application.companyId,
        intakeBatchId: batch.id,
        title: "Platform Engineer",
        statusChangedAt: AT,
        source: "gmail_recruiter",
      },
    });
    await prisma.threadLink.create({ data: { threadId: "thr-1", leadId: lead.id } });
    await run(
      plan([
        {
          op: "link_thread",
          threadId: "thr-1",
          application: { id: application.id },
          leadRef: null,
        },
      ]),
    );
    expect(
      await prisma.threadLink.findUniqueOrThrow({ where: { threadId: "thr-1" } }),
    ).toMatchObject({
      applicationId: application.id,
      leadId: null,
    });
  });

  it("convert_lead creates the application from the lead and marks the lead applied", async () => {
    const application = await seedApplication(); // only for a company
    const batch = await prisma.intakeBatch.create({ data: { kind: "manual", counts: {} } });
    const lead = await prisma.lead.create({
      data: {
        companyId: application.companyId,
        intakeBatchId: batch.id,
        title: "Staff Engineer",
        jobUrl: "https://jobs.quarry.example/staff",
        jobKey: "quarry:staff",
        workMode: "remote",
        statusChangedAt: new Date("2026-09-20T00:00:00Z"),
        source: "gmail_alert",
        status: "shortlisted",
      },
    });
    await prisma.threadLink.create({ data: { threadId: "thr-lead", leadId: lead.id } });
    const result = await run(
      plan(
        [
          {
            op: "convert_lead",
            leadId: lead.id,
            expectedVersion: 1,
            applicationRef: "new:application",
            status: "applied",
            appliedAt: AT,
          },
          {
            op: "update_application",
            application: { ref: "new:application" },
            expectedVersion: null,
            set: { lastCompanyActivityAt: AT },
          },
        ],
        [
          {
            subject: { ref: "new:application" },
            subjectType: "application",
            type: "lead_converted",
            summary: "Application received",
            data: { leadId: lead.id, toStatus: "applied" },
          },
        ],
      ),
    );
    const created = await prisma.application.findUniqueOrThrow({
      where: { id: result.refs["new:application"] ?? "" },
    });
    expect(created).toMatchObject({
      leadId: lead.id,
      title: "Staff Engineer",
      jobKey: "quarry:staff",
      workMode: "remote",
      status: "applied",
      appliedAt: AT,
      lastCompanyActivityAt: AT,
      source: "gmail",
    });
    expect(await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).toMatchObject({
      status: "applied",
      applicationId: created.id,
      version: 2,
    });
    expect(
      await prisma.threadLink.findUniqueOrThrow({ where: { threadId: "thr-lead" } }),
    ).toMatchObject({
      applicationId: created.id,
      leadId: lead.id,
    });

    const event = await prisma.event.findFirstOrThrow({ where: { type: "lead_converted" } });
    const entries = event.changeSet as { entity: string; [k: string]: unknown }[];
    // Created, then updated by a later operation: one entry, created, with the final fields.
    expect(entries.filter((e) => e.entity === "application")).toMatchObject([
      { id: created.id, created: true, before: null, versionAfter: 2 },
    ]);
    expect(entries.find((e) => e.entity === "lead")).toMatchObject({
      id: lead.id,
      created: false,
      before: { status: "shortlisted", applicationId: null },
      after: { status: "applied", applicationId: created.id },
      versionAfter: 2,
    });
  });

  it("convert_lead conflicts when the owner changed the lead", async () => {
    const application = await seedApplication();
    const batch = await prisma.intakeBatch.create({ data: { kind: "manual", counts: {} } });
    const lead = await prisma.lead.create({
      data: {
        companyId: application.companyId,
        intakeBatchId: batch.id,
        title: "Staff Engineer",
        statusChangedAt: AT,
        source: "gmail_alert",
        version: 3,
      },
    });
    await expect(
      run(
        plan([
          {
            op: "convert_lead",
            leadId: lead.id,
            expectedVersion: 2,
            applicationRef: "new:application",
            status: "applied",
            appliedAt: null,
          },
        ]),
      ),
    ).rejects.toBeInstanceOf(VersionConflictError);
    expect(await prisma.application.count()).toBe(1);
  });

  it("counts follow-ups on the owner-local day", async () => {
    await run(plan([{ op: "increment_daily_follow_ups", day: "2026-10-05" }]));
    await run(
      plan([{ op: "increment_daily_follow_ups", day: "2026-10-05" }]),
      ctxFor({ messageId: null }),
    );
    expect(await prisma.dailyActivity.findMany()).toMatchObject([
      { day: new Date("2026-10-05T00:00:00.000Z"), followUps: 2 },
    ]);
  });

  it("create_leads is not wired until T6.3: it throws NotImplementedError and writes nothing", async () => {
    await expect(
      run(
        plan([
          { op: "create_company", ref: "new:company", company: company() },
          { op: "create_leads", source: "gmail_alert", leads: [] },
        ]),
      ),
    ).rejects.toBeInstanceOf(NotImplementedError);
    expect(await prisma.company.count()).toBe(0);
  });
});

describe("executePlan: per-event change sets", () => {
  const entities = (changeSet: unknown) =>
    (changeSet as { entity: string }[]).map((e) => e.entity).sort();

  it("a plan that creates an application and an interview writes two events, each with only its own change set", async () => {
    await run(
      plan(
        [
          { op: "create_company", ref: "new:company", company: company() },
          {
            op: "create_application",
            ref: "new:application",
            company: { ref: "new:company" },
            title: "Platform Engineer",
            jobUrl: null,
            jobKey: null,
            status: "interviewing",
            appliedAt: null,
            lastCompanyActivityAt: AT,
            source: "gmail",
          },
          {
            op: "upsert_interview",
            application: { ref: "new:application" },
            interviewId: null,
            expectedVersion: null,
            ref: "new:interview",
            fields: fields(),
          },
          {
            op: "link_thread",
            threadId: "thr-1",
            application: { ref: "new:application" },
            leadRef: null,
          },
          { op: "attach_message", application: { ref: "new:application" } },
        ],
        [
          {
            subject: { ref: "new:application" },
            subjectType: "application",
            type: "application_created",
            summary: "Moved to Interviewing",
            data: { toStatus: "interviewing" },
          },
          {
            subject: { ref: "new:application" },
            subjectType: "application",
            type: "interview_created",
            summary: "Interview scheduled",
            data: { interview: "new:interview" },
          },
        ],
      ),
    );
    const application = await prisma.application.findFirstOrThrow();
    const interview = await prisma.interview.findFirstOrThrow();
    const created = await prisma.event.findFirstOrThrow({ where: { type: "application_created" } });
    const scheduled = await prisma.event.findFirstOrThrow({ where: { type: "interview_created" } });

    expect(entities(created.changeSet)).toEqual([
      "application",
      "company",
      "gmail_message",
      "thread_link",
    ]);
    expect(entities(scheduled.changeSet)).toEqual(["interview"]);
    expect(scheduled.changeSet).toMatchObject([
      { id: interview.id, created: true, before: null, versionAfter: 1 },
    ]);
    expect((created.changeSet as { id: string }[]).map((e) => e.id)).not.toContain(interview.id);
    expect((scheduled.changeSet as { id: string }[]).map((e) => e.id)).not.toContain(
      application.id,
    );
    expect(created.undoable).toBe(true);
    expect(scheduled.undoable).toBe(true);
  });

  it("undoing the interview event's change set leaves the application and its event alone", async () => {
    await run(
      plan(
        [
          { op: "create_company", ref: "new:company", company: company() },
          {
            op: "create_application",
            ref: "new:application",
            company: { ref: "new:company" },
            title: "Platform Engineer",
            jobUrl: null,
            jobKey: null,
            status: "interviewing",
            appliedAt: null,
            lastCompanyActivityAt: AT,
            source: "gmail",
          },
          {
            op: "upsert_interview",
            application: { ref: "new:application" },
            interviewId: null,
            expectedVersion: null,
            ref: "new:interview",
            fields: fields(),
          },
          { op: "attach_message", application: { ref: "new:application" } },
        ],
        [
          {
            subject: { ref: "new:application" },
            subjectType: "application",
            type: "application_created",
            summary: "Moved to Interviewing",
            data: { toStatus: "interviewing" },
          },
          {
            subject: { ref: "new:application" },
            subjectType: "application",
            type: "interview_created",
            summary: "Interview scheduled",
            data: { interview: "new:interview" },
          },
        ],
      ),
    );
    const scheduled = await prisma.event.findFirstOrThrow({ where: { type: "interview_created" } });
    // What an undo does with the created entries of one event: delete them (and that event).
    for (const entry of scheduled.changeSet as { entity: string; id: string; created: boolean }[]) {
      expect(entry.entity).toBe("interview");
      await prisma.interview.delete({ where: { id: entry.id } });
    }
    await prisma.event.delete({ where: { id: scheduled.id } });

    expect(await prisma.interview.count()).toBe(0);
    expect(await prisma.application.count()).toBe(1);
    expect(await prisma.company.count()).toBe(1);
    expect(
      (await prisma.gmailMessage.findUniqueOrThrow({ where: { id: "m1" } })).applicationId,
    ).not.toBeNull();
    expect(await prisma.event.findMany()).toMatchObject([{ type: "application_created" }]);
  });

  it("a status change and an interview update on one application each carry only their own record", async () => {
    const application = await seedApplication();
    const interview = await prisma.interview.create({
      data: { applicationId: application.id, kind: "technical", status: "scheduled", startsAt: AT },
    });
    await run(
      plan(
        [
          {
            op: "update_application",
            application: { id: application.id },
            expectedVersion: 1,
            set: { status: "interviewing", lastCompanyActivityAt: AT },
          },
          {
            op: "upsert_interview",
            application: { id: application.id },
            interviewId: interview.id,
            expectedVersion: 1,
            ref: interview.id,
            fields: fields(),
          },
          { op: "attach_message", application: { id: application.id } },
        ],
        [
          {
            subject: { id: application.id },
            subjectType: "application",
            type: "status_changed",
            summary: "Moved to Interviewing",
            data: { fromStatus: "applied", toStatus: "interviewing" },
          },
          {
            subject: { id: application.id },
            subjectType: "application",
            type: "interview_updated",
            summary: "Interview rescheduled",
            data: { interview: interview.id },
          },
        ],
      ),
    );
    const status = await prisma.event.findFirstOrThrow({ where: { type: "status_changed" } });
    const rescheduled = await prisma.event.findFirstOrThrow({
      where: { type: "interview_updated" },
    });
    expect(entities(status.changeSet)).toEqual(["application", "gmail_message"]);
    expect(entities(rescheduled.changeSet)).toEqual(["interview"]);
  });

  it("an interview event whose interview did not change has no change set and is not undoable", async () => {
    const application = await seedApplication();
    const interview = await prisma.interview.create({
      data: {
        applicationId: application.id,
        kind: "technical",
        status: "scheduled",
        startsAt: new Date("2026-10-08T21:00:00.000Z"),
      },
    });
    await run(
      plan(
        [
          {
            op: "upsert_interview",
            application: { id: application.id },
            interviewId: interview.id,
            expectedVersion: 1,
            ref: interview.id,
            fields: fields(),
          },
          { op: "attach_message", application: { id: application.id } },
        ],
        [
          {
            subject: { id: application.id },
            subjectType: "application",
            type: "interview_updated",
            summary: "Interview updated",
            data: { interview: interview.id },
          },
        ],
      ),
      ctxFor({ messageId: null }),
    );
    const event = await prisma.event.findFirstOrThrow({ where: { type: "interview_updated" } });
    expect(event).toMatchObject({ changeSet: null, undoable: false });
  });
});

describe("writeEvent", () => {
  it("is idempotent on (message, type, record) and returns the first id", async () => {
    const application = await seedApplication();
    const event = {
      applicationId: application.id,
      type: "status_changed" as const,
      actor: "system" as const,
      occurredAt: AT,
      messageId: "m1",
      summary: "Rejected",
      undoable: true,
    };
    const first = await withIntakeLock(prisma, (tx) => writeEvent(tx, event));
    const again = await withIntakeLock(prisma, async (tx) => {
      const id = await writeEvent(tx, { ...event, summary: "Different text" });
      // The transaction is still usable after the conflict.
      await tx.company.count();
      return id;
    });
    expect(again).toBe(first);
    expect(await prisma.event.count()).toBe(1);
    expect((await prisma.event.findUniqueOrThrow({ where: { id: first } })).summary).toBe(
      "Rejected",
    );

    const other = await withIntakeLock(prisma, (tx) =>
      writeEvent(tx, { ...event, type: "reopened" }),
    );
    expect(other).not.toBe(first);
    expect(await prisma.event.count()).toBe(2);
  });

  it("does not collapse events without a message", async () => {
    const application = await seedApplication();
    const event = {
      applicationId: application.id,
      type: "field_updated" as const,
      actor: "owner" as const,
      occurredAt: AT,
      summary: "Edited",
      undoable: false,
    };
    const a = await withIntakeLock(prisma, (tx) => writeEvent(tx, event));
    const b = await withIntakeLock(prisma, (tx) => writeEvent(tx, event));
    expect(a).not.toBe(b);
  });

  it("stores data and change set as JSON", async () => {
    const application = await seedApplication();
    const id = await withIntakeLock(prisma, (tx) =>
      writeEvent(tx, {
        applicationId: application.id,
        type: "status_changed",
        actor: "system",
        occurredAt: AT,
        messageId: "m1",
        summary: "Rejected",
        data: { fromStatus: "applied", toStatus: "rejected" },
        changeSet: [
          {
            entity: "application",
            id: application.id,
            created: false,
            before: { status: "applied", statusChangedAt: AT },
            after: { status: "rejected" },
            versionAfter: 2,
          },
        ],
        undoable: true,
      }),
    );
    expect(await prisma.event.findUniqueOrThrow({ where: { id } })).toMatchObject({
      data: { fromStatus: "applied", toStatus: "rejected" },
      changeSet: [
        {
          entity: "application",
          before: { status: "applied", statusChangedAt: AT.toISOString() },
          versionAfter: 2,
        },
      ],
      occurredAt: AT,
    });
  });
});

describe("createReviewItem", () => {
  const item = (over = {}) => ({
    kind: "low_confidence" as const,
    messageId: "m1",
    confidence: 0.5,
    plan: null,
    candidates: [],
    reasons: ["Confidence 50% is below the 80% threshold"],
    ...over,
  });

  it("is idempotent per open (message, kind), and a resolved item does not block a new one", async () => {
    const first = await withIntakeLock(prisma, (tx) => createReviewItem(tx, item()));
    const again = await withIntakeLock(prisma, (tx) =>
      createReviewItem(tx, item({ reasons: ["x"] })),
    );
    expect(again).toBe(first);
    expect(await prisma.reviewItem.count()).toBe(1);
    const other = await withIntakeLock(prisma, (tx) =>
      createReviewItem(tx, item({ kind: "ambiguous_match" })),
    );
    expect(other).not.toBe(first);

    await prisma.reviewItem.update({ where: { id: first }, data: { state: "resolved" } });
    const reopened = await withIntakeLock(prisma, (tx) => createReviewItem(tx, item()));
    expect(reopened).not.toBe(first);
  });

  it("stores the plan with dates as ISO strings, candidates and reasons", async () => {
    const id = await withIntakeLock(prisma, (tx) =>
      createReviewItem(
        tx,
        item({
          plan: plan(
            [
              {
                op: "update_application",
                application: { id: "a" },
                expectedVersion: 1,
                set: { lastCompanyActivityAt: AT },
              },
            ],
            [],
            { autoApply: false },
          ),
          candidates: [{ id: "c1", label: "Quarry AI — Platform Engineer (Applied)" }],
        }),
      ),
    );
    const stored = await prisma.reviewItem.findUniqueOrThrow({ where: { id } });
    expect(stored.candidates).toEqual([
      { id: "c1", label: "Quarry AI — Platform Engineer (Applied)" },
    ]);
    expect(stored.plan).toMatchObject({
      operations: [{ set: { lastCompanyActivityAt: AT.toISOString() } }],
    });
  });

  it("opens an item without a message each time", async () => {
    const a = await withIntakeLock(prisma, (tx) => createReviewItem(tx, item({ messageId: null })));
    const b = await withIntakeLock(prisma, (tx) => createReviewItem(tx, item({ messageId: null })));
    expect(a).not.toBe(b);
  });
});

describe("loadPlanSnapshot", () => {
  it("has state for every application and lead it lists, and the thread link", async () => {
    const application = await seedApplication();
    await prisma.interview.create({
      data: {
        applicationId: application.id,
        kind: "technical",
        status: "to_schedule",
        icsUid: "u1",
      },
    });
    const batch = await prisma.intakeBatch.create({ data: { kind: "manual", counts: {} } });
    const open = await prisma.lead.create({
      data: {
        companyId: application.companyId,
        intakeBatchId: batch.id,
        title: "Open lead",
        statusChangedAt: AT,
        source: "manual",
        version: 4,
      },
    });
    const done = await prisma.lead.create({
      data: {
        companyId: application.companyId,
        intakeBatchId: batch.id,
        title: "Applied lead",
        statusChangedAt: AT,
        source: "manual",
        status: "applied",
      },
    });
    await prisma.threadLink.create({ data: { threadId: "thr-1", leadId: done.id } });
    await prisma.contact.create({
      data: { email: "Priya@Quarry.example", companyId: application.companyId },
    });

    const message = {
      id: "m1",
      threadId: "thr-1",
      internalDate: AT,
      direction: "inbound" as const,
      fromEmail: "priya@quarry.example",
      icsEvents: [],
    };
    const snapshot = await withIntakeLock(prisma, (tx) =>
      loadPlanSnapshot(tx, message, extraction(), "America/Monterrey"),
    );
    expect(snapshot.ownerTimezone).toBe("America/Monterrey");
    for (const a of snapshot.applications) expect(snapshot.applicationState.has(a.id)).toBe(true);
    for (const l of snapshot.leads) expect(snapshot.leadState.has(l.id)).toBe(true);
    expect(snapshot.applicationState.get(application.id)).toMatchObject({
      version: 1,
      status: "applied",
    });
    // An applied lead is left out unless the thread is linked to it.
    expect(snapshot.leads.map((l) => l.id).sort()).toEqual([open.id, done.id].sort());
    expect(snapshot.leadState.get(open.id)).toEqual({ version: 4, status: "new" });
    expect(snapshot.threadLinks.get("thr-1")).toEqual({ applicationId: null, leadId: done.id });
    expect(snapshot.interviews.get(application.id)).toMatchObject([
      { kind: "technical", status: "to_schedule", icsUid: "u1", version: 1 },
    ]);
    expect(snapshot.companyIndex.contacts).toHaveLength(1);
    expect(snapshot.companyIndex.companies[0]).toMatchObject({ normalizedName: "quarry ai" });
  });
});

function company(name = "Quarry AI") {
  return {
    name,
    normalizedName: name.toLowerCase(),
    domains: ["quarry.example"],
    atsSlugs: [],
    websiteDomain: null,
  };
}
