import type { EmailFixture, TriageItem } from "@offerbound/contracts";
import { DEFAULT_SETTINGS } from "@offerbound/contracts";
import pino from "pino";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDb, testPrisma } from "../../test/db.js";
import { emailFixture, seedConnection } from "../../test/gmail.js";
import { testWorkerCtx } from "../../test/worker.js";
import {
  GmailAuthError,
  GmailRequestError,
  GmailRetryableError,
  type GmailClient,
} from "../gmail/client.js";
import { FakeGmailClient, fakeGmailFactory } from "../gmail/fake-client.js";
import { FakeLlmProvider } from "../llm/fake-provider.js";
import { LlmError } from "../llm/provider.js";
import { saveSettings } from "../settings/service.js";
import {
  EXTRACT_RESEND_AFTER_MS,
  loadTriageLookups,
  MAX_EXTRACT_RESENDS,
  resendPendingExtractions,
  runTriageBatch,
} from "./triage.js";

const prisma = testPrisma();

beforeEach(async () => {
  await resetDb(prisma);
});

type MailOver = {
  from?: string;
  to?: string[];
  cc?: string[];
  subject?: string;
  labels?: string[];
  snippet?: string;
  date?: string;
  triage?: TriageItem | null;
  threadId?: string;
};

/** An inbound message from an unknown sender unless told otherwise. */
function mail(id: string, over: MailOver = {}): EmailFixture {
  const base = emailFixture(id, over.date ?? "2026-10-05T10:00:00.000Z");
  return {
    ...base,
    threadId: over.threadId ?? `thr-${id}`,
    labels: over.labels ?? ["INBOX"],
    snippet: over.snippet ?? `Preview of ${id}`,
    headers: {
      ...base.headers,
      from: over.from ?? "Sam Stranger <sam@unknown.example>",
      to: over.to ?? ["owner@example.com"],
      ...(over.cc ? { cc: over.cc } : {}),
      subject: over.subject ?? `Subject of ${id}`,
    },
    llm: { triage: over.triage ?? null, extraction: null },
  };
}

const verdict = (id: string, jobRelated: boolean, confidence: number): TriageItem => ({
  id,
  jobRelated,
  confidence,
});

/** Inserts the placeholder rows sync discovery leaves: epoch date, inbound, no labels. */
async function discover(
  ids: string[],
  threadOf: (id: string) => string = (id) => `thr-${id}`,
  discoveredAt?: (index: number) => Date,
): Promise<void> {
  await prisma.gmailMessage.createMany({
    data: ids.map((id, index) => ({
      id,
      threadId: threadOf(id),
      internalDate: new Date(0),
      direction: "inbound" as const,
      labelIds: [],
      ...(discoveredAt ? { discoveredAt: discoveredAt(index) } : {}),
    })),
  });
}

async function setup(fixtures: EmailFixture[], gmail?: GmailClient) {
  await discover(
    fixtures.map((f) => f.id),
    (id) => fixtures.find((f) => f.id === id)?.threadId ?? `thr-${id}`,
  );
  const llm = FakeLlmProvider.fromFixtures({ emails: fixtures, leadBatches: [] });
  const ctx = testWorkerCtx({
    gmail: fakeGmailFactory(gmail ?? new FakeGmailClient(fixtures)),
    llm,
  });
  return { ctx, llm };
}

const row = (id: string) => prisma.gmailMessage.findUniqueOrThrow({ where: { id } });

/** Every column that holds message content (SECURITY §3). */
function contentOf(stored: Awaited<ReturnType<typeof row>>) {
  return {
    fromEmail: stored.fromEmail,
    fromName: stored.fromName,
    toEmails: stored.toEmails,
    subject: stored.subject,
    snippet: stored.snippet,
    bodyText: stored.bodyText,
    summary: stored.summary,
    extraction: stored.extraction,
    icsEvents: stored.icsEvents,
    category: stored.category,
    extractConfidence: stored.extractConfidence,
  };
}

const NO_CONTENT = {
  fromEmail: null,
  fromName: null,
  toEmails: [],
  subject: null,
  snippet: null,
  bodyText: null,
  summary: null,
  extraction: null,
  icsEvents: null,
  category: null,
  extractConfidence: null,
};

describe("runTriageBatch: rules (stage 1a)", () => {
  it("messages decided by a rule never reach the LLM", async () => {
    const { ctx, llm } = await setup([
      mail("ats", { from: "Hiring <no-reply@greenhouse-mail.io>" }),
      mail("alert", { from: "LinkedIn <jobs-noreply@linkedin.com>" }),
      mail("spam", { labels: ["SPAM"] }),
      mail("promo", { labels: ["INBOX", "CATEGORY_PROMOTIONS"] }),
    ]);
    expect(await runTriageBatch(ctx)).toMatchObject({ processed: 4 });
    expect(llm.calls).toEqual([]);
    expect((await row("ats")).state).toBe("job_related");
    expect((await row("ats")).triageRule).toBe("R4");
    expect((await row("alert")).triageRule).toBe("R5");
    expect((await row("spam")).state).toBe("skipped");
    expect((await row("promo")).state).toBe("triaged_out");
  });

  it("overwrites the placeholder date, direction and labels from the metadata before any rule", async () => {
    const { ctx } = await setup([
      mail("sent", {
        date: "2026-10-02T08:30:00.000Z",
        labels: ["SENT"],
        from: "Owner <owner@example.com>",
        to: ["Nobody <nobody@unknown.example>"],
      }),
      mail("in", { date: "2026-10-03T08:30:00.000Z", labels: ["INBOX", "UNREAD"] }),
    ]);
    await runTriageBatch(ctx);
    const sent = await row("sent");
    expect(sent.internalDate).toEqual(new Date("2026-10-02T08:30:00.000Z"));
    expect(sent.direction).toBe("outbound");
    expect(sent.labelIds).toEqual(["SENT"]);
    const received = await row("in");
    expect(received.internalDate).toEqual(new Date("2026-10-03T08:30:00.000Z"));
    expect(received.direction).toBe("inbound");
    expect(received.labelIds).toEqual(["INBOX", "UNREAD"]);
  });

  it("skips a message dated before the backfill start in the owner's time zone (R1)", async () => {
    // 2026-09-01 00:00 in Monterrey (UTC-6) is 06:00 UTC.
    const { ctx } = await setup([
      mail("early", { date: "2026-09-01T05:59:00.000Z" }),
      mail("late", { date: "2026-09-01T06:01:00.000Z", from: "x <hr@greenhouse-mail.io>" }),
    ]);
    await runTriageBatch(ctx);
    expect(await row("early")).toMatchObject({ state: "skipped", triageRule: "R1" });
    expect((await row("late")).state).toBe("job_related");
  });

  it("uses linked threads, known contacts, company domains and the ignore list", async () => {
    const company = await prisma.company.create({
      data: {
        name: "Quarry AI",
        normalizedName: "quarry ai",
        domains: ["quarry.example"],
        createdSource: "manual",
      },
    });
    const application = await prisma.application.create({
      data: {
        companyId: company.id,
        title: "Engineer",
        status: "applied",
        statusChangedAt: new Date("2026-09-10T00:00:00Z"),
        source: "manual",
      },
    });
    await prisma.threadLink.create({
      data: { threadId: "thr-linked", applicationId: application.id },
    });
    await prisma.contact.create({ data: { email: "Rita@Agency.example" } });
    await saveSettings(prisma, {
      ...DEFAULT_SETTINGS,
      automation: { ...DEFAULT_SETTINGS.automation, senderIgnoreList: ["noise.example"] },
    });

    const lookups = await loadTriageLookups(prisma);
    expect([...lookups.linkedThreadIds]).toEqual(["thr-linked"]);
    expect([...lookups.contactEmails].map((e) => e.toLowerCase())).toEqual(["rita@agency.example"]);
    expect([...lookups.companyDomains]).toEqual(["quarry.example"]);
    expect(lookups.ignoreList).toEqual(["noise.example"]);

    const { ctx, llm } = await setup([
      mail("thread", { threadId: "thr-linked" }),
      mail("contact", { from: "Rita <rita@agency.example>" }),
      mail("domain", { from: "HR <jobs@mail.quarry.example>" }),
      mail("ignored", { from: "Bot <bot@noise.example>" }),
    ]);
    await runTriageBatch(ctx);
    expect(llm.calls).toEqual([]);
    expect(await row("thread")).toMatchObject({ state: "job_related", triageRule: "R2" });
    expect(await row("contact")).toMatchObject({ state: "job_related", triageRule: "R6" });
    expect(await row("domain")).toMatchObject({ state: "job_related", triageRule: "R6" });
    expect(await row("ignored")).toMatchObject({ state: "triaged_out", triageRule: "R7" });
  });

  it("outgoing mail to an unknown recipient never reaches the LLM", async () => {
    // AC-3.1
    const { ctx, llm } = await setup([
      mail("out", {
        labels: ["SENT"],
        from: "Owner <owner@example.com>",
        to: ["Stranger <someone@unknown.example>"],
      }),
    ]);
    await runTriageBatch(ctx);
    expect(llm.calls).toEqual([]);
    expect(await row("out")).toMatchObject({
      state: "triaged_out",
      triageRule: "R3",
      direction: "outbound",
    });
  });

  it("outgoing mail to a known contact is job-related and keeps its direction", async () => {
    await prisma.contact.create({ data: { email: "rita@agency.example" } });
    const { ctx, llm } = await setup([
      mail("out", {
        labels: ["SENT"],
        from: "Owner <owner@example.com>",
        to: ["Rita <rita@agency.example>"],
      }),
    ]);
    await runTriageBatch(ctx);
    expect(llm.calls).toEqual([]);
    expect(await row("out")).toMatchObject({ state: "job_related", direction: "outbound" });
  });

  it("promotions that match no rule are discarded without an LLM call", async () => {
    // AC-3.3
    const { ctx, llm } = await setup([
      mail("promo", { labels: ["INBOX", "CATEGORY_PROMOTIONS"] }),
      mail("forum", { labels: ["INBOX", "CATEGORY_FORUMS"] }),
    ]);
    await runTriageBatch(ctx);
    expect(llm.calls).toEqual([]);
    expect(await row("promo")).toMatchObject({ state: "triaged_out", triageRule: "R8" });
    expect((await row("forum")).state).toBe("triaged_out");
  });
});

describe("runTriageBatch: LLM triage (stage 1b)", () => {
  it("the LLM gets only id, sender name, sender address, subject and preview", async () => {
    // AC-3.4
    const long = "p".repeat(500);
    const { ctx, llm } = await setup([
      mail("a", { snippet: long, triage: verdict("a", false, 0.9) }),
      mail("b", { cc: ["cc-person@unknown.example"], triage: verdict("b", false, 0.9) }),
    ]);
    await runTriageBatch(ctx);

    expect(llm.calls).toHaveLength(1);
    const call = llm.calls[0];
    expect(call?.purpose).toBe("triage");
    const items = call?.input as Record<string, unknown>[];
    expect(items.map((item) => item.id)).toEqual(["a", "b"]);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual([
        "fromEmail",
        "fromName",
        "id",
        "preview",
        "subject",
      ]);
    }
    expect(items[0]).toMatchObject({
      fromName: "Sam Stranger",
      fromEmail: "sam@unknown.example",
      subject: "Subject of a",
    });
    expect((items[0]?.preview as string).length).toBe(300);
    const sent = JSON.stringify(items);
    expect(sent).not.toContain("owner@example.com");
    expect(sent).not.toContain("cc-person");
    expect(sent).not.toContain("Body of");
  });

  it("jobRelated false at 0.65 still goes to extraction; at 0.70 it is triaged out", async () => {
    const { ctx, llm } = await setup([
      mail("low", { triage: verdict("low", false, 0.65) }),
      mail("edge", { triage: verdict("edge", false, 0.7) }),
      mail("yes", { triage: verdict("yes", true, 0.4) }),
      mail("no", { triage: verdict("no", false, 0.95) }),
    ]);
    await runTriageBatch(ctx);
    expect(llm.calls).toHaveLength(1);
    expect(await row("low")).toMatchObject({
      state: "job_related",
      triageMethod: "llm",
      triageRule: "R9",
      triageConfidence: 0.65,
    });
    expect((await row("edge")).state).toBe("triaged_out");
    expect((await row("yes")).state).toBe("job_related");
    expect(await row("no")).toMatchObject({ state: "triaged_out", triageMethod: "llm" });
  });

  it("a message the LLM leaves out of its answer is a failed attempt, not a decision", async () => {
    const fixtures = [mail("a", { triage: verdict("a", true, 0.9) }), mail("b")];
    const { ctx, llm } = await setup(fixtures);
    llm.register("triage", { messageId: "b" }, verdict("zzz", true, 0.9));
    await runTriageBatch(ctx);
    expect((await row("a")).state).toBe("job_related");
    expect(await row("b")).toMatchObject({ state: "discovered", attempts: 1 });
  });
});

describe("runTriageBatch: what is stored", () => {
  it("triaged_out and skipped rows keep only id, thread, date, labels, state and rule; content columns are null", async () => {
    // AC-3.5
    const { ctx } = await setup([
      mail("spam", { labels: ["SPAM"], subject: "Win a prize", snippet: "secret preview" }),
      mail("promo", { labels: ["INBOX", "CATEGORY_PROMOTIONS"] }),
      mail("llm", { triage: verdict("llm", false, 0.9) }),
      mail("out", {
        labels: ["SENT"],
        from: "Owner <owner@example.com>",
        to: ["Stranger <someone@unknown.example>"],
      }),
    ]);
    await runTriageBatch(ctx);
    for (const id of ["spam", "promo", "llm", "out"]) {
      const stored = await row(id);
      expect(contentOf(stored), id).toEqual(NO_CONTENT);
      expect(stored.internalDate.getTime(), id).toBeGreaterThan(0);
      expect(stored.triageRule, id).not.toBeNull();
      expect(stored.processedAt, id).not.toBeNull();
    }
    expect(await row("spam")).toMatchObject({
      state: "skipped",
      triageRule: "R1",
      labelIds: ["SPAM"],
      threadId: "thr-spam",
    });
  });

  it("a job-related message stores from, to, subject and snippet and sends email.extract once (singletonKey = id)", async () => {
    const { ctx } = await setup([
      mail("job", {
        from: "Priya Ramanathan <priya@greenhouse-mail.io>",
        to: ["Owner <owner@example.com>", "Second <second@example.com>"],
        subject: "Your application",
        snippet: "Thanks for applying",
      }),
    ]);
    await runTriageBatch(ctx);
    const stored = await row("job");
    expect(stored).toMatchObject({
      state: "job_related",
      triageMethod: "rule",
      triageRule: "R4",
      fromEmail: "priya@greenhouse-mail.io",
      fromName: "Priya Ramanathan",
      toEmails: ["owner@example.com", "second@example.com"],
      subject: "Your application",
      snippet: "Thanks for applying",
      bodyText: null,
    });
    expect(ctx.queue.sent).toEqual([
      { name: "email.extract", data: { messageId: "job" }, opts: { singletonKey: "job" } },
    ]);
  });

  it("sends nothing for messages that were triaged out, skipped or left undecided", async () => {
    const { ctx } = await setup([
      mail("spam", { labels: ["SPAM"] }),
      mail("promo", { labels: ["CATEGORY_PROMOTIONS"] }),
    ]);
    await runTriageBatch(ctx);
    expect(ctx.queue.sent).toEqual([]);
  });
});

describe("runTriageBatch: R3 deferral for outgoing mail", () => {
  const outgoing = (id: string, date: string, to = "Maya <maya@quarry.example>") =>
    mail(id, { labels: ["SENT"], from: "Owner <owner@example.com>", to: [to], date });
  const confirmation = (id: string, date: string) =>
    mail(id, { from: "Quarry AI <no-reply@ashbyhq.com>", date });

  it("waits while an older message has not settled, never reaches the LLM, and is decided later", async () => {
    const { ctx, llm } = await setup([
      confirmation("confirm", "2026-10-05T10:00:00.000Z"),
      outgoing("out", "2026-10-06T10:00:00.000Z"),
    ]);

    // The confirmation is job-related (R4) but not applied; the follow-up is not known yet.
    expect(await runTriageBatch(ctx)).toMatchObject({ processed: 1 });
    expect(llm.calls).toEqual([]);
    // Still discovered, but with its real date, so it no longer holds the apply watermark at the
    // epoch: the older message can be applied. No attempt is counted, no content is stored.
    const waiting = await row("out");
    expect(waiting).toMatchObject({
      state: "discovered",
      attempts: 0,
      lastError: null,
      direction: "outbound",
      internalDate: new Date("2026-10-06T10:00:00.000Z"),
    });
    expect(contentOf(waiting)).toEqual(NO_CONTENT);

    // The older message is applied and the company's domain is learned.
    await prisma.company.create({
      data: {
        name: "Quarry AI",
        normalizedName: "quarry ai",
        domains: ["quarry.example"],
        createdSource: "gmail",
      },
    });
    await prisma.gmailMessage.update({ where: { id: "confirm" }, data: { state: "applied" } });

    expect(await runTriageBatch(ctx)).toMatchObject({ processed: 1 });
    expect(llm.calls).toEqual([]);
    expect(await row("out")).toMatchObject({
      state: "job_related",
      triageRule: "R3",
      triageMethod: "rule",
      attempts: 0,
    });
  });

  it("is triaged out, with no content, once every older message has settled", async () => {
    const { ctx, llm } = await setup([
      mail("old", { labels: ["SPAM"], date: "2026-10-05T10:00:00.000Z" }),
      outgoing("out", "2026-10-06T10:00:00.000Z", "Stranger <someone@unknown.example>"),
    ]);
    expect(await runTriageBatch(ctx)).toMatchObject({ processed: 2 });
    expect(llm.calls).toEqual([]);
    const stored = await row("out");
    expect(stored).toMatchObject({ state: "triaged_out", triageRule: "R3", direction: "outbound" });
    expect(contentOf(stored)).toEqual(NO_CONTENT);
  });

  it("does not wait for a message that waits for the owner", async () => {
    const { ctx } = await setup([
      confirmation("review", "2026-10-05T10:00:00.000Z"),
      outgoing("out", "2026-10-06T10:00:00.000Z", "Stranger <someone@unknown.example>"),
    ]);
    await runTriageBatch(ctx);
    // "review" is only job_related (unsettled), so the follow-up waits. Once that message waits for
    // the owner (needs_review), the pipeline cannot hurry it, so the follow-up is decided.
    expect((await row("out")).state).toBe("discovered");
    await prisma.gmailMessage.update({ where: { id: "review" }, data: { state: "needs_review" } });
    await runTriageBatch(ctx);
    expect((await row("out")).state).toBe("triaged_out");
  });

  it("waits while a message has not been read from Gmail yet", async () => {
    // 26 messages: the batch of 25 is the first 25 by discovery order; the 26th keeps its
    // placeholder date and could be older than the follow-up.
    const spam = Array.from({ length: 25 }, (_, i) =>
      mail(`s${String(i).padStart(2, "0")}`, { labels: ["SPAM"] }),
    );
    const fixtures = [
      outgoing("a-out", "2026-10-06T10:00:00.000Z", "Stranger <someone@unknown.example>"),
      ...spam.slice(0, 24),
      mail("z-last", { labels: ["SPAM"], date: "2026-10-01T10:00:00.000Z" }),
    ];
    const reads = new Map<string, number>();
    const real = new FakeGmailClient(fixtures);
    const gmail: GmailClient = {
      getProfile: () => real.getProfile(),
      listMessages: (q, t) => real.listMessages(q, t),
      listHistory: (s, t) => real.listHistory(s, t),
      getFull: (id) => real.getFull(id),
      getMetadata: (id) => {
        reads.set(id, (reads.get(id) ?? 0) + 1);
        return real.getMetadata(id);
      },
    };
    const { ctx, llm } = await setup(fixtures, gmail);
    expect(await runTriageBatch(ctx)).toMatchObject({
      processed: 24,
      read: 25,
      unread: 1,
      waiting: 1,
    });
    expect((await row("a-out")).state).toBe("discovered");
    expect(llm.calls).toEqual([]);

    // The 26th message is read; the waiting one is not read again while that message is unread.
    expect(await runTriageBatch(ctx)).toMatchObject({
      processed: 1,
      read: 1,
      unread: 0,
      waiting: 1,
    });
    expect(reads.get("a-out")).toBe(1);
    expect((await row("a-out")).state).toBe("discovered");

    // Nothing older is unsettled now: it is read once more and decided.
    expect(await runTriageBatch(ctx)).toMatchObject({
      processed: 1,
      read: 0,
      released: 1,
      waiting: 0,
    });
    expect(reads.get("a-out")).toBe(2);
    expect(await row("a-out")).toMatchObject({ state: "triaged_out", triageRule: "R3" });
  });

  it("does not read a waiting message again while an older one is unsettled, and reports nothing to do", async () => {
    const reads = new Map<string, number>();
    const fixtures = [
      confirmation("a-confirm", "2026-10-05T10:00:00.000Z"),
      outgoing("b-out", "2026-10-06T10:00:00.000Z"),
    ];
    const real = new FakeGmailClient(fixtures);
    const gmail: GmailClient = {
      getProfile: () => real.getProfile(),
      listMessages: (q, t) => real.listMessages(q, t),
      listHistory: (s, t) => real.listHistory(s, t),
      getFull: (id) => real.getFull(id),
      getMetadata: (id) => {
        reads.set(id, (reads.get(id) ?? 0) + 1);
        return real.getMetadata(id);
      },
    };
    const { ctx } = await setup(fixtures, gmail);
    await runTriageBatch(ctx);
    for (let i = 0; i < 3; i += 1) {
      expect(await runTriageBatch(ctx)).toEqual({
        processed: 0,
        read: 0,
        released: 0,
        unread: 0,
        waiting: 0,
      });
    }
    expect(reads.get("b-out")).toBe(1);
  });

  it("does not wait for a message Gmail no longer has (skipped, still on the placeholder date)", async () => {
    const ghost = mail("a-ghost", { date: "2026-10-05T10:00:00.000Z" });
    const out = outgoing("b-out", "2026-10-06T10:00:00.000Z", "Stranger <someone@unknown.example>");
    const { ctx } = await setup([ghost, out], new FakeGmailClient([out]));
    await runTriageBatch(ctx);
    expect(await row("a-ghost")).toMatchObject({
      state: "skipped",
      internalDate: new Date(0),
    });
    expect(await row("b-out")).toMatchObject({ state: "triaged_out", triageRule: "R3" });
  });

  it("does not wait for a message that failed with unknown metadata (failed, placeholder date)", async () => {
    const bad = mail("a-bad", { date: "2026-10-05T10:00:00.000Z" });
    const out = outgoing("b-out", "2026-10-06T10:00:00.000Z", "Stranger <someone@unknown.example>");
    const real = new FakeGmailClient([bad, out]);
    const gmail: GmailClient = {
      getProfile: () => real.getProfile(),
      listMessages: (q, t) => real.listMessages(q, t),
      listHistory: (s, t) => real.listHistory(s, t),
      getFull: (id) => real.getFull(id),
      getMetadata: (id) =>
        id === "a-bad" ? Promise.reject(new GmailRequestError(400)) : real.getMetadata(id),
    };
    const { ctx } = await setup([bad, out], gmail);
    // Its fifth failed attempt: the message is failed for good, and never read.
    await prisma.gmailMessage.update({ where: { id: "a-bad" }, data: { attempts: 4 } });
    await runTriageBatch(ctx);
    expect(await row("a-bad")).toMatchObject({ state: "failed", internalDate: new Date(0) });
    expect(await row("b-out")).toMatchObject({ state: "triaged_out", triageRule: "R3" });
  });

  it("still waits for a message that failed an attempt but may yet be read", async () => {
    const bad = mail("a-bad", { date: "2026-10-05T10:00:00.000Z" });
    const out = outgoing("b-out", "2026-10-06T10:00:00.000Z", "Stranger <someone@unknown.example>");
    const real = new FakeGmailClient([bad, out]);
    const gmail: GmailClient = {
      getProfile: () => real.getProfile(),
      listMessages: (q, t) => real.listMessages(q, t),
      listHistory: (s, t) => real.listHistory(s, t),
      getFull: (id) => real.getFull(id),
      getMetadata: (id) =>
        id === "a-bad" ? Promise.reject(new GmailRequestError(400)) : real.getMetadata(id),
    };
    const { ctx } = await setup([bad, out], gmail);
    await runTriageBatch(ctx);
    expect((await row("a-bad")).state).toBe("discovered");
    expect((await row("b-out")).state).toBe("discovered");
  });

  it("decides several waiting messages oldest first in one pass", async () => {
    const { ctx } = await setup([
      outgoing("b-out", "2026-10-07T10:00:00.000Z", "Stranger <someone@unknown.example>"),
      outgoing("a-out", "2026-10-06T10:00:00.000Z", "Stranger <someone@unknown.example>"),
    ]);
    expect(await runTriageBatch(ctx)).toMatchObject({ processed: 2 });
    expect((await row("a-out")).state).toBe("triaged_out");
    expect((await row("b-out")).state).toBe("triaged_out");
  });
});

describe("runTriageBatch: batches and failures", () => {
  it("takes up to 25 discovered messages, oldest first, and leaves the rest", async () => {
    const fixtures = Array.from({ length: 30 }, (_, i) =>
      mail(`m${String(i).padStart(2, "0")}`, { labels: ["SPAM"] }),
    );
    // Discovered in reverse id order, so "oldest" is not the same as "lowest id".
    const ids = fixtures.map((f) => f.id);
    await discover(
      ids,
      (id) => `thr-${id}`,
      (index) => new Date(Date.UTC(2026, 9, 1, 0, 0, 30 - index)),
    );
    const ctx = testWorkerCtx({
      gmail: fakeGmailFactory(new FakeGmailClient(fixtures)),
      llm: FakeLlmProvider.fromFixtures({ emails: fixtures, leadBatches: [] }),
    });

    expect(await runTriageBatch(ctx)).toMatchObject({ processed: 25 });
    const left = await prisma.gmailMessage.findMany({
      where: { state: "discovered" },
      orderBy: { id: "asc" },
    });
    // The five discovered last (m00..m04) are the ones left.
    expect(left.map((m) => m.id)).toEqual(["m00", "m01", "m02", "m03", "m04"]);
    expect(await runTriageBatch(ctx)).toMatchObject({ processed: 5 });
    expect(await runTriageBatch(ctx)).toMatchObject({ processed: 0 });
  });

  it("an LLM failure leaves the batch discovered with attempts + 1; the fifth failure marks failed and opens extraction_failed", async () => {
    const fixtures = [
      mail("undecided", { triage: verdict("undecided", true, 0.9) }),
      mail("ruled", { from: "Hiring <no-reply@greenhouse-mail.io>" }),
    ];
    const { ctx, llm } = await setup(fixtures);
    llm.failNext("triage", new LlmError("upstream", "boom", { retryable: true }));

    // The message a rule decides is not held back by the LLM failure.
    expect(await runTriageBatch(ctx)).toMatchObject({ processed: 1 });
    expect((await row("ruled")).state).toBe("job_related");
    expect(await row("undecided")).toMatchObject({
      state: "discovered",
      attempts: 1,
      lastError: "llm_upstream",
      subject: null,
      fromEmail: null,
    });
    // Still a placeholder: it keeps holding the apply watermark.
    expect((await row("undecided")).internalDate.getTime()).toBe(0);
    expect(await prisma.reviewItem.count()).toBe(0);

    // The next sweeps retry it; four more failures in all.
    for (const expected of [2, 3, 4]) {
      llm.failNext("triage", new LlmError("timeout", "slow", { retryable: true }));
      await runTriageBatch(ctx);
      expect((await row("undecided")).attempts).toBe(expected);
      expect((await row("undecided")).state).toBe("discovered");
    }
    llm.failNext("triage", new LlmError("upstream", "boom", { retryable: true }));
    await runTriageBatch(ctx);
    expect(await row("undecided")).toMatchObject({
      state: "failed",
      attempts: 5,
      lastError: "llm_upstream",
    });
    expect(contentOf(await row("undecided"))).toEqual(NO_CONTENT);
    expect(await prisma.reviewItem.findMany()).toMatchObject([
      { kind: "extraction_failed", state: "open", messageId: "undecided" },
    ]);
  });

  it("a bad request (400) fails the message at once, with a review item (§13)", async () => {
    const fixtures = [
      mail("bad", { triage: verdict("bad", true, 0.9) }),
      mail("ruled", { from: "Hiring <no-reply@greenhouse-mail.io>" }),
    ];
    const { ctx, llm } = await setup(fixtures);
    llm.failNext("triage", new LlmError("bad_request", "rejected (400)", { retryable: false }));
    expect(await runTriageBatch(ctx)).toMatchObject({ processed: 2 });
    expect(await row("bad")).toMatchObject({
      state: "failed",
      attempts: 1,
      lastError: "llm_bad_request",
    });
    expect(contentOf(await row("bad"))).toEqual(NO_CONTENT);
    expect(await prisma.reviewItem.findMany()).toMatchObject([
      { kind: "extraction_failed", state: "open", messageId: "bad" },
    ]);
    expect((await row("ruled")).state).toBe("job_related");
  });

  it("invalid or incomplete output counts one ordinary attempt and leaves the message discovered", async () => {
    const { ctx, llm } = await setup([mail("a", { triage: verdict("a", true, 0.9) })]);
    llm.failNext("triage", new LlmError("invalid_output", "bad json", { retryable: false }));
    await runTriageBatch(ctx);
    expect(await row("a")).toMatchObject({
      state: "discovered",
      attempts: 1,
      lastError: "llm_invalid_output",
    });
    llm.failNext("triage", new LlmError("incomplete", "cut off", { retryable: false }));
    await runTriageBatch(ctx);
    expect(await row("a")).toMatchObject({
      state: "discovered",
      attempts: 2,
      lastError: "llm_incomplete",
    });
    expect(await prisma.reviewItem.count()).toBe(0);
    // The fifth attempt still fails it, like any other error.
    await prisma.gmailMessage.update({ where: { id: "a" }, data: { attempts: 4 } });
    llm.failNext("triage", new LlmError("incomplete", "cut off", { retryable: false }));
    await runTriageBatch(ctx);
    expect(await row("a")).toMatchObject({ state: "failed", attempts: 5 });
  });

  it("a retryable error (429, 5xx, timeout) never fails a message before the fifth attempt", async () => {
    const { ctx, llm } = await setup([mail("a", { triage: verdict("a", true, 0.9) })]);
    for (const code of ["rate_limited", "upstream", "timeout"] as const) {
      llm.failNext("triage", new LlmError(code, "retry me", { retryable: true }));
      await runTriageBatch(ctx);
    }
    expect(await row("a")).toMatchObject({ state: "discovered", attempts: 3 });
    expect(await prisma.reviewItem.count()).toBe(0);
  });

  it("counts an attempt on top of the stored value, not on top of what the batch read", async () => {
    const fixtures = [mail("a", { triage: verdict("a", true, 0.9) })];
    await discover(["a"]);
    const real = new FakeGmailClient(fixtures);
    const gmail: GmailClient = {
      getProfile: () => real.getProfile(),
      listMessages: (q, t) => real.listMessages(q, t),
      listHistory: (s, t) => real.listHistory(s, t),
      getFull: (id) => real.getFull(id),
      getMetadata: async (id) => {
        const meta = await real.getMetadata(id);
        // Another sweep failed this message twice while this batch was in flight.
        await prisma.gmailMessage.update({ where: { id }, data: { attempts: 2 } });
        return meta;
      },
    };
    const llm = FakeLlmProvider.fromFixtures({ emails: fixtures, leadBatches: [] });
    llm.failNext("triage", new LlmError("upstream", "boom", { retryable: true }));
    const ctx = testWorkerCtx({ gmail: fakeGmailFactory(gmail), llm });
    await runTriageBatch(ctx);
    expect(await row("a")).toMatchObject({ state: "discovered", attempts: 3 });
  });

  it("a successful retry after a failure decides the message", async () => {
    const { ctx, llm } = await setup([mail("a", { triage: verdict("a", true, 0.9) })]);
    llm.failNext("triage", new LlmError("rate_limited", "slow down", { retryable: true }));
    await runTriageBatch(ctx);
    expect((await row("a")).attempts).toBe(1);
    expect(await runTriageBatch(ctx)).toMatchObject({ processed: 1 });
    expect((await row("a")).state).toBe("job_related");
  });

  it("a message Gmail no longer has is skipped for good, with no content", async () => {
    const present = mail("here", { from: "Hiring <no-reply@greenhouse-mail.io>" });
    const { ctx } = await setup([present, mail("gone")], new FakeGmailClient([present]));
    expect(await runTriageBatch(ctx)).toMatchObject({ processed: 2 });
    expect(await row("gone")).toMatchObject({
      state: "skipped",
      triageRule: null,
      triageMethod: null,
      lastError: "gmail_message_not_found",
    });
    expect(contentOf(await row("gone"))).toEqual(NO_CONTENT);
    expect((await row("here")).state).toBe("job_related");
    expect(await runTriageBatch(ctx)).toMatchObject({ processed: 0 });
  });

  it("a message Gmail refuses counts an attempt; the fifth marks it failed", async () => {
    const fixtures = [mail("bad"), mail("ok", { from: "H <no-reply@greenhouse-mail.io>" })];
    const real = new FakeGmailClient(fixtures);
    const gmail: GmailClient = {
      getProfile: () => real.getProfile(),
      listMessages: (q, t) => real.listMessages(q, t),
      listHistory: (s, t) => real.listHistory(s, t),
      getFull: (id) => real.getFull(id),
      getMetadata: (id) =>
        id === "bad" ? Promise.reject(new GmailRequestError(400)) : real.getMetadata(id),
    };
    const { ctx } = await setup(fixtures, gmail);
    await runTriageBatch(ctx);
    expect((await row("ok")).state).toBe("job_related");
    expect(await row("bad")).toMatchObject({
      state: "discovered",
      attempts: 1,
      lastError: "gmail_request_failed",
    });
    await prisma.gmailMessage.update({ where: { id: "bad" }, data: { attempts: 4 } });
    await runTriageBatch(ctx);
    expect(await row("bad")).toMatchObject({ state: "failed", attempts: 5 });
    expect(await prisma.reviewItem.count({ where: { kind: "extraction_failed" } })).toBe(1);
  });

  it("a retryable Gmail error keeps the work done so far, counts no attempt and is rethrown", async () => {
    const fixtures = [
      mail("a", { from: "H <no-reply@greenhouse-mail.io>" }),
      mail("b", { from: "H <no-reply@greenhouse-mail.io>" }),
    ];
    const real = new FakeGmailClient(fixtures);
    const error = new GmailRetryableError(429, 60_000);
    const gmail: GmailClient = {
      getProfile: () => real.getProfile(),
      listMessages: (q, t) => real.listMessages(q, t),
      listHistory: (s, t) => real.listHistory(s, t),
      getFull: (id) => real.getFull(id),
      getMetadata: (id) => (id === "b" ? Promise.reject(error) : real.getMetadata(id)),
    };
    const { ctx } = await setup(fixtures, gmail);
    ctx.queue.sent.length = 0;
    await expect(runTriageBatch(ctx)).rejects.toBe(error);
    expect((await row("a")).state).toBe("job_related");
    expect(await row("b")).toMatchObject({ state: "discovered", attempts: 0, lastError: null });
    // The decided message's extraction is still sent.
    expect(ctx.queue.sentNames).toEqual(["email.extract"]);
  });

  it("lost authorization is rethrown and changes no message", async () => {
    const fixtures = [mail("a")];
    const error = new GmailAuthError("invalid_grant");
    const { ctx } = await setup(fixtures);
    const failing = { ...ctx, gmail: () => Promise.reject(error) };
    await expect(runTriageBatch(failing)).rejects.toBe(error);
    expect(await row("a")).toMatchObject({ state: "discovered", attempts: 0 });
  });

  it("an unexpected Gmail error is rethrown without counting an attempt", async () => {
    const { ctx } = await setup([mail("a")]);
    const failing = { ...ctx, gmail: () => Promise.reject(new TypeError("network")) };
    await expect(runTriageBatch(failing)).rejects.toBeInstanceOf(TypeError);
    expect(await row("a")).toMatchObject({ state: "discovered", attempts: 0 });
  });

  it("does nothing, and fetches nothing, when no message is discovered", async () => {
    let fetches = 0;
    const ctx = testWorkerCtx({
      gmail: () => {
        fetches += 1;
        return Promise.reject(new Error("must not be called"));
      },
    });
    expect(await runTriageBatch(ctx)).toMatchObject({ processed: 0 });
    expect(fetches).toBe(0);
  });

  it("does not touch a message that left discovered while the batch was running", async () => {
    const fixtures = [mail("a", { labels: ["SPAM"] })];
    await discover(["a"]);
    const real = new FakeGmailClient(fixtures);
    const gmail: GmailClient = {
      getProfile: () => real.getProfile(),
      listMessages: (q, t) => real.listMessages(q, t),
      listHistory: (s, t) => real.listHistory(s, t),
      getFull: (id) => real.getFull(id),
      getMetadata: async (id) => {
        const meta = await real.getMetadata(id);
        // Another run decided it in the meantime.
        await prisma.gmailMessage.update({ where: { id }, data: { state: "failed" } });
        return meta;
      },
    };
    const ctx = testWorkerCtx({
      gmail: fakeGmailFactory(gmail),
      llm: FakeLlmProvider.fromFixtures({ emails: fixtures, leadBatches: [] }),
    });
    expect(await runTriageBatch(ctx)).toMatchObject({ processed: 0 });
    expect((await row("a")).state).toBe("failed");
  });
});

describe("runTriageBatch: logging", () => {
  /** A context whose logger keeps every line, at the most verbose level. */
  function loggedCtx(base: ReturnType<typeof testWorkerCtx>) {
    const lines: string[] = [];
    const log = pino({ level: "trace" }, { write: (line: string) => void lines.push(line) });
    return { ctx: { ...base, log }, lines };
  }

  const SECRETS = [
    "Quarterly secret subject",
    "stranger.person@unknown.example",
    "Stranger Person",
    "confidential preview words",
  ];

  const secretMail = () =>
    mail("secret", {
      from: `Stranger Person <${SECRETS[1]}>`,
      subject: SECRETS[0] as string,
      snippet: `${SECRETS[3]} and more`,
      triage: verdict("secret", true, 0.9),
    });

  it("logs no subject, address or preview when the LLM fails", async () => {
    const { ctx: base, llm } = await setup([secretMail()]);
    const { ctx, lines } = loggedCtx(base);
    llm.failNext(
      "triage",
      new LlmError("upstream", `failed for ${SECRETS.join(" / ")}`, { retryable: true }),
    );
    await runTriageBatch(ctx);
    expect(lines.length).toBeGreaterThan(0);
    const logged = lines.join("\n");
    for (const secret of SECRETS) expect(logged).not.toContain(secret);
    expect(logged).not.toContain("owner@example.com");
  });

  it("logs no subject, address or preview when Gmail refuses the message", async () => {
    const fixture = secretMail();
    const real = new FakeGmailClient([fixture]);
    const gmail: GmailClient = {
      getProfile: () => real.getProfile(),
      listMessages: (q, t) => real.listMessages(q, t),
      listHistory: (s, t) => real.listHistory(s, t),
      getFull: (id) => real.getFull(id),
      getMetadata: () => Promise.reject(new GmailRequestError(400)),
    };
    const { ctx: base } = await setup([fixture], gmail);
    const { ctx, lines } = loggedCtx(base);
    await runTriageBatch(ctx);
    const logged = lines.join("\n");
    for (const secret of SECRETS) expect(logged).not.toContain(secret);
  });

  it("logs no subject, address or preview when the message is triaged", async () => {
    const { ctx: base } = await setup([secretMail()]);
    const { ctx, lines } = loggedCtx(base);
    await runTriageBatch(ctx);
    expect((await row("secret")).state).toBe("job_related");
    const logged = lines.join("\n");
    for (const secret of SECRETS) expect(logged).not.toContain(secret);
  });
});

describe("resendPendingExtractions", () => {
  const NOW = new Date("2026-10-01T12:00:00.000Z"); // the test context's clock
  const waited = new Date(NOW.getTime() - EXTRACT_RESEND_AFTER_MS - 1_000);

  async function jobRelated(id: string, over: Record<string, unknown> = {}): Promise<void> {
    await prisma.gmailMessage.create({
      data: {
        id,
        threadId: `thr-${id}`,
        internalDate: new Date("2026-10-05T10:00:00.000Z"),
        direction: "inbound",
        labelIds: ["INBOX"],
        state: "job_related",
        processedAt: waited,
        ...over,
      },
    });
  }
  const sentIds = (ctx: ReturnType<typeof testWorkerCtx>) =>
    ctx.queue.sent.map((s) => s.data.messageId);

  it("sends a message that has waited, keyed by id, and counts the resend", async () => {
    await jobRelated("a");
    const ctx = testWorkerCtx();
    expect(await resendPendingExtractions(ctx)).toBe(1);
    expect(ctx.queue.sent).toEqual([
      { name: "email.extract", data: { messageId: "a" }, opts: { singletonKey: "a" } },
    ]);
    expect(await row("a")).toMatchObject({ attempts: 1, processedAt: NOW });
    // Its wait starts again: the next sweep leaves it alone.
    expect(await resendPendingExtractions(ctx)).toBe(0);
  });

  it("leaves alone a message whose job is probably still running or backing off", async () => {
    await jobRelated("fresh", { processedAt: new Date(NOW.getTime() - 60_000) });
    await jobRelated("old");
    const ctx = testWorkerCtx();
    await resendPendingExtractions(ctx);
    expect(sentIds(ctx)).toEqual(["old"]);
    expect((await row("fresh")).attempts).toBe(0);
  });

  it("fails a message that keeps coming back, with a review item, instead of sending it again", async () => {
    await jobRelated("poison", { attempts: MAX_EXTRACT_RESENDS });
    await jobRelated("ok", { attempts: MAX_EXTRACT_RESENDS - 1 });
    const ctx = testWorkerCtx();
    await resendPendingExtractions(ctx);
    expect(sentIds(ctx)).toEqual(["ok"]);
    expect(await row("poison")).toMatchObject({
      state: "failed",
      lastError: "extract_resend_limit",
    });
    expect(await prisma.reviewItem.findMany()).toMatchObject([
      { kind: "extraction_failed", messageId: "poison" },
    ]);
  });

  it("a send that fails does not use up a resend", async () => {
    await jobRelated("a", { attempts: 2 });
    const ctx = testWorkerCtx();
    ctx.queue.failSendWith = new Error("queue down");
    await expect(resendPendingExtractions(ctx)).rejects.toThrow("queue down");
    expect(await row("a")).toMatchObject({ attempts: 2, processedAt: waited });
    ctx.queue.failSendWith = null;
    expect(await resendPendingExtractions(ctx)).toBe(1);
    expect((await row("a")).attempts).toBe(3);
  });

  it("a failure while giving the resend back does not hide the send error", async () => {
    await jobRelated("a", { attempts: 2 });
    const ctx = testWorkerCtx();
    ctx.queue.failSendWith = new Error("queue down");
    // The database refuses the restoring write, as it might when the connection drops.
    const gmailMessage = new Proxy(prisma.gmailMessage, {
      get(target, property, receiver) {
        if (property !== "updateMany") return Reflect.get(target, property, receiver) as unknown;
        return (args: Parameters<typeof target.updateMany>[0]) => {
          const attempts = (args.data as { attempts?: unknown }).attempts;
          if (typeof attempts === "object" && attempts !== null && "decrement" in attempts) {
            return Promise.reject(new Error("connection lost"));
          }
          return target.updateMany(args);
        };
      },
    });
    const broken = {
      ...ctx,
      prisma: new Proxy(prisma, {
        get: (t, p, r) => (p === "gmailMessage" ? gmailMessage : (Reflect.get(t, p, r) as unknown)),
      }),
    };
    await expect(resendPendingExtractions(broken)).rejects.toThrow("queue down");
  });

  it("sends nothing while the Gmail authorization is lost", async () => {
    await seedConnection(prisma, { status: "needs_reauth" });
    await jobRelated("a");
    const ctx = testWorkerCtx();
    expect(await resendPendingExtractions(ctx)).toBe(0);
    expect(ctx.queue.sent).toEqual([]);
    expect((await row("a")).attempts).toBe(0);
  });

  it("a message triage decides starts with no resends counted, whatever triage attempts it took", async () => {
    const { ctx, llm } = await setup([mail("a", { triage: verdict("a", true, 0.9) })]);
    llm.failNext("triage", new LlmError("upstream", "boom", { retryable: true }));
    await runTriageBatch(ctx);
    expect((await row("a")).attempts).toBe(1);
    await runTriageBatch(ctx);
    expect(await row("a")).toMatchObject({ state: "job_related", attempts: 0 });
  });
});
