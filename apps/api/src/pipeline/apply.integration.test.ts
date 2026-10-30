import type { Extraction } from "@offerbound/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  extraction,
  recordCounts,
  seedMessage,
  stateOf,
  type SeedMessage,
} from "../../test/apply.js";
import { resetDb, testPrisma } from "../../test/db.js";
import { interceptTx } from "../../test/intercept.js";
import { RecordingQueue } from "../../test/queue.js";
import { testWorkerCtx } from "../../test/worker.js";
import { jobKey } from "@offerbound/domain";
import { HANDLERS } from "../jobs/handlers.js";
import { QUEUES } from "../jobs/queues.js";
import { applyEligibleMessages, MAX_APPLY_ATTEMPTS } from "./apply.js";
import { NO_CONTENT } from "./triage.js";

const prisma = testPrisma();
const ctx = () => testWorkerCtx();

beforeEach(async () => {
  await resetDb(prisma);
});

const rejection = (over: Partial<Extraction> = {}) =>
  extraction({ category: "rejection", summary: "Rejected", ...over });
const confirmation = (over: Partial<Extraction> = {}) => extraction(over);

const seed = (m: SeedMessage) => seedMessage(prisma, m);
const apps = () => prisma.application.findMany({ orderBy: { createdAt: "asc" } });

/** Finishes extraction for a message that was waiting in `job_related`. */
async function finishExtraction(id: string, e: Extraction): Promise<void> {
  await prisma.gmailMessage.update({
    where: { id },
    data: {
      state: "extracted",
      extraction: e as never,
      category: e.category,
      extractConfidence: e.confidence,
      summary: e.summary,
    },
  });
}

describe("applyEligibleMessages: ordering", () => {
  it("applies in internal_date order even when extraction finishes out of order", async () => {
    // AC-3.8: the rejection (later) is extracted first; the confirmation is still being extracted.
    await seed({ id: "confirm", at: "2026-10-05T10:00:00.000Z", state: "job_related" });
    await seed({
      id: "reject",
      at: "2026-10-06T10:00:00.000Z",
      extraction: rejection(),
      threadId: "thr-reject",
    });

    expect(await applyEligibleMessages(ctx())).toEqual({ applied: 0 });
    expect(await stateOf(prisma, "reject")).toBe("extracted");
    expect(await recordCounts(prisma)).toMatchObject({ applications: 0, events: 0 });

    await finishExtraction("confirm", confirmation());
    expect(await applyEligibleMessages(ctx())).toEqual({ applied: 2 });

    const [application] = await apps();
    expect(application).toMatchObject({
      status: "rejected",
      appliedAt: new Date("2026-10-05T10:00:00.000Z"),
    });
    const events = await prisma.event.findMany({ orderBy: { occurredAt: "asc" } });
    expect(events.map((e) => [e.type, e.messageId])).toEqual([
      ["application_created", "confirm"],
      ["status_changed", "reject"],
    ]);
    expect(await prisma.reviewItem.count()).toBe(0);
  });

  it("waits while a pending message has the same internal_date", async () => {
    const at = "2026-10-05T10:00:00.000Z";
    await seed({ id: "pending", at, state: "job_related" });
    await seed({ id: "same", at, extraction: confirmation() });
    await seed({
      id: "later",
      at: "2026-10-05T10:00:00.001Z",
      extraction: rejection(),
      threadId: "t-later",
    });

    expect(await applyEligibleMessages(ctx())).toEqual({ applied: 0 });
    expect(await stateOf(prisma, "same")).toBe("extracted");
    expect(await stateOf(prisma, "later")).toBe("extracted");

    // Once the pending message is out of the way, both go, in order.
    await prisma.gmailMessage.update({ where: { id: "pending" }, data: { state: "failed" } });
    expect(await applyEligibleMessages(ctx())).toEqual({ applied: 2 });
    expect((await apps())[0]?.status).toBe("rejected");
  });

  it("applies equal internal_date in id order", async () => {
    const at = "2026-10-05T10:00:00.000Z";
    // Inserted in the wrong order on purpose: the id decides, not insertion.
    await seed({ id: "m-b", at, extraction: rejection(), threadId: "t-b" });
    await seed({ id: "m-a", at, extraction: confirmation(), threadId: "t-a" });

    expect(await applyEligibleMessages(ctx())).toEqual({ applied: 2 });
    expect(await apps()).toMatchObject([{ status: "rejected" }]);
    expect(await prisma.reviewItem.count()).toBe(0);
    const events = await prisma.event.findMany({ orderBy: { createdAt: "asc" } });
    expect(events.map((e) => e.messageId)).toEqual(["m-a", "m-b"]);
  });

  it("failed, skipped and triaged_out messages don't hold the watermark", async () => {
    await seed({ id: "f", at: "2026-10-05T08:00:00.000Z", state: "failed" });
    await seed({ id: "s", at: "2026-10-05T08:30:00.000Z", state: "skipped" });
    await seed({ id: "t", at: "2026-10-05T09:00:00.000Z", state: "triaged_out" });
    await seed({ id: "ok", at: "2026-10-05T10:00:00.000Z", extraction: confirmation() });
    expect(await applyEligibleMessages(ctx())).toEqual({ applied: 1 });
    expect(await stateOf(prisma, "ok")).toBe("applied");
  });

  it("a discovered message with a placeholder date holds everything back", async () => {
    await seed({ id: "new", at: "1970-01-01T00:00:00.000Z", state: "discovered" });
    await seed({ id: "ok", at: "2026-10-05T10:00:00.000Z", extraction: confirmation() });
    expect(await applyEligibleMessages(ctx())).toEqual({ applied: 0 });
  });

  it("the email.apply handler drains every eligible message, not just one", async () => {
    for (const [i, id] of ["a", "b", "c"].entries()) {
      await seed({
        id,
        at: `2026-10-0${i + 1}T10:00:00.000Z`,
        extraction: confirmation({ company: { name: `Company ${id}`, websiteDomain: null } }),
        fromEmail: `hr@company-${id}.example`,
      });
    }
    const handler = HANDLERS[QUEUES.emailApply];
    if (!handler) throw new Error("no email.apply handler");
    await handler(ctx(), { data: {}, retryCount: 0, retryLimit: 3 });
    expect(await prisma.gmailMessage.count({ where: { state: "applied" } })).toBe(3);
    expect(await prisma.application.count()).toBe(3);
  });
});

describe("applyEligibleMessages: outcomes", () => {
  it("running apply twice creates no duplicate applications, interviews, leads or events", async () => {
    await seed({ id: "m1", at: "2026-10-05T10:00:00.000Z", extraction: confirmation() });
    await seed({
      id: "m2",
      at: "2026-10-06T10:00:00.000Z",
      threadId: "thr-m2",
      extraction: extraction({
        category: "interview_invite",
        interview: {
          kind: "technical",
          startsAt: "2026-10-08T15:00:00-06:00",
          endsAt: "2026-10-08T16:00:00-06:00",
          timezone: "America/Monterrey",
          meetingUrl: "https://meet.quarry.example/room",
          schedulingUrl: null,
          location: null,
          interviewers: ["Priya Ramanathan"],
        },
      }),
    });

    expect(await applyEligibleMessages(ctx())).toEqual({ applied: 2 });
    const first = await recordCounts(prisma);
    expect(first).toMatchObject({ applications: 1, interviews: 1, leads: 0 });
    expect(first.events).toBeGreaterThanOrEqual(3);

    expect(await applyEligibleMessages(ctx())).toEqual({ applied: 0 });
    expect(await recordCounts(prisma)).toEqual(first);
  });

  it("a plan that needs review creates one review item with the plan and changes nothing else", async () => {
    await seed({
      id: "low",
      at: "2026-10-05T10:00:00.000Z",
      extraction: confirmation({ confidence: 0.5 }),
    });
    expect(await applyEligibleMessages(ctx())).toEqual({ applied: 0 });
    expect(await applyEligibleMessages(ctx())).toEqual({ applied: 0 });

    expect(await stateOf(prisma, "low")).toBe("needs_review");
    expect(await recordCounts(prisma)).toEqual({
      applications: 0,
      companies: 0,
      contacts: 0,
      leads: 0,
      interviews: 0,
      events: 0,
      threadLinks: 0,
      reviewItems: 1,
    });
    const item = await prisma.reviewItem.findFirstOrThrow();
    expect(item).toMatchObject({ kind: "low_confidence", messageId: "low", state: "open" });
    expect(item.confidence).toBeCloseTo(0.5);
    expect(item.reasons).toEqual([expect.stringContaining("below")]);
    // The proposal is stored for display, with dates as ISO strings.
    expect(item.plan).toMatchObject({ autoApply: false, review: { kind: "low_confidence" } });
    const stored = item.plan as { operations: { op: string; appliedAt?: string }[] };
    expect(stored.operations.map((o) => o.op)).toContain("create_application");
    expect(stored.operations.find((o) => o.op === "create_application")?.appliedAt).toBe(
      "2026-10-05T10:00:00.000Z",
    );
    // The message keeps its content for the owner to read.
    expect(
      (await prisma.gmailMessage.findUniqueOrThrow({ where: { id: "low" } })).subject,
    ).not.toBeNull();
  });

  it("an ambiguous match opens a review item with its candidates", async () => {
    const company = await prisma.company.create({
      data: {
        name: "Quarry AI",
        normalizedName: "quarry ai",
        domains: ["quarry.example"],
        createdSource: "manual",
      },
    });
    for (const title of ["Platform Engineer", "Data Analyst"]) {
      await prisma.application.create({
        data: {
          companyId: company.id,
          title,
          status: "applied",
          statusChangedAt: new Date("2026-09-01T00:00:00Z"),
          source: "manual",
        },
      });
    }
    await seed({
      id: "amb",
      at: "2026-10-05T10:00:00.000Z",
      extraction: rejection({ role: null }),
    });
    await applyEligibleMessages(ctx());
    expect(await stateOf(prisma, "amb")).toBe("needs_review");
    const item = await prisma.reviewItem.findFirstOrThrow();
    expect(item.kind).toBe("ambiguous_match");
    expect(item.candidates).toHaveLength(2);
  });

  it("not_job_related at apply → triaged_out with every content column null", async () => {
    await seed({
      id: "nope",
      at: "2026-10-05T10:00:00.000Z",
      extraction: extraction({ category: "not_job_related", company: null, role: null }),
      icsEvents: [
        {
          uid: "u",
          method: "REQUEST",
          start: "2026-10-08T21:00:00.000Z",
          end: null,
          timezone: null,
          summary: "Lunch",
          location: null,
          url: null,
          descriptionLink: null,
          organizer: null,
        },
      ],
    });
    expect(await applyEligibleMessages(ctx())).toEqual({ applied: 0 });
    const row = await prisma.gmailMessage.findUniqueOrThrow({ where: { id: "nope" } });
    expect(row.state).toBe("triaged_out");
    for (const [column, value] of Object.entries(NO_CONTENT)) {
      // The two JSON columns are cleared with Prisma.DbNull, which reads back as null.
      const expected = column === "extraction" || column === "icsEvents" ? null : value;
      expect(row[column as keyof typeof row], column).toEqual(expected);
    }
    expect(row.extraction).toBeNull();
    expect(row.icsEvents).toBeNull();
    expect(await recordCounts(prisma)).toMatchObject({
      applications: 0,
      events: 0,
      reviewItems: 0,
    });
  });

  it("outbound mail about nothing known is triaged out and its content cleared", async () => {
    await seed({
      id: "out",
      at: "2026-10-05T10:00:00.000Z",
      direction: "outbound",
      extraction: extraction({ category: "candidate_outbound" }),
    });
    await applyEligibleMessages(ctx());
    const row = await prisma.gmailMessage.findUniqueOrThrow({ where: { id: "out" } });
    expect(row).toMatchObject({
      state: "triaged_out",
      subject: null,
      bodyText: null,
      extraction: null,
    });
  });

  it("each event stores a change_set with before, after and versionAfter, and links to the source message", async () => {
    await seed({ id: "m1", at: "2026-10-05T10:00:00.000Z", extraction: confirmation() });
    await seed({
      id: "m2",
      at: "2026-10-06T10:00:00.000Z",
      threadId: "thr-m2",
      extraction: rejection(),
    });
    await applyEligibleMessages(ctx());

    const events = await prisma.event.findMany({ orderBy: { occurredAt: "asc" } });
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.messageId).not.toBeNull();
      expect(event.actor).toBe("system");
      expect(event.undoable).toBe(true);
      const entries = event.changeSet as {
        entity: string;
        id: string;
        created: boolean;
        before: unknown;
        after: unknown;
        versionAfter: number | null;
      }[];
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry).toHaveProperty("before");
        expect(entry.after).toBeTypeOf("object");
        expect(entry).toHaveProperty("versionAfter");
      }
    }

    const [created, changed] = events;
    const application = (await apps())[0];
    const createdEntries = created?.changeSet as { entity: string; [k: string]: unknown }[];
    expect(createdEntries.find((e) => e.entity === "application")).toMatchObject({
      id: application?.id,
      created: true,
      before: null,
      after: { status: "applied" },
      versionAfter: 1,
    });
    expect(createdEntries.map((e) => e.entity).sort()).toEqual([
      "application",
      "company",
      "gmail_message",
      "thread_link",
    ]);
    const changedEntries = changed?.changeSet as { entity: string; [k: string]: unknown }[];
    expect(changedEntries.find((e) => e.entity === "application")).toMatchObject({
      id: application?.id,
      created: false,
      before: { status: "applied" },
      after: { status: "rejected" },
      versionAfter: 2,
    });
    expect(application?.version).toBe(2);
    expect(changed).toMatchObject({
      type: "status_changed",
      applicationId: application?.id,
      messageId: "m2",
      occurredAt: new Date("2026-10-06T10:00:00.000Z"),
      data: { fromStatus: "applied", toStatus: "rejected" },
    });
    expect(changed?.companyId).toBe(application?.companyId);
  });

  it("a possible duplicate company notice opens a review item and the change still applies", async () => {
    const existing = await prisma.company.create({
      data: {
        name: "Acme Robotics",
        normalizedName: "acme robotics",
        domains: ["acme-robotics.example"],
        createdSource: "manual",
      },
    });
    await seed({
      id: "dup",
      at: "2026-10-05T10:00:00.000Z",
      fromEmail: "jobs@acme-careers.example",
      extraction: confirmation({ company: { name: "Acme", websiteDomain: null } }),
    });
    expect(await applyEligibleMessages(ctx())).toEqual({ applied: 1 });
    expect(await stateOf(prisma, "dup")).toBe("applied");

    const created = await prisma.company.findUniqueOrThrow({ where: { normalizedName: "acme" } });
    expect(await prisma.application.count({ where: { companyId: created.id } })).toBe(1);
    const item = await prisma.reviewItem.findFirstOrThrow();
    expect(item).toMatchObject({
      kind: "possible_duplicate_company",
      messageId: "dup",
      companyId: created.id,
      state: "open",
      candidates: [{ id: existing.id, label: "Acme Robotics" }],
    });
  });
});

describe("applyEligibleMessages: calendar data", () => {
  const invite = (startsAt: string | null) =>
    extraction({
      category: "interview_invite",
      interview: {
        kind: "technical",
        startsAt,
        endsAt: null,
        timezone: "America/Monterrey",
        meetingUrl: null,
        schedulingUrl: null,
        location: null,
        interviewers: [],
      },
    });
  const ics = (start: string | null) => [
    {
      uid: "invite-1@quarry.example",
      method: "REQUEST" as const,
      start,
      end: null,
      timezone: null,
      summary: "Technical interview",
      location: null,
      url: null,
      descriptionLink: null,
      organizer: null,
    },
  ];

  it("the stored calendar start overrides the model's time", async () => {
    await seed({
      id: "ics",
      at: "2026-10-05T10:00:00.000Z",
      extraction: invite("2026-10-08T15:00:00-06:00"),
      icsEvents: ics("2026-10-08T22:00:00.000Z"),
    });
    await applyEligibleMessages(ctx());
    expect(await prisma.interview.findFirstOrThrow()).toMatchObject({
      startsAt: new Date("2026-10-08T22:00:00.000Z"),
      icsUid: "invite-1@quarry.example",
      status: "scheduled",
      sourceMessageId: "ics",
    });
  });

  it("a calendar event with no start (unknown zone) keeps the model's time", async () => {
    await seed({
      id: "ics",
      at: "2026-10-05T10:00:00.000Z",
      extraction: invite("2026-10-08T15:00:00-06:00"),
      icsEvents: ics(null),
    });
    await applyEligibleMessages(ctx());
    expect(await prisma.interview.findFirstOrThrow()).toMatchObject({
      startsAt: new Date("2026-10-08T21:00:00.000Z"),
      status: "scheduled",
    });
  });
});

describe("applyEligibleMessages: failures", () => {
  it("an owner edit between snapshot and write → VersionConflictError, rollback, message still extracted for the next sweep", async () => {
    await seed({ id: "m1", at: "2026-10-05T10:00:00.000Z", extraction: confirmation() });
    await applyEligibleMessages(ctx());
    const application = (await apps())[0];
    if (!application) throw new Error("no application");
    await seed({
      id: "m2",
      at: "2026-10-06T10:00:00.000Z",
      threadId: "thr-m2",
      extraction: rejection(),
    });
    const before = await recordCounts(prisma);

    // The owner saves a note (taking no lock) after the plan was made and before it is written.
    let edited = false;
    const racing = interceptTx(ctx(), "application", "findUnique", async (call) => {
      if (!edited) {
        edited = true;
        await prisma.application.update({
          where: { id: application.id },
          data: { notes: "Owner note", version: { increment: 1 } },
        });
      }
      return call();
    });
    expect(await applyEligibleMessages(racing)).toEqual({ applied: 0 });
    expect(edited).toBe(true);
    expect(await stateOf(prisma, "m2")).toBe("extracted");
    expect(await recordCounts(prisma)).toEqual(before);
    expect(
      await prisma.application.findUniqueOrThrow({ where: { id: application.id } }),
    ).toMatchObject({
      status: "applied",
      notes: "Owner note",
      version: 2,
    });

    // The next sweep plans it again against the edited record.
    expect(await applyEligibleMessages(ctx())).toEqual({ applied: 1 });
    expect(
      await prisma.application.findUniqueOrThrow({ where: { id: application.id } }),
    ).toMatchObject({
      status: "rejected",
      notes: "Owner note",
      version: 3,
    });
  });

  it("a conflict stops the drain, so later messages do not pass the waiting one", async () => {
    await seed({ id: "m1", at: "2026-10-05T10:00:00.000Z", extraction: confirmation() });
    await applyEligibleMessages(ctx());
    const application = (await apps())[0];
    await seed({
      id: "m2",
      at: "2026-10-06T10:00:00.000Z",
      threadId: "t2",
      extraction: rejection(),
    });
    await seed({
      id: "m3",
      at: "2026-10-07T10:00:00.000Z",
      threadId: "t3",
      fromEmail: "hr@other.example",
      extraction: confirmation({ company: { name: "Other Co", websiteDomain: null } }),
    });
    let edited = false;
    const racing = interceptTx(ctx(), "application", "findUnique", async (call) => {
      if (!edited) {
        edited = true;
        await prisma.application.update({
          where: { id: application?.id ?? "" },
          data: { version: { increment: 1 } },
        });
      }
      return call();
    });
    expect(await applyEligibleMessages(racing)).toEqual({ applied: 0 });
    expect(await stateOf(prisma, "m3")).toBe("extracted");
  });

  it("a stored extraction that no longer parses fails the message, and the drain goes on", async () => {
    await seed({ id: "bad", at: "2026-10-05T09:00:00.000Z" });
    await prisma.gmailMessage.update({ where: { id: "bad" }, data: { extraction: { nope: 1 } } });
    await seed({ id: "after", at: "2026-10-05T10:00:00.000Z", extraction: confirmation() });
    await expect(applyEligibleMessages(ctx())).resolves.toEqual({ applied: 1 });
    expect(await prisma.gmailMessage.findUniqueOrThrow({ where: { id: "bad" } })).toMatchObject({
      state: "failed",
      lastError: "stored_extraction_invalid",
    });
    expect(await prisma.reviewItem.findMany({ where: { messageId: "bad" } })).toMatchObject([
      { kind: "extraction_failed", state: "open", reasons: ["apply_failed"] },
    ]);
    expect(await stateOf(prisma, "after")).toBe("applied");
  });

  it("an error while recording a failure does not mask the original error", async () => {
    await seed({ id: "poison", at: "2026-10-05T10:00:00.000Z", extraction: confirmation() });
    const boom = interceptTx(ctx(), "company", "create", () => Promise.reject(new Error("boom")));
    const broken = interceptTx(boom, "gmailMessage", "updateMany", (call, args) => {
      const data = (args[0] as { data: { attempts?: unknown } }).data;
      return data.attempts === undefined ? call() : Promise.reject(new Error("db down"));
    });
    await expect(applyEligibleMessages(broken)).rejects.toThrow("boom");
    expect(await prisma.gmailMessage.findUniqueOrThrow({ where: { id: "poison" } })).toMatchObject({
      state: "extracted",
      attempts: 0,
    });
  });

  it("counts a failed attempt inside the intake lock", async () => {
    await seed({ id: "poison", at: "2026-10-05T10:00:00.000Z", extraction: confirmation() });
    let lockedWhenCounted: boolean | null = null;
    const boom = interceptTx(ctx(), "company", "create", () => Promise.reject(new Error("boom")));
    const spy = interceptTx(boom, "gmailMessage", "updateMany", async (call, args) => {
      const data = (args[0] as { data: { attempts?: unknown } }).data;
      if (data.attempts !== undefined) {
        // A second connection cannot take the lock while this transaction holds it.
        const other = await prisma.$transaction(
          async (tx) => {
            const rows = await tx.$queryRaw<{ got: boolean }[]>`
              SELECT pg_try_advisory_xact_lock(hashtext('offerbound.intake')) AS got`;
            return rows[0]?.got ?? null;
          },
          { timeout: 5_000 },
        );
        lockedWhenCounted = other === false;
      }
      return call();
    });
    await expect(applyEligibleMessages(spy)).rejects.toThrow("boom");
    expect(lockedWhenCounted).toBe(true);
  });

  it("an unexpected error is retried, and a message that keeps failing is failed so it cannot block the rest", async () => {
    await seed({ id: "poison", at: "2026-10-05T10:00:00.000Z", extraction: confirmation() });
    await seed({
      id: "ok",
      at: "2026-10-06T10:00:00.000Z",
      fromEmail: "hr@other.example",
      extraction: confirmation({ company: { name: "Other Co", websiteDomain: null } }),
    });
    const broken = interceptTx(ctx(), "company", "create", () => Promise.reject(new Error("boom")));
    for (let attempt = 1; attempt < MAX_APPLY_ATTEMPTS; attempt += 1) {
      await expect(applyEligibleMessages(broken)).rejects.toThrow("boom");
      expect(
        await prisma.gmailMessage.findUniqueOrThrow({ where: { id: "poison" } }),
      ).toMatchObject({
        state: "extracted",
        attempts: attempt,
      });
    }
    // The last allowed attempt fails the message; the drain goes on past it (but the sabotaged
    // create also hits "ok", which is retried on its own count).
    await expect(applyEligibleMessages(broken)).rejects.toThrow("boom");
    expect(await prisma.gmailMessage.findUniqueOrThrow({ where: { id: "poison" } })).toMatchObject({
      state: "failed",
      lastError: "apply_error",
    });
    expect(await prisma.reviewItem.count({ where: { messageId: "poison" } })).toBe(1);

    // With the fault gone the next message applies.
    expect(await applyEligibleMessages(ctx())).toEqual({ applied: 1 });
    expect(await stateOf(prisma, "ok")).toBe("applied");
  });
});

describe("applyEligibleMessages: create_leads", () => {
  const lead = (n: number, over = {}) => ({
    company: n === 1 ? "Quarry AI" : "Sable Robotics",
    title: `Platform Engineer ${n}`,
    jobUrl: `https://boards.greenhouse.io/${n === 1 ? "quarry" : "sable"}/jobs/${100 + n}`,
    locationText: null,
    country: null,
    workMode: "remote" as const,
    compensationText: null,
    postedAt: "2026-10-04T08:00:00.000Z",
    ...over,
  });
  const alert = (leads: ReturnType<typeof lead>[]) =>
    extraction({ category: "job_alert", company: null, role: null, leads, confidence: 0.95 });

  it("a job-alert plan with two leads creates both leads, two lead_created events and the batch", async () => {
    await seed({
      id: "alert",
      at: "2026-10-05T09:00:00.000Z",
      fromEmail: "alerts@jobs-alerts.example",
      extraction: alert([lead(1), lead(2)]),
    });
    expect(await applyEligibleMessages(ctx())).toEqual({ applied: 1 });
    expect(await stateOf(prisma, "alert")).toBe("applied");

    const batch = await prisma.intakeBatch.findFirstOrThrow();
    expect(batch).toMatchObject({
      kind: "gmail_message",
      messageId: "alert",
      counts: { received: 2, duplicates: 0, accepted: 2 },
    });
    const leads = await prisma.lead.findMany({ orderBy: { createdAt: "asc" } });
    expect(leads).toMatchObject([
      {
        title: "Platform Engineer 1",
        source: "gmail_alert",
        intakeBatchId: batch.id,
        sourceMessageId: "alert",
      },
      { title: "Platform Engineer 2", source: "gmail_alert", intakeBatchId: batch.id },
    ]);
    expect(await prisma.company.count()).toBe(2);

    const events = await prisma.event.findMany({ orderBy: { createdAt: "asc" } });
    expect(events).toHaveLength(2);
    for (const [index, event] of events.entries()) {
      const mine = leads[index];
      expect(event).toMatchObject({
        type: "lead_created",
        actor: "system",
        messageId: "alert",
        leadId: mine?.id,
        companyId: mine?.companyId,
        applicationId: null,
        undoable: true,
        occurredAt: new Date("2026-10-05T09:00:00.000Z"),
      });
      // Per-event change set: this lead and the company it created, nothing of the other lead.
      const entries = event.changeSet as { entity: string; id: string; created: boolean }[];
      expect(entries.map((e) => [e.entity, e.id]).sort()).toEqual(
        [
          ["company", mine?.companyId],
          ["lead", mine?.id],
        ].sort(),
      );
      expect(entries.every((e) => e.created)).toBe(true);
    }
  });

  it("a duplicate lead is skipped and counted", async () => {
    const batch = await prisma.intakeBatch.create({ data: { kind: "manual", counts: {} } });
    const company = await prisma.company.create({
      data: { name: "Quarry AI", normalizedName: "quarry ai", createdSource: "manual" },
    });
    await prisma.lead.create({
      data: {
        companyId: company.id,
        intakeBatchId: batch.id,
        title: "Platform Engineer 1",
        jobUrl: lead(1).jobUrl,
        jobKey: jobKey(lead(1).jobUrl),
        statusChangedAt: new Date("2026-09-01T00:00:00Z"),
        source: "manual",
      },
    });
    await seed({
      id: "alert",
      at: "2026-10-05T09:00:00.000Z",
      extraction: alert([lead(1), lead(2)]),
    });
    await applyEligibleMessages(ctx());

    expect(await stateOf(prisma, "alert")).toBe("applied");
    const created = await prisma.intakeBatch.findFirstOrThrow({ where: { messageId: "alert" } });
    expect(created.counts).toMatchObject({ received: 2, duplicates: 1, accepted: 1 });
    expect(await prisma.lead.count()).toBe(2); // the existing one and the new one
    const events = await prisma.event.findMany();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "lead_created" });
    const stored = await prisma.lead.findFirstOrThrow({ where: { intakeBatchId: created.id } });
    expect(events[0]?.leadId).toBe(stored.id);
    expect(stored.title).toBe("Platform Engineer 2");
  });

  it("sends the lead checks after the commit, one per stored lead", async () => {
    await seed({
      id: "alert",
      at: "2026-10-05T09:00:00.000Z",
      extraction: alert([lead(1), lead(2)]),
    });
    const queue = new RecordingQueue();
    const visibleAtSend: number[] = [];
    const send = queue.send.bind(queue);
    queue.send = async (name, data, opts) => {
      // Read through another connection: only committed leads are visible to it.
      visibleAtSend.push(await prisma.lead.count());
      await send(name, data, opts);
    };
    await applyEligibleMessages(testWorkerCtx({ queue }));

    const batch = await prisma.intakeBatch.findFirstOrThrow();
    const leads = await prisma.lead.findMany({ orderBy: { createdAt: "asc" } });
    const checks = queue.sent.filter((s) => s.name === QUEUES.leadsCheck);
    expect(checks.map((c) => c.data)).toEqual(
      leads.map((l) => ({ leadId: l.id, batchId: batch.id })),
    );
    expect(visibleAtSend.filter((n) => n === 2)).toHaveLength(2);
  });

  it("sends no checks when the plan is rolled back", async () => {
    await seed({ id: "alert", at: "2026-10-05T09:00:00.000Z", extraction: alert([lead(1)]) });
    const queue = new RecordingQueue();
    const broken = interceptTx(testWorkerCtx({ queue }), "intakeBatch", "create", () =>
      Promise.reject(new Error("boom")),
    );
    await expect(applyEligibleMessages(broken)).rejects.toThrow("boom");
    expect(queue.sent.filter((s) => s.name === QUEUES.leadsCheck)).toEqual([]);
    expect(await prisma.lead.count()).toBe(0);
  });

  it("a failed check send does not undo the applied message", async () => {
    await seed({ id: "alert", at: "2026-10-05T09:00:00.000Z", extraction: alert([lead(1)]) });
    const queue = new RecordingQueue();
    queue.failSendWith = new Error("queue down");
    await expect(applyEligibleMessages(testWorkerCtx({ queue }))).resolves.toEqual({ applied: 1 });
    expect(await stateOf(prisma, "alert")).toBe("applied");
    expect(await prisma.lead.count()).toBe(1);
  });

  it("a recruiter email creates its lead and links the thread to it, in the lead's change set", async () => {
    await seed({
      id: "rec",
      at: "2026-10-05T09:00:00.000Z",
      threadId: "thr-rec",
      fromEmail: "sam@staffing-partners.example",
      extraction: extraction({
        category: "recruiter_outreach",
        company: { name: "Sable Robotics", websiteDomain: null },
        role: { title: "Staff Engineer", seniority: "staff_plus" },
        jobUrl: "https://boards.greenhouse.io/sable/jobs/777",
        contact: {
          name: "Sam Okafor",
          email: "sam@staffing-partners.example",
          title: null,
          isAgency: true,
        },
      }),
    });
    await applyEligibleMessages(ctx());

    expect(await stateOf(prisma, "rec")).toBe("applied");
    const stored = await prisma.lead.findFirstOrThrow();
    expect(stored).toMatchObject({ source: "gmail_recruiter", title: "Staff Engineer" });
    expect(
      await prisma.threadLink.findUniqueOrThrow({ where: { threadId: "thr-rec" } }),
    ).toMatchObject({
      leadId: stored.id,
      applicationId: null,
    });
    const event = await prisma.event.findFirstOrThrow();
    expect(event).toMatchObject({ type: "lead_created", leadId: stored.id });
    const entities = (event.changeSet as { entity: string }[]).map((e) => e.entity).sort();
    expect(entities).toEqual(["company", "contact", "lead", "thread_link"]);
    expect(await prisma.intakeBatch.count()).toBe(1);
  });
});
