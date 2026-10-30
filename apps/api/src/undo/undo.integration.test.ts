import type { Prisma } from "@prisma/client";
import { DEFAULT_SETTINGS, type ApiErrorBody } from "@offerbound/contracts";
import type { ChangePlan, Operation, PlannedEvent } from "@offerbound/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp, signIn } from "../../test/app.js";
import { resetDb, testPrisma } from "../../test/db.js";
import { writeEvent, type ChangeSetEntry } from "../db/events.js";
import { withIntakeLock } from "../db/lock.js";
import { ApiError } from "../http/errors.js";
import { executePlan, type PlanContext } from "../pipeline/execute-plan.js";
import { undoEvent } from "./service.js";

const prisma = testPrisma();
const AT = new Date("2026-10-05T10:00:00.000Z");
const NOW = new Date("2026-10-06T09:00:00.000Z");

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

const ctx: PlanContext = {
  messageId: "m1",
  occurredAt: AT,
  actor: "system",
  settings: DEFAULT_SETTINGS,
};

function plan(operations: Operation[], events: PlannedEvent[] = []): ChangePlan {
  return {
    operations,
    events,
    autoApply: true,
    confidence: 0.95,
    review: null,
    notices: [],
    messageOutcome: "applied",
  };
}

const run = (p: ChangePlan, over: Partial<PlanContext> = {}) =>
  withIntakeLock(prisma, (tx) => executePlan(tx, p, { ...ctx, ...over }));

const company = (name = "Quarry AI") => ({
  name,
  normalizedName: name.toLowerCase(),
  domains: ["quarry.example"],
  atsSlugs: [],
  websiteDomain: null,
});

const interviewFields = {
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
};

/** What an application confirmation does: company, contact, application, interview, links. */
async function runConfirmation() {
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
          appliedAt: AT,
          lastCompanyActivityAt: AT,
          source: "gmail",
        },
        {
          op: "upsert_interview",
          application: { ref: "new:application" },
          interviewId: null,
          expectedVersion: null,
          ref: "new:interview",
          fields: interviewFields,
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
  const applicationId = result.refs["new:application"] ?? "";
  const events = await prisma.event.findMany({ where: { applicationId } });
  return {
    applicationId,
    companyId: result.refs["new:company"] ?? "",
    contactId: result.refs["new:contact"] ?? "",
    interviewId: result.refs["new:interview"] ?? "",
    created: events.find((e) => e.type === "application_created")!,
    interviewEvent: events.find((e) => e.type === "interview_created")!,
  };
}

async function seedApplication(over: Partial<Prisma.ApplicationUncheckedCreateInput> = {}) {
  const co = await prisma.company.create({
    data: { name: "Quarry AI", normalizedName: "quarry ai", createdSource: "manual" },
  });
  return prisma.application.create({
    data: {
      companyId: co.id,
      title: "Platform Engineer",
      status: "applied",
      statusChangedAt: new Date("2026-09-01T00:00:00Z"),
      source: "manual",
      ...over,
    },
  });
}

async function seedLead(companyId: string, over: Partial<Prisma.LeadUncheckedCreateInput> = {}) {
  const batch = await prisma.intakeBatch.create({ data: { kind: "manual", counts: {} } });
  return prisma.lead.create({
    data: {
      companyId,
      intakeBatchId: batch.id,
      title: "Staff Engineer",
      statusChangedAt: new Date("2026-09-20T00:00:00Z"),
      source: "gmail_alert",
      status: "shortlisted",
      ...over,
    },
  });
}

/** A status change by the pipeline: the application moves on and one event says so. */
async function runStatusChange(applicationId: string, version: number) {
  const result = await run(
    plan(
      [
        {
          op: "update_application",
          application: { id: applicationId },
          expectedVersion: version,
          set: { status: "interviewing", lastCompanyActivityAt: AT, followUpDue: false },
        },
      ],
      [
        {
          subject: { id: applicationId },
          subjectType: "application",
          type: "status_changed",
          summary: "Moved to Interviewing",
          data: { from: "applied", to: "interviewing" },
        },
      ],
    ),
  );
  return result.eventIds[0] ?? "";
}

const expectApiError = async (promise: Promise<unknown>, status: number, code: string) => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ status, code });
};

describe("undoEvent", () => {
  it("restores every before field and bumps versions", async () => {
    const application = await seedApplication({ followUpDue: true, followUpDueSince: AT });
    const eventId = await runStatusChange(application.id, 1);
    const changed = await prisma.application.findUniqueOrThrow({ where: { id: application.id } });
    expect(changed).toMatchObject({ status: "interviewing", version: 2, followUpDue: false });

    await undoEvent(prisma, eventId, NOW);

    expect(
      await prisma.application.findUniqueOrThrow({ where: { id: application.id } }),
    ).toMatchObject({
      status: "applied",
      statusChangedAt: application.statusChangedAt,
      lastCompanyActivityAt: null,
      followUpDue: true,
      followUpDueSince: AT,
      version: 3,
    });
  });

  it("restores an interview the change updated and puts a message link back", async () => {
    const application = await seedApplication();
    const interview = await prisma.interview.create({
      data: {
        applicationId: application.id,
        kind: "technical",
        status: "scheduled",
        startsAt: new Date("2026-10-07T21:00:00.000Z"),
      },
    });
    const result = await run(
      plan(
        [
          {
            op: "upsert_interview",
            application: { id: application.id },
            interviewId: interview.id,
            expectedVersion: 1,
            ref: "new:interview",
            fields: { ...interviewFields, startsAt: new Date("2026-10-09T21:00:00.000Z") },
          },
          { op: "attach_message", application: { id: application.id } },
        ],
        [
          {
            subject: { id: application.id },
            subjectType: "application",
            type: "interview_updated",
            summary: "Interview moved",
            data: { interviewId: interview.id },
          },
        ],
      ),
    );
    await undoEvent(prisma, result.eventIds[0] ?? "", NOW);
    expect(await prisma.interview.findUniqueOrThrow({ where: { id: interview.id } })).toMatchObject(
      {
        startsAt: new Date("2026-10-07T21:00:00.000Z"),
        sourceMessageId: null,
        version: 3,
      },
    );
    expect(
      (await prisma.gmailMessage.findUniqueOrThrow({ where: { id: "m1" } })).applicationId,
    ).toBeNull();
  });

  it("deletes an application the change created, with its interviews and events", async () => {
    const made = await runConfirmation();
    expect(await prisma.interview.count()).toBe(1);

    await undoEvent(prisma, made.created.id, NOW);

    expect(await prisma.application.count()).toBe(0);
    expect(await prisma.interview.count()).toBe(0);
    expect(await prisma.threadLink.count()).toBe(0);
    expect(
      await prisma.event.findMany({
        where: { type: { in: ["application_created", "interview_created"] } },
      }),
    ).toEqual([]);
    expect(
      (await prisma.gmailMessage.findUniqueOrThrow({ where: { id: "m1" } })).applicationId,
    ).toBeNull();
    // Nothing else referenced the company and the contact, so they go too.
    expect(await prisma.company.count()).toBe(0);
    expect(await prisma.contact.count()).toBe(0);
  });

  it("undoing only the interview event leaves the application alone", async () => {
    const made = await runConfirmation();
    await undoEvent(prisma, made.interviewEvent.id, NOW);
    expect(await prisma.interview.count()).toBe(0);
    expect(await prisma.application.count()).toBe(1);
    expect(
      await prisma.event.findUniqueOrThrow({ where: { id: made.interviewEvent.id } }),
    ).toMatchObject({ undoneAt: NOW });
  });

  it("deletes a created company or contact only when nothing else references it", async () => {
    const made = await runConfirmation();
    // The owner later added a second application at the company, and a lead names the contact.
    await prisma.application.create({
      data: {
        companyId: made.companyId,
        title: "Data Engineer",
        status: "applied",
        statusChangedAt: AT,
        source: "manual",
      },
    });
    await seedLead(made.companyId, { contactId: made.contactId });

    await undoEvent(prisma, made.created.id, NOW);

    expect(await prisma.application.count()).toBe(1);
    expect(await prisma.company.findUnique({ where: { id: made.companyId } })).not.toBeNull();
    expect(await prisma.contact.findUnique({ where: { id: made.contactId } })).not.toBeNull();
  });

  it("deletes a lead the change created and the company that lead created", async () => {
    const result = await run(
      plan([
        {
          op: "create_leads",
          source: "gmail_recruiter",
          leads: [
            {
              ref: "new:lead:0",
              order: 0,
              source: "gmail_recruiter",
              companyName: "Sable Robotics",
              companyDomain: null,
              title: "Staff Engineer",
              jobUrl: "https://boards.greenhouse.io/sable/jobs/900",
              locationText: null,
              country: null,
              workMode: "remote",
              compensationText: null,
              sponsorshipText: null,
              postedAt: null,
              seniority: null,
              ranking: null,
              verification: null,
              pageExcerpt: null,
              sheetStatus: null,
              notes: null,
              contactEmail: null,
            },
          ],
        },
        { op: "link_thread", threadId: "thr-1", application: null, leadRef: "new:lead:0" },
      ]),
    );
    expect(await prisma.lead.count()).toBe(1);
    await undoEvent(prisma, result.eventIds[0] ?? "", NOW);
    expect(await prisma.lead.count()).toBe(0);
    expect(await prisma.company.count()).toBe(0);
    expect(await prisma.threadLink.count()).toBe(0);
    expect(await prisma.event.findMany({ select: { type: true } })).toEqual([{ type: "undone" }]);
  });

  it("returns a lead converted by the change to its status before conversion, with application_id null", async () => {
    const co = await prisma.company.create({
      data: { name: "Quarry AI", normalizedName: "quarry ai", createdSource: "manual" },
    });
    const lead = await seedLead(co.id, { jobKey: "quarry:staff" });
    await prisma.threadLink.create({ data: { threadId: "thr-1", leadId: lead.id } });
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
    expect(await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).toMatchObject({
      status: "applied",
    });

    await undoEvent(prisma, result.eventIds[0] ?? "", NOW);

    expect(await prisma.application.count()).toBe(0);
    expect(await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).toMatchObject({
      status: "shortlisted",
      statusChangedAt: lead.statusChangedAt,
      applicationId: null,
      version: 3,
    });
    expect(
      await prisma.threadLink.findUniqueOrThrow({ where: { threadId: "thr-1" } }),
    ).toMatchObject({
      leadId: lead.id,
      applicationId: null,
    });
    // The lead_converted event went with the application; the undo is written against the lead.
    expect(await prisma.event.findMany({ select: { type: true, leadId: true } })).toEqual([
      { type: "undone", leadId: lead.id },
    ]);
  });

  it("the lead_converted event from Mark applied can be undone", async () => {
    // The shape Mark applied writes: the application it created, the lead as it was (dates as ISO
    // strings), the thread link it moved, and an event on both the application and the lead.
    const co = await prisma.company.create({
      data: { name: "Quarry AI", normalizedName: "quarry ai", createdSource: "manual" },
    });
    const statusChangedAt = new Date("2026-09-20T12:00:00.000Z");
    const lead = await seedLead(co.id, {
      status: "dismissed",
      dismissedReason: "Not for me",
      statusChangedAt,
      jobKey: "quarry:staff",
    });
    await prisma.threadLink.create({ data: { threadId: "thr-lead", leadId: lead.id } });
    const application = await prisma.application.create({
      data: {
        companyId: co.id,
        leadId: lead.id,
        title: "Staff Engineer",
        jobKey: "quarry:staff",
        status: "applied",
        statusChangedAt: NOW,
        appliedAt: NOW,
        source: "lead_conversion",
      },
    });
    await prisma.lead.update({
      where: { id: lead.id },
      data: {
        status: "applied",
        statusChangedAt: NOW,
        applicationId: application.id,
        dismissedReason: null,
        version: 2,
      },
    });
    await prisma.threadLink.update({
      where: { threadId: "thr-lead" },
      data: { applicationId: application.id },
    });
    const changeSet: ChangeSetEntry[] = [
      {
        entity: "application",
        id: application.id,
        created: true,
        before: null,
        after: { title: "Staff Engineer" },
        versionAfter: 1,
      },
      {
        entity: "lead",
        id: lead.id,
        created: false,
        before: JSON.parse(
          JSON.stringify({
            status: "dismissed",
            statusChangedAt,
            applicationId: null,
            suppressedReason: null,
            dismissedReason: "Not for me",
          }),
        ) as Record<string, unknown>,
        after: { status: "applied", applicationId: application.id },
        versionAfter: 2,
      },
      {
        entity: "thread_link",
        id: "thr-lead",
        created: false,
        before: { applicationId: null },
        after: { applicationId: application.id },
        versionAfter: null,
      },
    ];
    const eventId = await withIntakeLock(prisma, (tx) =>
      writeEvent(tx, {
        applicationId: application.id,
        leadId: lead.id,
        companyId: co.id,
        type: "lead_converted",
        actor: "owner",
        occurredAt: NOW,
        summary: "Marked as applied",
        data: { toStatus: "applied", fromLeadStatus: "dismissed" },
        changeSet,
        undoable: true,
      }),
    );

    await undoEvent(prisma, eventId, new Date("2026-10-06T09:05:00.000Z"));

    expect(await prisma.application.count()).toBe(0);
    expect(await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).toMatchObject({
      status: "dismissed",
      dismissedReason: "Not for me",
      statusChangedAt,
      applicationId: null,
      version: 3,
    });
    expect(
      await prisma.threadLink.findUniqueOrThrow({ where: { threadId: "thr-lead" } }),
    ).toMatchObject({ applicationId: null, leadId: lead.id });
    const events = await prisma.event.findMany();
    expect(events).toMatchObject([{ type: "undone", leadId: lead.id, applicationId: null }]);
    // An owner action has no source email, so no review item.
    expect(await prisma.reviewItem.count()).toBe(0);
  });

  it("a record changed since → 409 changed_since and nothing changes", async () => {
    const made = await runConfirmation();
    // The owner edits the application after the pipeline created it (owner edits take no lock).
    await prisma.application.update({
      where: { id: made.applicationId },
      data: { notes: "Spoke to Priya", version: { increment: 1 } },
    });
    const before = {
      applications: await prisma.application.findMany(),
      interviews: await prisma.interview.findMany(),
      events: await prisma.event.findMany({ orderBy: { id: "asc" } }),
      companies: await prisma.company.findMany(),
      contacts: await prisma.contact.findMany(),
      links: await prisma.threadLink.findMany(),
      messages: await prisma.gmailMessage.findMany(),
    };

    await expectApiError(undoEvent(prisma, made.created.id, NOW), 409, "changed_since");

    expect({
      applications: await prisma.application.findMany(),
      interviews: await prisma.interview.findMany(),
      events: await prisma.event.findMany({ orderBy: { id: "asc" } }),
      companies: await prisma.company.findMany(),
      contacts: await prisma.contact.findMany(),
      links: await prisma.threadLink.findMany(),
      messages: await prisma.gmailMessage.findMany(),
    }).toEqual(before);
    expect(await prisma.reviewItem.count()).toBe(0);
  });

  it("an update whose record the owner edited since → 409 changed_since", async () => {
    const application = await seedApplication();
    const eventId = await runStatusChange(application.id, 1);
    await prisma.application.update({
      where: { id: application.id },
      data: { notes: "edited", version: { increment: 1 } },
    });
    await expectApiError(undoEvent(prisma, eventId, NOW), 409, "changed_since");
    expect(
      await prisma.application.findUniqueOrThrow({ where: { id: application.id } }),
    ).toMatchObject({ status: "interviewing", notes: "edited", version: 3 });
    expect((await prisma.event.findUniqueOrThrow({ where: { id: eventId } })).undoneAt).toBeNull();
  });

  it("refuses to delete an application that has an interview a later change added", async () => {
    const made = await runConfirmation();
    await prisma.interview.create({
      data: {
        applicationId: made.applicationId,
        kind: "onsite_loop",
        status: "to_schedule",
        sourceMessageId: null,
      },
    });
    await expectApiError(undoEvent(prisma, made.created.id, NOW), 409, "changed_since");
    expect(await prisma.application.count()).toBe(1);
    expect(await prisma.interview.count()).toBe(2);
    expect(await prisma.event.count()).toBe(2);
  });

  it("refuses to delete an application that has an event a later email added", async () => {
    const made = await runConfirmation();
    await prisma.gmailMessage.create({
      data: {
        id: "m2",
        threadId: "thr-1",
        internalDate: NOW,
        direction: "inbound",
        labelIds: [],
        state: "extracted",
      },
    });
    await withIntakeLock(prisma, (tx) =>
      writeEvent(tx, {
        applicationId: made.applicationId,
        type: "email_received",
        actor: "system",
        occurredAt: NOW,
        messageId: "m2",
        summary: "Email",
        undoable: false,
      }),
    );
    await expectApiError(undoEvent(prisma, made.created.id, NOW), 409, "changed_since");
    expect(await prisma.application.count()).toBe(1);
    expect(await prisma.event.count()).toBe(3);
  });

  it("lowers the follow-up count by what the change added", async () => {
    const application = await seedApplication({ followUpDue: true, followUpDueSince: AT });
    await prisma.dailyActivity.create({
      data: { day: new Date("2026-10-05T00:00:00.000Z"), followUps: 2 },
    });
    const result = await run(
      plan(
        [
          { op: "increment_daily_follow_ups", day: "2026-10-05" },
          {
            op: "update_application",
            application: { id: application.id },
            expectedVersion: 1,
            set: { followUpDue: false, lastOutboundAt: AT },
          },
        ],
        [
          {
            subject: { id: application.id },
            subjectType: "application",
            type: "follow_up_done",
            summary: "Follow-up sent",
            data: null,
          },
        ],
      ),
    );
    // The owner logs another follow-up by hand afterwards.
    await prisma.dailyActivity.update({
      where: { day: new Date("2026-10-05T00:00:00.000Z") },
      data: { followUps: 4 },
    });
    await undoEvent(prisma, result.eventIds[0] ?? "", NOW);
    expect(
      (
        await prisma.dailyActivity.findUniqueOrThrow({
          where: { day: new Date("2026-10-05T00:00:00.000Z") },
        })
      ).followUps,
    ).toBe(3);
    expect(
      await prisma.application.findUniqueOrThrow({ where: { id: application.id } }),
    ).toMatchObject({ followUpDue: true, lastOutboundAt: null });
  });

  it("writes an undone event, sets undone_at and opens an undone_change review item for the source message", async () => {
    const application = await seedApplication();
    const eventId = await runStatusChange(application.id, 1);

    await undoEvent(prisma, eventId, NOW);

    const original = await prisma.event.findUniqueOrThrow({ where: { id: eventId } });
    const undone = await prisma.event.findFirstOrThrow({ where: { type: "undone" } });
    expect(original).toMatchObject({ undoneAt: NOW, undoneByEventId: undone.id });
    expect(undone).toMatchObject({
      applicationId: application.id,
      actor: "owner",
      occurredAt: NOW,
      undoable: false,
      changeSet: null,
      data: { undoes: eventId, undoneType: "status_changed", messageId: "m1" },
    });
    expect(await prisma.reviewItem.findMany()).toMatchObject([
      { kind: "undone_change", state: "open", messageId: "m1", applicationId: application.id },
    ]);
  });

  it("keeps the review item when the undo deleted the application", async () => {
    const made = await runConfirmation();
    await undoEvent(prisma, made.created.id, NOW);
    expect(await prisma.reviewItem.findMany()).toMatchObject([
      { kind: "undone_change", messageId: "m1", applicationId: null },
    ]);
    // The undo is still on record, though its application is gone.
    expect(await prisma.event.findMany({ select: { type: true } })).toEqual([{ type: "undone" }]);
  });

  it("undoing the interview event and then the application event of one email both succeed", async () => {
    const made = await runConfirmation();
    await undoEvent(prisma, made.interviewEvent.id, NOW);
    // The first undo's own event sits on the application and must not block undoing it.
    await undoEvent(prisma, made.created.id, NOW);
    expect(await prisma.application.count()).toBe(0);
    // The first undone event went with the application; the second has no subject left to hang on.
    expect(await prisma.event.findMany({ select: { type: true } })).toEqual([{ type: "undone" }]);
    expect(await prisma.reviewItem.count()).toBe(1); // one open item per email
  });

  it("imported, undone and owner-edit events → 400; a second undo → 409 changed_since", async () => {
    const application = await seedApplication();
    const write = (type: "imported" | "field_updated", actor: "system" | "owner") =>
      withIntakeLock(prisma, (tx) =>
        writeEvent(tx, {
          applicationId: application.id,
          type,
          actor,
          occurredAt: AT,
          summary: type,
          undoable: false,
        }),
      );
    const imported = await write("imported", "system");
    const edit = await write("field_updated", "owner");
    await expectApiError(undoEvent(prisma, imported, NOW), 400, "validation_failed");
    await expectApiError(undoEvent(prisma, edit, NOW), 400, "validation_failed");

    const eventId = await runStatusChange(application.id, 1);
    await undoEvent(prisma, eventId, NOW);
    const undone = await prisma.event.findFirstOrThrow({ where: { type: "undone" } });
    await expectApiError(undoEvent(prisma, undone.id, NOW), 400, "validation_failed");
    await expectApiError(undoEvent(prisma, eventId, NOW), 409, "changed_since");
    expect(await prisma.event.count({ where: { type: "undone" } })).toBe(1);
  });

  it("an event with nothing to undo → 400", async () => {
    const application = await seedApplication();
    const result = await run(
      plan(
        [],
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
    await expectApiError(
      undoEvent(prisma, result.eventIds[0] ?? "", NOW),
      400,
      "validation_failed",
    );
  });

  it("an unknown or malformed event id → 404", async () => {
    await expectApiError(
      undoEvent(prisma, "00000000-0000-4000-8000-000000000001", NOW),
      404,
      "not_found",
    );
    await expectApiError(undoEvent(prisma, "nope", NOW), 404, "not_found");
  });
});

describe("undo frees the idempotency slot", () => {
  it("undo, then the same email's event again, then a second undo works", async () => {
    const application = await seedApplication();
    const first = await runStatusChange(application.id, 1);
    await undoEvent(prisma, first, NOW);
    // The undo bumped the version to 3; the email is planned again (reprocess) and writes the same
    // (message, type, record) event, which the undone one no longer blocks.
    const again = await runStatusChange(application.id, 3);
    expect(again).not.toBe(first);
    expect(await prisma.event.count({ where: { type: "status_changed" } })).toBe(2);

    await undoEvent(prisma, again, new Date("2026-10-07T09:00:00.000Z"));

    expect(
      await prisma.application.findUniqueOrThrow({ where: { id: application.id } }),
    ).toMatchObject({ status: "applied" });
    expect(await prisma.event.findMany({ where: { type: "status_changed" } })).toMatchObject([
      { id: first, undoneAt: NOW },
      { id: again, undoneAt: new Date("2026-10-07T09:00:00.000Z") },
    ]);
  });

  it("a live event still blocks a duplicate", async () => {
    const application = await seedApplication();
    const first = await runStatusChange(application.id, 1);
    const second = await withIntakeLock(prisma, (tx) =>
      writeEvent(tx, {
        applicationId: application.id,
        type: "status_changed",
        actor: "system",
        occurredAt: AT,
        messageId: "m1",
        summary: "Moved to Interviewing",
        undoable: true,
      }),
    );
    expect(second).toBe(first);
    expect(await prisma.event.count({ where: { type: "status_changed" } })).toBe(1);
  });
});

describe("undoing a created lead", () => {
  const leadPlan = () =>
    plan([
      {
        op: "create_leads",
        source: "gmail_recruiter",
        leads: [
          {
            ref: "new:lead:0",
            order: 0,
            source: "gmail_recruiter",
            companyName: "Sable Robotics",
            companyDomain: null,
            title: "Staff Engineer",
            jobUrl: "https://boards.greenhouse.io/sable/jobs/900",
            locationText: null,
            country: null,
            workMode: "remote",
            compensationText: null,
            sponsorshipText: null,
            postedAt: null,
            seniority: null,
            ranking: null,
            verification: null,
            pageExcerpt: null,
            sheetStatus: null,
            notes: null,
            contactEmail: null,
          },
        ],
      },
    ]);

  it("still deletes a lead that the link check and rank bumped to a later version", async () => {
    const result = await run(leadPlan());
    const lead = await prisma.lead.findFirstOrThrow();
    // What leads.check and leads.rank do to a lead: they bump the version, owner or not.
    await prisma.lead.update({
      where: { id: lead.id },
      data: { pipelineState: "ready", version: { increment: 2 }, fitScore: 80 },
    });

    await undoEvent(prisma, result.eventIds[0] ?? "", NOW);

    expect(await prisma.lead.count()).toBe(0);
    expect(await prisma.company.count()).toBe(0);
  });

  it("refuses when the owner acted on the lead (shortlisted)", async () => {
    const result = await run(leadPlan());
    const lead = await prisma.lead.findFirstOrThrow();
    await prisma.lead.update({
      where: { id: lead.id },
      data: { status: "shortlisted", version: { increment: 1 } },
    });
    await expectApiError(undoEvent(prisma, result.eventIds[0] ?? "", NOW), 409, "changed_since");
    expect(await prisma.lead.count()).toBe(1);
  });

  it("refuses when the lead already became an application", async () => {
    const result = await run(leadPlan());
    const lead = await prisma.lead.findFirstOrThrow();
    const app = await prisma.application.create({
      data: {
        companyId: lead.companyId,
        title: "Staff Engineer",
        status: "applied",
        statusChangedAt: AT,
        source: "manual",
      },
    });
    await prisma.lead.update({
      where: { id: lead.id },
      data: { applicationId: app.id, status: "applied" },
    });
    await expectApiError(undoEvent(prisma, result.eventIds[0] ?? "", NOW), 409, "changed_since");
    expect(await prisma.lead.count()).toBe(1);
  });
});

describe("POST /events/:id/undo", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function appWith() {
    const built = await buildTestApp({ clock: () => NOW });
    apps.push(built.app);
    const cookie = await signIn(built.app, built.deps);
    return (id: string, headers: Record<string, string> = { "x-offerbound-request": "1" }) =>
      built.app.inject({
        method: "POST",
        url: `/api/v1/events/${id}/undo`,
        headers: { cookie, ...headers },
      });
  }

  it("answers 200 { undone: true }, then 409 changed_since for a second undo", async () => {
    const call = await appWith();
    const application = await seedApplication();
    const eventId = await runStatusChange(application.id, 1);
    const first = await call(eventId);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ undone: true });
    const second = await call(eventId);
    expect(second.statusCode).toBe(409);
    expect(second.json<ApiErrorBody>().error.code).toBe("changed_since");
  });

  it("answers 400 for an event that can't be undone and 404 for an unknown one", async () => {
    const call = await appWith();
    const application = await seedApplication();
    const edit = await withIntakeLock(prisma, (tx) =>
      writeEvent(tx, {
        applicationId: application.id,
        type: "field_updated",
        actor: "owner",
        occurredAt: AT,
        summary: "Edited",
        undoable: false,
      }),
    );
    const refused = await call(edit);
    expect(refused.statusCode).toBe(400);
    expect(refused.json<ApiErrorBody>().error.code).toBe("validation_failed");
    const missing = await call("00000000-0000-4000-8000-000000000001");
    expect(missing.statusCode).toBe(404);
    expect(missing.json<ApiErrorBody>().error.code).toBe("not_found");
  });

  it("needs the CSRF header", async () => {
    const call = await appWith();
    const res = await call("00000000-0000-4000-8000-000000000001", {});
    expect(res.statusCode).toBe(403);
  });
});
