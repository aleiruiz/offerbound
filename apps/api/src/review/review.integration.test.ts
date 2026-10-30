import type { FastifyInstance } from "fastify";
import {
  PageSchema,
  ReviewItemSchema,
  type ApiErrorBody,
  type Extraction,
  type ReviewItem,
  type ReviewResolve,
} from "@offerbound/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extraction, seedMessage, type SeedMessage } from "../../test/apply.js";
import { buildTestApp, signIn } from "../../test/app.js";
import { resetDb, testPrisma } from "../../test/db.js";
import { interceptTx } from "../../test/intercept.js";
import type { RecordingQueue } from "../../test/queue.js";
import { ApiError } from "../http/errors.js";
import { QUEUES } from "../jobs/queues.js";
import { applyEligibleMessages } from "../pipeline/apply.js";
import { undoEvent } from "../undo/service.js";
import { describePlan, resolveReviewItem, toReviewItemDto } from "./service.js";
import { mergeCompanies } from "./merge-companies.js";
import type { ChangePlan } from "@offerbound/domain";

const prisma = testPrisma();
const CSRF = { "x-offerbound-request": "1" };
const ReviewPage = PageSchema(ReviewItemSchema);

const apps: FastifyInstance[] = [];
async function setup(overrides: Parameters<typeof buildTestApp>[0] = {}) {
  const built = await buildTestApp(overrides);
  apps.push(built.app);
  const cookie = await signIn(built.app, built.deps);
  const queue = built.deps.queue as RecordingQueue;
  const call = (method: "GET" | "POST", url: string, payload?: object) =>
    built.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { cookie, ...(method === "GET" ? {} : CSRF) },
      ...(payload === undefined ? {} : { payload }),
    });
  const ctx = { ...built.deps, log: built.app.log };
  const resolve = (id: string, body: ReviewResolve) =>
    call("POST", `/review-items/${id}/resolve`, body);
  const drain = () => applyEligibleMessages(ctx);
  return { ...built, queue, call, resolve, ctx, drain };
}

beforeEach(async () => {
  await resetDb(prisma);
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

// --- helpers ------------------------------------------------------------------------------------

const seed = (m: SeedMessage) => seedMessage(prisma, m);
const AT = "2026-10-05T10:00:00.000Z";
const NOW = new Date("2026-10-01T12:00:00.000Z");

const body = <T>(response: { body: string }) => JSON.parse(response.body) as T;
const errorCode = (response: { body: string }) => body<ApiErrorBody>(response).error.code;

async function seedCompany(name: string, domains: string[] = []) {
  return prisma.company.create({
    data: {
      name,
      normalizedName: name.toLowerCase(),
      domains,
      createdSource: "manual",
    },
  });
}

async function seedApplication(
  companyId: string,
  title: string,
  status: "applied" | "rejected" | "interviewing" = "applied",
) {
  return prisma.application.create({
    data: {
      companyId,
      title,
      status,
      statusChangedAt: new Date("2026-09-01T00:00:00Z"),
      source: "manual",
    },
  });
}

const openItems = () => prisma.reviewItem.findMany({ where: { state: "open" } });
const only = async () => prisma.reviewItem.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
const messageState = async (id: string) =>
  (await prisma.gmailMessage.findUniqueOrThrow({ where: { id } })).state;

/** A low-confidence confirmation waiting in the queue. */
async function lowConfidence(id = "low", over: Partial<Extraction> = {}, at = AT) {
  await seed({ id, at, extraction: extraction({ confidence: 0.5, ...over }) });
}

/** Two applications at one company and an email that could be about either. */
async function ambiguous() {
  const company = await seedCompany("Quarry AI", ["quarry.example"]);
  const first = await seedApplication(company.id, "Platform Engineer");
  const second = await seedApplication(company.id, "Data Analyst");
  await seed({
    id: "amb",
    at: AT,
    extraction: extraction({ category: "rejection", role: null, summary: "Rejected" }),
  });
  return { company, first, second };
}

/** A rejected application and a confirmation that implies Applied again. */
async function unexpected() {
  const company = await seedCompany("Quarry AI", ["quarry.example"]);
  const application = await seedApplication(company.id, "Platform Engineer", "rejected");
  await seed({ id: "unx", at: AT, extraction: extraction({ summary: "Application received" }) });
  return { company, application };
}

/** "Acme" created from an email while "Acme Robotics" exists → a duplicate notice. */
async function duplicate() {
  const existing = await prisma.company.create({
    data: {
      name: "Acme Robotics",
      normalizedName: "acme robotics",
      aliases: ["acme robotics intl"],
      domains: ["acme-robotics.example"],
      atsSlugs: ["greenhouse:acme"],
      createdSource: "manual",
    },
  });
  await seed({
    id: "dup",
    at: AT,
    fromEmail: "jobs@acme-careers.example",
    extraction: extraction({ company: { name: "Acme", websiteDomain: null } }),
  });
  return existing;
}

// --- listing (AC-5.1) -----------------------------------------------------------------------------

describe("GET /review-items", () => {
  it("lists open items newest first with kind, email summary, proposal, confidence and candidates", async () => {
    const t = await setup();
    await ambiguous();
    await t.drain();
    await lowConfidence("low", {}, "2026-10-06T10:00:00.000Z");
    await t.drain();
    // Force a known order: the ambiguous item is older.
    await prisma.reviewItem.updateMany({
      where: { kind: "ambiguous_match" },
      data: { createdAt: new Date("2026-10-06T09:00:00.000Z") },
    });
    await prisma.reviewItem.updateMany({
      where: { kind: "low_confidence" },
      data: { createdAt: new Date("2026-10-06T10:00:00.000Z") },
    });

    const response = await t.call("GET", "/review-items?state=open");
    expect(response.statusCode).toBe(200);
    const page = ReviewPage.parse(body(response));
    expect(page.nextCursor).toBeNull();
    expect(page.items.map((i) => i.kind)).toEqual(["low_confidence", "ambiguous_match"]);

    const [low, amb] = page.items as [ReviewItem, ReviewItem];
    expect(low).toMatchObject({
      state: "open",
      message: {
        id: "low",
        subject: "Subject of low",
        fromEmail: "careers@quarry.example",
        summary: "Application received",
        category: "application_confirmation",
      },
    });
    expect(low.confidence).toBeCloseTo(0.5);
    expect(low.proposal.description).toMatch(/Is that right\?$/);
    expect(low.proposal.operations).toEqual([
      {
        entity: "application",
        action: "update",
        summary: "Would record the email on the application.",
      },
    ]);
    expect(low.candidates).toEqual([]);
    expect(amb.proposal.description).toBe("Which application is this email about?");
    expect(amb.candidates.map((c) => c.label).sort()).toEqual([
      "Quarry AI — Data Analyst (Applied)",
      "Quarry AI — Platform Engineer (Applied)",
    ]);
  });

  it("pages with limit and cursor, and the Resolved tab lists decided items latest first", async () => {
    const t = await setup();
    for (const id of ["a", "b", "c"])
      await lowConfidence(id, {}, `2026-10-0${3 + "abc".indexOf(id)}T10:00:00.000Z`);
    await t.drain();
    const first = ReviewPage.parse(body(await t.call("GET", "/review-items?limit=2")));
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = ReviewPage.parse(
      body(await t.call("GET", `/review-items?limit=2&cursor=${first.nextCursor}`)),
    );
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.items, ...second.items].map((i) => i.message?.id);
    expect(ids).toEqual(["c", "b", "a"]);

    const [a] = await prisma.reviewItem.findMany({ where: { messageId: "a" } });
    await t.resolve(a?.id ?? "", { action: "dismiss" });
    const [b] = await prisma.reviewItem.findMany({ where: { messageId: "b" } });
    await t.resolve(b?.id ?? "", { action: "dismiss" });
    // Decided at different moments (the test clock is fixed).
    await prisma.reviewItem.update({
      where: { id: b?.id ?? "" },
      data: { resolvedAt: new Date("2026-10-01T13:00:00.000Z") },
    });
    const resolved = ReviewPage.parse(body(await t.call("GET", "/review-items?state=resolved")));
    expect(resolved.items.map((i) => [i.message?.id, i.state])).toEqual([
      ["b", "dismissed"],
      ["a", "dismissed"],
    ]);
    expect((await t.call("GET", "/review-items?state=bogus")).statusCode).toBe(400);
    expect((await t.call("GET", "/review-items?cursor=zzz")).statusCode).toBe(400);
  });

  it("words an item whose records could not be written neutrally", async () => {
    const t = await setup();
    await seed({ id: "f", at: AT, state: "failed" });
    await prisma.reviewItem.createMany({
      data: [{ kind: "extraction_failed", messageId: "f", reasons: ["apply_failed"] }],
    });
    await seed({ id: "g", at: AT, state: "failed" });
    await prisma.reviewItem.createMany({
      data: [{ kind: "extraction_failed", messageId: "g", reasons: ["extraction_failed"] }],
    });
    const page = ReviewPage.parse(body(await t.call("GET", "/review-items")));
    const text = (id: string) => page.items.find((i) => i.message?.id === id)?.proposal.description;
    expect(text("f")).toBe("Offerbound couldn't process this email.");
    expect(text("g")).toBe("Offerbound couldn't read this email.");
  });
});

describe("describePlan", () => {
  it("previews the operations in plain words and skips bookkeeping", () => {
    const plan = {
      operations: [
        { op: "create_company", ref: "new:company", company: { name: "Quarry AI" } },
        { op: "create_application", title: "Platform Engineer", status: "applied" },
        { op: "update_application", set: { status: "rejected" } },
        { op: "link_thread", threadId: "t", application: null, leadRef: null },
        { op: "attach_message", application: { id: "a" } },
      ],
      events: [{ summary: "Rejected by Quarry AI" }],
    } as unknown as ChangePlan;
    expect(describePlan(plan)).toEqual({
      description: "Rejected by Quarry AI. Is that right?",
      operations: [
        { entity: "company", action: "create", summary: "Would add the company Quarry AI." },
        {
          entity: "application",
          action: "create",
          summary: "Would create the application for Platform Engineer as Applied.",
        },
        {
          entity: "application",
          action: "update",
          summary: "Would change the status to Rejected.",
        },
      ],
    });
  });

  it("is what toReviewItemDto uses for a stored plan, and tolerates a plan-less row", async () => {
    await lowConfidence();
    await (await setup()).drain();
    const row = await prisma.reviewItem.findFirstOrThrow({
      include: { message: true, company: { select: { name: true } } },
    });
    expect(toReviewItemDto(row).proposal.operations.length).toBeGreaterThan(0);
    expect(toReviewItemDto({ ...row, plan: null, company: undefined }).proposal.operations).toEqual(
      [],
    );
  });
});

// --- low confidence ------------------------------------------------------------------------------

describe("POST /review-items/:id/resolve: low_confidence", () => {
  it("apply executes the stored proposal through executePlan; the event is undoable", async () => {
    const t = await setup();
    await lowConfidence();
    await t.drain();
    const item = await only();

    const response = await t.resolve(item.id, { action: "apply" });
    expect(response.statusCode).toBe(200);
    expect(ReviewItemSchema.parse(body(response))).toMatchObject({
      id: item.id,
      kind: "low_confidence",
      state: "resolved",
    });

    const application = await prisma.application.findFirstOrThrow();
    expect(application).toMatchObject({ title: "Platform Engineer", status: "applied" });
    expect(await messageState("low")).toBe("applied");
    expect(await openItems()).toEqual([]);
    const stored = await prisma.reviewItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(stored.resolvedAt).toEqual(NOW);
    expect(stored.resolution).toMatchObject({ action: "apply", by: "owner" });

    // The same path as an automatic change: a timeline event that undo can revert.
    const event = await prisma.event.findFirstOrThrow({ where: { type: "application_created" } });
    expect(event).toMatchObject({
      messageId: "low",
      applicationId: application.id,
      undoable: true,
    });
    await undoEvent(prisma, event.id, NOW);
    expect(await prisma.application.count()).toBe(0);
  });

  it("edit_apply applies the edited fields", async () => {
    const t = await setup();
    await lowConfidence("low", { category: "rejection", summary: "Rejected" });
    await t.drain();
    const item = await only();

    const response = await t.resolve(item.id, {
      action: "edit_apply",
      edits: {
        category: "application_confirmation",
        jobUrl: "https://boards.greenhouse.io/quarry/jobs/77",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(await prisma.application.findFirstOrThrow()).toMatchObject({
      status: "applied",
      jobKey: "greenhouse:quarry:77",
    });
    expect(
      (await prisma.reviewItem.findUniqueOrThrow({ where: { id: item.id } })).resolution,
    ).toMatchObject({ action: "edit_apply", edits: { category: "application_confirmation" } });
  });

  it("edit_apply accepts only the category and the job link, and needs at least one", async () => {
    const t = await setup();
    await lowConfidence();
    await t.drain();
    const item = await only();
    for (const edits of [{ summary: "x" }, { confidence: 1 }, {}]) {
      const response = await t.resolve(item.id, { action: "edit_apply", edits });
      expect(response.statusCode).toBe(400);
      expect(errorCode(response)).toBe("validation_failed");
    }
    expect((await t.resolve(item.id, { action: "edit_apply" })).statusCode).toBe(400);
    expect(await prisma.application.count()).toBe(0);
    expect(await messageState("low")).toBe("needs_review");
  });

  it("dismiss changes nothing and marks the item dismissed", async () => {
    const t = await setup();
    await lowConfidence();
    await t.drain();
    const item = await only();
    const before = await prisma.application.count();

    const response = await t.resolve(item.id, { action: "dismiss" });
    expect(response.statusCode).toBe(200);
    expect(ReviewItemSchema.parse(body(response)).state).toBe("dismissed");
    expect(await prisma.application.count()).toBe(before);
    expect(await prisma.event.count()).toBe(0);
    expect(await prisma.company.count()).toBe(0);
    // The email no longer waits for a decision.
    expect(await messageState("low")).toBe("applied");
    expect((await prisma.reviewItem.findUniqueOrThrow({ where: { id: item.id } })).state).toBe(
      "dismissed",
    );
  });

  it("an owner edit that lands while the change is written → 409 version_conflict with the item; nothing changes", async () => {
    const t = await setup();
    const company = await seedCompany("Quarry AI", ["quarry.example"]);
    const application = await seedApplication(company.id, "Platform Engineer");
    await seed({
      id: "low",
      at: AT,
      extraction: extraction({ category: "rejection", confidence: 0.5, summary: "Rejected" }),
    });
    await t.drain();
    const item = await only();
    expect(item.kind).toBe("low_confidence");

    // The owner saves a note (taking no lock) after the plan was made and before it is written.
    let edited = false;
    const racing = interceptTx(t.ctx, "application", "findUnique", async (call) => {
      if (!edited) {
        edited = true;
        await prisma.application.update({
          where: { id: application.id },
          data: { notes: "Owner note", version: { increment: 1 } },
        });
      }
      return call();
    });
    const error = await resolveReviewItem(racing, item.id, { action: "apply" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(edited).toBe(true);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      code: "version_conflict",
      current: { id: item.id, state: "open", kind: "low_confidence" },
    });
    expect(await messageState("low")).toBe("needs_review");
    expect(await prisma.event.count()).toBe(0);
    expect(
      await prisma.application.findUniqueOrThrow({ where: { id: application.id } }),
    ).toMatchObject({ status: "applied", notes: "Owner note", version: 2 });

    // Trying again plans against the edited record and goes through.
    expect((await t.resolve(item.id, { action: "apply" })).statusCode).toBe(200);
    expect(
      (await prisma.application.findUniqueOrThrow({ where: { id: application.id } })).status,
    ).toBe("rejected");
  });
});

// --- ambiguous match -----------------------------------------------------------------------------

describe("POST /review-items/:id/resolve: ambiguous_match", () => {
  it("attach links the email to the chosen candidate", async () => {
    const t = await setup();
    const { first, second } = await ambiguous();
    await t.drain();
    const item = await only();
    expect(item.kind).toBe("ambiguous_match");

    const response = await t.resolve(item.id, { action: "attach", applicationId: second.id });
    expect(response.statusCode).toBe(200);
    expect(await prisma.application.findUniqueOrThrow({ where: { id: second.id } })).toMatchObject({
      status: "rejected",
    });
    expect(await prisma.application.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({
      status: "applied",
    });
    expect(
      (await prisma.gmailMessage.findUniqueOrThrow({ where: { id: "amb" } })).applicationId,
    ).toBe(second.id);
    expect(await prisma.event.findMany({ select: { type: true, applicationId: true } })).toEqual(
      expect.arrayContaining([{ type: "status_changed", applicationId: second.id }]),
    );
    expect(
      (await prisma.reviewItem.findUniqueOrThrow({ where: { id: item.id } })).resolution,
    ).toMatchObject({ action: "attach", applicationId: second.id });
  });

  it("attach needs an existing application", async () => {
    const t = await setup();
    await ambiguous();
    await t.drain();
    const item = await only();
    expect((await t.resolve(item.id, { action: "attach" })).statusCode).toBe(400);
    const missing = await t.resolve(item.id, {
      action: "attach",
      applicationId: "00000000-0000-4000-8000-000000000000",
    });
    expect(missing.statusCode).toBe(400);
    expect(errorCode(missing)).toBe("validation_failed");
    expect(await messageState("amb")).toBe("needs_review");
  });

  it("create_new creates an application", async () => {
    const t = await setup();
    await ambiguous();
    await t.drain();
    const item = await only();

    const response = await t.resolve(item.id, { action: "create_new" });
    expect(response.statusCode).toBe(200);
    expect(await prisma.application.count()).toBe(3);
    expect(await messageState("amb")).toBe("applied");
    expect(
      await prisma.event.findFirstOrThrow({ where: { type: "application_created" } }),
    ).toMatchObject({
      messageId: "amb",
      undoable: true,
    });
  });
});

// --- unexpected transition -----------------------------------------------------------------------

describe("POST /review-items/:id/resolve: unexpected_transition", () => {
  it("reopen applies the unexpected transition", async () => {
    const t = await setup();
    const { application } = await unexpected();
    await t.drain();
    const item = await only();
    expect(item.kind).toBe("unexpected_transition");

    const response = await t.resolve(item.id, { action: "reopen" });
    expect(response.statusCode).toBe(200);
    expect(
      await prisma.application.findUniqueOrThrow({ where: { id: application.id } }),
    ).toMatchObject({ status: "applied" });
    expect(
      await prisma.event.findFirstOrThrow({ where: { applicationId: application.id } }),
    ).toMatchObject({
      type: "status_changed",
      undoable: true,
    });
  });

  it("timeline_only only records an email_received event", async () => {
    const t = await setup();
    const { application } = await unexpected();
    await t.drain();
    const item = await only();

    const response = await t.resolve(item.id, { action: "timeline_only" });
    expect(response.statusCode).toBe(200);
    expect(
      await prisma.application.findUniqueOrThrow({ where: { id: application.id } }),
    ).toMatchObject({ status: "rejected" });
    const events = await prisma.event.findMany({ where: { applicationId: application.id } });
    expect(events.map((e) => e.type)).toEqual(["email_received"]);
  });

  it("an action the kind does not offer → 400 and nothing changes", async () => {
    const t = await setup();
    await unexpected();
    await t.drain();
    const item = await only();
    for (const action of ["apply", "dismiss", "merge", "retry"] as const) {
      const response = await t.resolve(item.id, { action });
      expect(response.statusCode).toBe(400);
      expect(errorCode(response)).toBe("validation_failed");
    }
    expect((await t.resolve(item.id, { action: "explode" } as never)).statusCode).toBe(400);
    expect((await prisma.reviewItem.findUniqueOrThrow({ where: { id: item.id } })).state).toBe(
      "open",
    );
  });
});

// --- duplicate company ---------------------------------------------------------------------------

describe("POST /review-items/:id/resolve: possible_duplicate_company", () => {
  it("merge moves records into the target and deletes the source", async () => {
    const t = await setup();
    const existing = await duplicate();
    await t.drain();
    const created = await prisma.company.findUniqueOrThrow({ where: { normalizedName: "acme" } });
    await prisma.contact.create({
      data: { email: "rec@acme-careers.example", companyId: created.id },
    });
    const item = await only();
    expect(item).toMatchObject({ kind: "possible_duplicate_company", companyId: created.id });

    const response = await t.resolve(item.id, { action: "merge" });
    expect(response.statusCode).toBe(200);
    expect(ReviewItemSchema.parse(body(response)).state).toBe("resolved");

    expect(await prisma.company.findUnique({ where: { id: created.id } })).toBeNull();
    const target = await prisma.company.findUniqueOrThrow({ where: { id: existing.id } });
    expect(target.aliases.sort()).toEqual(["acme", "acme robotics intl"]);
    expect(target.domains.sort()).toEqual(["acme-careers.example", "acme-robotics.example"]);
    expect(target.atsSlugs).toEqual(["greenhouse:acme"]);
    expect(target.version).toBe(2);
    const application = await prisma.application.findFirstOrThrow();
    expect(application.companyId).toBe(existing.id);
    expect((await prisma.contact.findFirstOrThrow()).companyId).toBe(existing.id);
    expect(
      (await prisma.event.findFirstOrThrow({ where: { type: "application_created" } })).companyId,
    ).toBe(existing.id);
    // The item survives the delete of the company it was about.
    expect(await prisma.reviewItem.findUnique({ where: { id: item.id } })).toMatchObject({
      state: "resolved",
      companyId: existing.id,
    });
  });

  it("same_group sets group_id on the new company; keep_separate changes nothing", async () => {
    const t = await setup();
    const existing = await duplicate();
    await t.drain();
    const created = await prisma.company.findUniqueOrThrow({ where: { normalizedName: "acme" } });
    const item = await only();

    expect((await t.resolve(item.id, { action: "same_group" })).statusCode).toBe(200);
    expect(await prisma.company.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({
      groupId: existing.id,
      version: 2,
    });
    expect(await prisma.company.findUniqueOrThrow({ where: { id: existing.id } })).toMatchObject({
      groupId: null,
      version: 1,
    });
    expect(await prisma.application.count()).toBe(1);

    // keep_separate on a fresh notice.
    await prisma.reviewItem.update({
      where: { id: item.id },
      data: { state: "open", resolvedAt: null },
    });
    await prisma.company.update({ where: { id: created.id }, data: { groupId: null, version: 1 } });
    const snapshot = await prisma.company.findMany({ orderBy: { id: "asc" } });
    expect((await t.resolve(item.id, { action: "keep_separate" })).statusCode).toBe(200);
    expect(await prisma.company.findMany({ orderBy: { id: "asc" } })).toEqual(snapshot);
    expect((await prisma.reviewItem.findUniqueOrThrow({ where: { id: item.id } })).state).toBe(
      "resolved",
    );
  });

  it("merge when the other company is gone → 409 changed_since and nothing changes", async () => {
    const t = await setup();
    const existing = await duplicate();
    await t.drain();
    const item = await only();
    await prisma.company.delete({ where: { id: existing.id } });
    const response = await t.resolve(item.id, { action: "merge" });
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe("changed_since");
    expect(await prisma.company.count()).toBe(1);
  });
});

describe("mergeCompanies", () => {
  it("keeps groups one level deep and refuses to merge a company into itself", async () => {
    const root = await seedCompany("Globex Group");
    const source = await prisma.company.create({
      data: { name: "Globex Labs", normalizedName: "globex labs", createdSource: "manual" },
    });
    const member = await prisma.company.create({
      data: {
        name: "Globex Cloud",
        normalizedName: "globex cloud",
        groupId: source.id,
        createdSource: "manual",
      },
    });
    const target = await prisma.company.create({
      data: {
        name: "Globex",
        normalizedName: "globex",
        groupId: root.id,
        websiteDomain: null,
        createdSource: "manual",
      },
    });
    await prisma.$transaction((tx) => mergeCompanies(tx, source.id, target.id));
    expect(await prisma.company.findUniqueOrThrow({ where: { id: member.id } })).toMatchObject({
      groupId: root.id,
    });
    expect(await prisma.company.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({
      groupId: root.id,
      aliases: ["globex labs"],
    });
    await expect(
      prisma.$transaction((tx) => mergeCompanies(tx, root.id, root.id)),
    ).rejects.toMatchObject({ status: 400 });
  });
});

// --- extraction failed ---------------------------------------------------------------------------

describe("POST /review-items/:id/resolve: extraction_failed", () => {
  async function failedMessage(reason: string, over: Partial<SeedMessage> = {}) {
    await seed({ id: "f", at: AT, ...over });
    await prisma.gmailMessage.update({
      where: { id: "f" },
      data: {
        state: "failed",
        attempts: 3,
        lastError: "boom",
        processedAt: new Date("2026-09-01T00:00:00Z"),
      },
    });
    return prisma.reviewItem.create({
      data: { kind: "extraction_failed", messageId: "f", reasons: [reason] },
    });
  }

  it("retry on an apply_failed item resets the counters and sends the stored extraction to the next apply", async () => {
    const t = await setup();
    const item = await failedMessage("apply_failed");

    const response = await t.resolve(item.id, { action: "retry" });
    expect(response.statusCode).toBe(200);
    expect(await prisma.gmailMessage.findUniqueOrThrow({ where: { id: "f" } })).toMatchObject({
      state: "extracted",
      attempts: 0,
      lastError: null,
      processedAt: NOW,
    });
    expect(t.queue.sentNames).toEqual([QUEUES.emailApply]);
    expect(ReviewItemSchema.parse(body(response)).state).toBe("resolved");

    // The next apply drain picks it up.
    expect(await t.drain()).toEqual({ applied: 1 });
    expect(await prisma.application.count()).toBe(1);
  });

  it("retry on another failure sends the message back to extraction with attempts and processed_at reset", async () => {
    const t = await setup();
    const item = await failedMessage("extraction_failed", { state: "job_related" });
    // job_related seeds carry triage content only.
    expect(
      (await prisma.gmailMessage.findUniqueOrThrow({ where: { id: "f" } })).subject,
    ).not.toBeNull();

    expect((await t.resolve(item.id, { action: "retry" })).statusCode).toBe(200);
    expect(await prisma.gmailMessage.findUniqueOrThrow({ where: { id: "f" } })).toMatchObject({
      state: "job_related",
      attempts: 0,
      lastError: null,
      processedAt: NOW,
    });
    expect(t.queue.sent).toEqual([
      { name: QUEUES.emailExtract, data: { messageId: "f" }, opts: { singletonKey: "f" } },
    ]);
  });

  it("retry on a triage failure (no content kept) goes back to triage", async () => {
    const t = await setup();
    const item = await failedMessage("triage_failed", { state: "discovered" });
    await prisma.gmailMessage.update({
      where: { id: "f" },
      data: { fromEmail: null, fromName: null, subject: null, snippet: null, toEmails: [] },
    });
    expect((await t.resolve(item.id, { action: "retry" })).statusCode).toBe(200);
    expect(await messageState("f")).toBe("discovered");
    expect(t.queue.sentNames).toEqual([QUEUES.emailTriage]);
  });

  it("retry keeps working when the queue is down: the sweeps pick the message up", async () => {
    const t = await setup();
    const item = await failedMessage("apply_failed");
    t.queue.failSendWith = new Error("queue down");
    expect((await t.resolve(item.id, { action: "retry" })).statusCode).toBe(200);
    expect(await messageState("f")).toBe("extracted");
  });

  it("retry on a message that is no longer failed → 409 changed_since", async () => {
    const t = await setup();
    const item = await failedMessage("apply_failed");
    await prisma.gmailMessage.update({ where: { id: "f" }, data: { state: "applied" } });
    const response = await t.resolve(item.id, { action: "retry" });
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe("changed_since");
    expect(t.queue.sent).toEqual([]);
  });

  it("dismiss leaves the message failed and marks the item dismissed", async () => {
    const t = await setup();
    const item = await failedMessage("apply_failed");
    const response = await t.resolve(item.id, { action: "dismiss" });
    expect(ReviewItemSchema.parse(body(response)).state).toBe("dismissed");
    expect(await messageState("f")).toBe("failed");
    expect(t.queue.sent).toEqual([]);
  });
});

// --- undone change -------------------------------------------------------------------------------

describe("POST /review-items/:id/resolve: undone_change", () => {
  async function undoneApplication(t: Awaited<ReturnType<typeof setup>>) {
    await seed({ id: "m1", at: AT, extraction: extraction() });
    await t.drain();
    const event = await prisma.event.findFirstOrThrow({ where: { type: "application_created" } });
    await undoEvent(prisma, event.id, NOW);
    expect(await prisma.application.count()).toBe(0);
    return only();
  }

  it("reprocess re-plans an undone change", async () => {
    const t = await setup();
    const item = await undoneApplication(t);
    expect(item.kind).toBe("undone_change");

    const response = await t.resolve(item.id, { action: "reprocess" });
    expect(response.statusCode).toBe(200);
    expect(await prisma.gmailMessage.findUniqueOrThrow({ where: { id: "m1" } })).toMatchObject({
      state: "job_related",
      attempts: 0,
      processedAt: NOW,
    });
    expect(t.queue.sent).toEqual([
      { name: QUEUES.emailExtract, data: { messageId: "m1" }, opts: { singletonKey: "m1" } },
    ]);

    // Extraction finishes again, apply plans the email afresh: the application is back, with a new
    // event (the undone one no longer holds the slot), and the new change can be undone too.
    await prisma.gmailMessage.update({ where: { id: "m1" }, data: { state: "extracted" } });
    expect(await t.drain()).toEqual({ applied: 1 });
    expect(await prisma.application.count()).toBe(1);
    const created = await prisma.event.findMany({ where: { type: "application_created" } });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ messageId: "m1", undoneAt: null, undoable: true });
    await undoEvent(prisma, created[0]?.id ?? "", NOW);
    expect(await prisma.application.count()).toBe(0);
  });

  it("ignore resolves the item and changes nothing", async () => {
    const t = await setup();
    const item = await undoneApplication(t);
    const response = await t.resolve(item.id, { action: "ignore" });
    expect(ReviewItemSchema.parse(body(response)).state).toBe("resolved");
    expect(await messageState("m1")).toBe("applied");
    expect(t.queue.sent).toEqual([]);
    expect(await prisma.application.count()).toBe(0);
  });
});

// --- state errors --------------------------------------------------------------------------------

describe("resolving", () => {
  it("an item that is no longer open → 409 changed_since", async () => {
    const t = await setup();
    await lowConfidence();
    await t.drain();
    const item = await only();
    expect((await t.resolve(item.id, { action: "apply" })).statusCode).toBe(200);
    const again = await t.resolve(item.id, { action: "apply" });
    expect(again.statusCode).toBe(409);
    expect(errorCode(again)).toBe("changed_since");
    expect(await prisma.application.count()).toBe(1);
    expect(await prisma.event.count({ where: { type: "application_created" } })).toBe(1);
  });

  it("an unknown or malformed id → 404; a missing CSRF header → 403", async () => {
    const t = await setup();
    for (const id of ["00000000-0000-4000-8000-000000000000", "nope"]) {
      const response = await t.resolve(id, { action: "apply" });
      expect(response.statusCode).toBe(404);
      expect(errorCode(response)).toBe("not_found");
    }
    const noHeader = await t.app.inject({
      method: "POST",
      url: "/api/v1/review-items/x/resolve",
      headers: { cookie: await signIn(t.app, t.deps) },
      payload: { action: "apply" },
    });
    expect(noHeader.statusCode).toBe(403);
  });

  it("applying when the email is no longer waiting (reprocessed meanwhile) → 409 and nothing changes", async () => {
    const t = await setup();
    await lowConfidence();
    await t.drain();
    const item = await only();
    await prisma.gmailMessage.update({ where: { id: "low" }, data: { state: "job_related" } });
    const response = await t.resolve(item.id, { action: "apply" });
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe("changed_since");
    expect(await prisma.application.count()).toBe(0);
  });

  it("a choice that raises another question keeps the item open with the new question", async () => {
    // One application when the low-confidence item was made; a second by the time it is decided.
    const t = await setup();
    const company = await seedCompany("Quarry AI", ["quarry.example"]);
    const first = await seedApplication(company.id, "Platform Engineer");
    await seed({
      id: "both",
      at: AT,
      extraction: extraction({ category: "rejection", role: null, confidence: 0.5 }),
    });
    await t.drain();
    const item = await only();
    expect(item.kind).toBe("low_confidence");
    const second = await seedApplication(company.id, "Data Analyst");

    const response = await t.resolve(item.id, { action: "apply" });
    expect(response.statusCode).toBe(200);
    const dto = ReviewItemSchema.parse(body(response));
    expect(dto).toMatchObject({ id: item.id, kind: "ambiguous_match", state: "open" });
    expect(dto.candidates.map((c) => c.id).sort()).toEqual([first.id, second.id].sort());
    expect(await messageState("both")).toBe("needs_review");
    expect(await prisma.event.count()).toBe(0);
    expect(await prisma.reviewItem.count()).toBe(1);

    // The new question is answered like any other.
    expect(
      (await t.resolve(item.id, { action: "attach", applicationId: second.id })).statusCode,
    ).toBe(200);
    expect((await prisma.application.findUniqueOrThrow({ where: { id: second.id } })).status).toBe(
      "rejected",
    );
  });
});

// --- messages (AC-6.2) ---------------------------------------------------------------------------

describe("messages", () => {
  it("GET /messages/:id returns the stored plain-text body", async () => {
    const t = await setup();
    await lowConfidence();
    const response = await t.call("GET", "/messages/low");
    expect(response.statusCode).toBe(200);
    expect(body(response)).toEqual({
      id: "low",
      internalDate: AT,
      direction: "inbound",
      fromName: "Quarry Careers",
      fromEmail: "careers@quarry.example",
      subject: "Subject of low",
      summary: "Application received",
      category: "application_confirmation",
      bodyText: "Body of low",
      toEmails: ["owner@example.com"],
    });
    expect((await t.call("GET", "/messages/missing")).statusCode).toBe(404);
  });

  it("POST /messages/:id/reprocess → 202, back to job_related with the counters reset", async () => {
    const t = await setup();
    await lowConfidence();
    await t.drain();
    const item = await only();
    await prisma.gmailMessage.update({ where: { id: "low" }, data: { attempts: 4 } });

    const response = await t.call("POST", "/messages/low/reprocess");
    expect(response.statusCode).toBe(202);
    expect(await prisma.gmailMessage.findUniqueOrThrow({ where: { id: "low" } })).toMatchObject({
      state: "job_related",
      attempts: 0,
      processedAt: NOW,
    });
    expect(t.queue.sent).toEqual([
      { name: QUEUES.emailExtract, data: { messageId: "low" }, opts: { singletonKey: "low" } },
    ]);
    // The question the old run asked no longer applies.
    expect((await prisma.reviewItem.findUniqueOrThrow({ where: { id: item.id } })).state).toBe(
      "resolved",
    );
    expect((await t.call("POST", "/messages/missing/reprocess")).statusCode).toBe(404);
  });

  it("an email without stored content goes back to triage; one in flight is left alone", async () => {
    const t = await setup();
    await seed({ id: "gone", at: AT, state: "triaged_out" });
    await prisma.gmailMessage.update({
      where: { id: "gone" },
      data: { fromEmail: null, fromName: null, subject: null, snippet: null },
    });
    expect((await t.call("POST", "/messages/gone/reprocess")).statusCode).toBe(202);
    expect(await messageState("gone")).toBe("discovered");
    expect(t.queue.sentNames).toEqual([QUEUES.emailTriage]);

    t.queue.sent.length = 0;
    expect((await t.call("POST", "/messages/gone/reprocess")).statusCode).toBe(202);
    expect(t.queue.sent).toEqual([]);
  });
});
