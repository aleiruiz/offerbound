import type { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb, testPrisma } from "../../test/db.js";

const prisma: PrismaClient = testPrisma();

let seq = 0;
const next = () => ++seq;
const now = () => new Date("2026-10-01T12:00:00.000Z");

async function makeCompany(name = `Acme ${next()}`) {
  return prisma.company.create({
    data: { name, normalizedName: name.toLowerCase(), createdSource: "manual" },
  });
}

async function makeBatch() {
  return prisma.intakeBatch.create({ data: { kind: "manual", counts: {} } });
}

async function makeLead(
  base: { companyId: string; intakeBatchId: string },
  extra: Partial<Prisma.LeadUncheckedCreateInput> = {},
) {
  return prisma.lead.create({
    data: {
      ...base,
      title: `Engineer ${next()}`,
      statusChangedAt: now(),
      source: "manual",
      ...extra,
    },
  });
}

async function makeApplication(
  companyId: string,
  extra: Partial<Prisma.ApplicationUncheckedCreateInput> = {},
) {
  return prisma.application.create({
    data: {
      companyId,
      title: `Engineer ${next()}`,
      status: "applied",
      statusChangedAt: now(),
      source: "manual",
      ...extra,
    },
  });
}

async function makeMessage(id = `msg-${next()}`) {
  return prisma.gmailMessage.create({
    data: {
      id,
      threadId: `thread-${id}`,
      internalDate: now(),
      direction: "inbound",
      labelIds: ["INBOX"],
    },
  });
}

async function makeLeadBase() {
  const company = await makeCompany();
  const batch = await makeBatch();
  return { companyId: company.id, intakeBatchId: batch.id };
}

/** Asserts a Prisma error whose message (or code) identifies the violated constraint. */
async function expectConstraint(promise: Promise<unknown>, match: RegExp | string) {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, "expected the statement to be rejected").toBeInstanceOf(Error);
  const text = `${(error as { code?: string }).code ?? ""} ${(error as Error).message}`;
  expect(text).toMatch(match);
}

const UNIQUE = "P2002";

describe("schema constraints", () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("rejects a second lead with the same job_key", async () => {
    const base = await makeLeadBase();
    await makeLead(base, { jobKey: "ashby:acme:123" });
    await expectConstraint(makeLead(base, { jobKey: "ashby:acme:123" }), UNIQUE);
  });

  it("allows many leads with a null job_key", async () => {
    const base = await makeLeadBase();
    await makeLead(base, { jobKey: null });
    await makeLead(base, { jobKey: null });
    await makeLead(base);
    expect(await prisma.lead.count()).toBe(3);
  });

  it("rejects a second application with the same job_key", async () => {
    const company = await makeCompany();
    await makeApplication(company.id, { jobKey: "ashby:acme:123" });
    await expectConstraint(makeApplication(company.id, { jobKey: "ashby:acme:123" }), UNIQUE);
    // Null keys never collide.
    await makeApplication(company.id, { jobKey: null });
    await makeApplication(company.id, { jobKey: null });
  });

  it("rejects a suppressed lead without suppressed_reason", async () => {
    const base = await makeLeadBase();
    await expectConstraint(makeLead(base, { status: "suppressed" }), /lead_suppressed_reason/);
    // The reverse is rejected too: a reason on a lead that is not suppressed.
    await expectConstraint(
      makeLead(base, { status: "new", suppressedReason: "ineligible" }),
      /lead_suppressed_reason/,
    );
    // A suppressed lead with a reason is accepted.
    const ok = await makeLead(base, { status: "suppressed", suppressedReason: "ineligible" });
    expect(ok.suppressedReason).toBe("ineligible");
  });

  it("rejects a second running search_run", async () => {
    const run = { trigger: "manual", briefHash: "abc", startedAt: now() } as const;
    const first = await prisma.searchRun.create({ data: { ...run, status: "running" } });
    await expectConstraint(
      prisma.searchRun.create({ data: { ...run, status: "running" } }),
      UNIQUE,
    );
    // Finished runs are unlimited, and a new run may start once the first finishes.
    await prisma.searchRun.create({ data: { ...run, status: "succeeded" } });
    await prisma.searchRun.create({ data: { ...run, status: "succeeded" } });
    await prisma.searchRun.update({ where: { id: first.id }, data: { status: "failed" } });
    await prisma.searchRun.create({ data: { ...run, status: "running" } });
  });

  it("rejects two active candidate profiles", async () => {
    const profile = {
      fileName: "cv.pdf",
      mimeType: "application/pdf",
      sizeBytes: 10,
      textContent: "text",
      profileStatus: "ok",
    };
    await prisma.candidateProfile.create({ data: { ...profile, isActive: true } });
    await expectConstraint(
      prisma.candidateProfile.create({ data: { ...profile, isActive: true } }),
      UNIQUE,
    );
    // Inactive profiles are unlimited.
    await prisma.candidateProfile.create({ data: { ...profile, isActive: false } });
    await prisma.candidateProfile.create({ data: { ...profile, isActive: false } });
  });

  it("rejects a duplicate event for the same message, type and record", async () => {
    const company = await makeCompany();
    const application = await makeApplication(company.id);
    const message = await makeMessage();
    const event = {
      applicationId: application.id,
      messageId: message.id,
      type: "email_received",
      actor: "system",
      summary: "Received a confirmation",
      undoable: true,
    } as const;
    await prisma.event.create({ data: event });
    await expectConstraint(prisma.event.create({ data: event }), UNIQUE);
    // Same message and record, different type: allowed.
    await prisma.event.create({ data: { ...event, type: "status_changed" } });
    // No message: idempotency does not apply.
    const noMessage = { ...event, messageId: null };
    await prisma.event.create({ data: noMessage });
    await prisma.event.create({ data: noMessage });
  });

  it("allows the same message and type for two different applications", async () => {
    const company = await makeCompany();
    const first = await makeApplication(company.id);
    const second = await makeApplication(company.id);
    const message = await makeMessage();
    const event = {
      messageId: message.id,
      type: "email_received",
      actor: "system",
      summary: "Received a confirmation",
      undoable: true,
    } as const;
    await prisma.event.create({ data: { ...event, applicationId: first.id } });
    await prisma.event.create({ data: { ...event, applicationId: second.id } });
    expect(await prisma.event.count()).toBe(2);
  });

  it("rejects a second open review item for the same message and kind; allows it after resolving", async () => {
    const message = await makeMessage();
    const item = { messageId: message.id, kind: "low_confidence" } as const;
    const first = await prisma.reviewItem.create({ data: item });
    await expectConstraint(prisma.reviewItem.create({ data: item }), UNIQUE);
    // A different kind for the same message is a separate item.
    await prisma.reviewItem.create({ data: { ...item, kind: "ambiguous_match" } });
    await prisma.reviewItem.update({
      where: { id: first.id },
      data: { state: "resolved", resolvedAt: now() },
    });
    await prisma.reviewItem.create({ data: item });
    expect(
      await prisma.reviewItem.count({ where: { state: "open", kind: "low_confidence" } }),
    ).toBe(1);
  });

  it("accepts only id 1 in gmail_connection", async () => {
    const connection = {
      googleSub: "sub-1",
      email: "owner@example.test",
      scopes: ["openid"],
      status: "active",
      backfillSince: new Date("2026-09-01T00:00:00.000Z"),
    } satisfies Omit<Prisma.GmailConnectionUncheckedCreateInput, "id">;
    await expectConstraint(
      prisma.gmailConnection.create({ data: { ...connection, id: 2 } }),
      /gmail_connection_singleton/,
    );
    await prisma.gmailConnection.create({ data: { ...connection, id: 1 } });
    await expectConstraint(
      prisma.gmailConnection.create({ data: { ...connection, id: 1 } }),
      UNIQUE,
    );
  });

  it("treats contact email as case-insensitive unique", async () => {
    await prisma.contact.create({ data: { email: "Ana@X.example" } });
    await expectConstraint(prisma.contact.create({ data: { email: "ana@x.example" } }), UNIQUE);
    const found = await prisma.contact.findUnique({ where: { email: "ANA@x.example" } });
    expect(found?.email).toBe("Ana@X.example");
  });

  it("requires thread_link to reference an application or a lead", async () => {
    await expectConstraint(
      prisma.threadLink.create({ data: { threadId: "t-none" } }),
      /thread_link_target/,
    );
    const company = await makeCompany();
    const application = await makeApplication(company.id);
    const lead = await makeLead(await makeLeadBase());
    await prisma.threadLink.create({ data: { threadId: "t-app", applicationId: application.id } });
    await prisma.threadLink.create({ data: { threadId: "t-lead", leadId: lead.id } });
    expect(await prisma.threadLink.count()).toBe(2);
  });

  it("rejects a second open application lead_id and a second lead application_id", async () => {
    const base = await makeLeadBase();
    const lead = await makeLead(base);
    await makeApplication(base.companyId, { leadId: lead.id });
    await expectConstraint(makeApplication(base.companyId, { leadId: lead.id }), UNIQUE);

    const application = await makeApplication(base.companyId);
    await makeLead(base, { applicationId: application.id });
    await expectConstraint(makeLead(base, { applicationId: application.id }), UNIQUE);
  });

  it("keeps ics_uid and file_hash unique where set", async () => {
    const company = await makeCompany();
    const application = await makeApplication(company.id);
    const interview = {
      applicationId: application.id,
      kind: "technical",
      status: "scheduled",
      icsUid: "uid-1@calendar.example",
    } as const;
    await prisma.interview.create({ data: interview });
    await expectConstraint(prisma.interview.create({ data: interview }), UNIQUE);
    await prisma.interview.create({ data: { ...interview, icsUid: null } });
    await prisma.interview.create({ data: { ...interview, icsUid: null } });

    const batch = { kind: "sheet_import", counts: {}, fileHash: "sha256-abc" } as const;
    await prisma.intakeBatch.create({ data: batch });
    await expectConstraint(prisma.intakeBatch.create({ data: batch }), UNIQUE);
    await prisma.intakeBatch.create({ data: { ...batch, fileHash: null } });
    await prisma.intakeBatch.create({ data: { ...batch, fileHash: null } });
  });
});
