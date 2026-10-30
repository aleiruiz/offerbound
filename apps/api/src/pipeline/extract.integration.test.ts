import type { EmailFixture, Extraction } from "@offerbound/contracts";
import pino from "pino";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDb, testPrisma } from "../../test/db.js";
import { emailFixture } from "../../test/gmail.js";
import { testWorkerCtx } from "../../test/worker.js";
import {
  GmailAuthError,
  GmailMessageNotFoundError,
  GmailRequestError,
  GmailRetryableError,
  type GmailClient,
} from "../gmail/client.js";
import { FakeGmailClient, fakeGmailFactory } from "../gmail/fake-client.js";
import { FakeLlmProvider } from "../llm/fake-provider.js";
import { LlmError } from "../llm/provider.js";
import { markExtractionFailed, runExtract } from "./extract.js";

const prisma = testPrisma();

beforeEach(async () => {
  await resetDb(prisma);
});

const BASE: Extraction = {
  category: "interview_invite",
  confidence: 0.9,
  company: { name: "Quarry AI", websiteDomain: "quarry.example" },
  role: { title: "Platform Engineer", seniority: "senior" },
  jobUrl: null,
  contact: null,
  interview: {
    kind: "technical",
    startsAt: "2026-10-08T15:00:00-06:00",
    endsAt: "2026-10-08T16:00:00-06:00",
    timezone: "America/Monterrey",
    meetingUrl: null,
    schedulingUrl: null,
    location: null,
    interviewers: [],
  },
  assessment: null,
  leads: [],
  summary: "Technical interview on 8 October",
  language: "en",
};
const extraction = (over: Partial<Extraction> = {}): Extraction => ({ ...BASE, ...over });

const ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "METHOD:REQUEST",
  "BEGIN:VEVENT",
  "UID:invite-1@quarry.example",
  "DTSTART:20261008T210000Z",
  "DTEND:20261008T220000Z",
  "SUMMARY:Technical interview",
  "LOCATION:https://meet.quarry.example/room",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

function mail(id: string, over: Partial<EmailFixture> = {}): EmailFixture {
  return emailFixture(id, "2026-10-05T10:00:00.000Z", {
    headers: {
      from: "Priya Ramanathan <priya@quarry.example>",
      to: ["owner@example.com"],
      subject: "Interview with Quarry AI",
      date: "Mon, 05 Oct 2026 10:00:00 +0000",
    },
    ...over,
  });
}

/** The row triage leaves for a job-related message: headers and snippet, no body. */
async function jobRelated(f: EmailFixture, over: Record<string, unknown> = {}): Promise<void> {
  await prisma.gmailMessage.create({
    data: {
      id: f.id,
      threadId: f.threadId,
      internalDate: new Date(f.internalDate),
      direction: f.labels.includes("SENT") ? "outbound" : "inbound",
      labelIds: f.labels,
      state: "job_related",
      triageMethod: "rule",
      triageRule: "R4",
      fromEmail: "priya@quarry.example",
      fromName: "Priya Ramanathan",
      toEmails: ["owner@example.com"],
      subject: f.headers.subject,
      snippet: f.snippet,
      ...over,
    },
  });
}

async function setup(f: EmailFixture, gmail?: GmailClient, state?: Record<string, unknown>) {
  await jobRelated(f, state);
  const llm = FakeLlmProvider.fromFixtures({ emails: [], leadBatches: [] });
  const ctx = testWorkerCtx({
    gmail: fakeGmailFactory(gmail ?? new FakeGmailClient([f])),
    llm,
  });
  return { ctx, llm };
}

const row = (id: string) => prisma.gmailMessage.findUniqueOrThrow({ where: { id } });

const recordCounts = async () => ({
  applications: await prisma.application.count(),
  companies: await prisma.company.count(),
  leads: await prisma.lead.count(),
  interviews: await prisma.interview.count(),
  events: await prisma.event.count(),
  contacts: await prisma.contact.count(),
  threadLinks: await prisma.threadLink.count(),
});
const NO_RECORDS = {
  applications: 0,
  companies: 0,
  leads: 0,
  interviews: 0,
  events: 0,
  contacts: 0,
  threadLinks: 0,
};

/** A Gmail client whose full fetch is replaced. */
function withFull(real: FakeGmailClient, getFull: GmailClient["getFull"]): GmailClient {
  return {
    getProfile: () => real.getProfile(),
    listMessages: (q, t) => real.listMessages(q, t),
    listHistory: (s, t) => real.listHistory(s, t),
    getMetadata: (id) => real.getMetadata(id),
    getFull,
  };
}

const invalid = (message = "Output failed validation: category") =>
  new LlmError("invalid_output", message, { retryable: false });

describe("runExtract", () => {
  it("stores the de-quoted body (≤ 15,000 chars), the parsed ics events, the clamped extraction, category, confidence and summary; state extracted; sends email.apply", async () => {
    const fresh = "We would like to invite you to a technical interview. ";
    const body = `${fresh.repeat(400)}\n\nOn Mon, 5 Oct 2026, Owner <owner@example.com> wrote:\n> quoted history\n> more quoted`;
    const f = mail("m1", { bodyText: body, ics: ICS });
    const { ctx, llm } = await setup(f);
    llm.register(
      "extract",
      { messageId: "m1" },
      extraction({ summary: "s".repeat(300), confidence: 1.7 }),
    );

    await runExtract(ctx, "m1");

    const stored = await row("m1");
    expect(stored.state).toBe("extracted");
    expect(stored.bodyText?.length).toBeLessThanOrEqual(15_000);
    expect(stored.bodyText?.length).toBeGreaterThan(10_000);
    expect(stored.bodyText).not.toContain("quoted history");
    expect(stored.bodyText).not.toContain("wrote:");
    expect(stored.category).toBe("interview_invite");
    expect(stored.extractConfidence).toBe(1);
    expect(stored.summary).toBe("s".repeat(140));
    expect(stored.lastError).toBeNull();
    expect(stored.processedAt).not.toBeNull();
    expect(stored.extraction).toMatchObject({
      category: "interview_invite",
      confidence: 1,
      summary: "s".repeat(140),
      company: { name: "Quarry AI" },
    });
    expect(stored.icsEvents).toEqual([
      {
        uid: "invite-1@quarry.example",
        method: "REQUEST",
        start: "2026-10-08T21:00:00.000Z",
        end: "2026-10-08T22:00:00.000Z",
        timezone: null,
        summary: "Technical interview",
        location: "https://meet.quarry.example/room",
        url: null,
        descriptionLink: null,
        organizer: null,
      },
    ]);
    // Triage's columns are kept.
    expect(stored).toMatchObject({
      fromEmail: "priya@quarry.example",
      subject: "Interview with Quarry AI",
    });
    expect(ctx.queue.sent).toEqual([{ name: "email.apply", data: {}, opts: {} }]);
    await expect(prisma.application.count()).resolves.toBe(0);
  });

  it("gives the model the headers, date, owner time zone, direction, calendar events and capped body", async () => {
    const f = mail("m1", { bodyText: `${"x".repeat(20_000)}`, ics: ICS });
    const { ctx, llm } = await setup(f);
    llm.register("extract", { messageId: "m1" }, extraction());
    await runExtract(ctx, "m1");

    expect(llm.calls).toHaveLength(1);
    const input = llm.calls[0]?.input as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual([
      "body",
      "date",
      "direction",
      "headers",
      "icsEvents",
      "messageId",
      "ownerTimezone",
      "previousError",
    ]);
    expect(input).toMatchObject({
      messageId: "m1",
      date: "Mon, 05 Oct 2026 10:00:00 +0000",
      ownerTimezone: ctx.env.userTimezone,
      direction: "inbound",
      previousError: null,
      headers: { subject: "Interview with Quarry AI", fromEmail: "priya@quarry.example" },
    });
    expect((input.body as string).length).toBe(15_000);
    expect(input.icsEvents).toHaveLength(1);
    expect((await row("m1")).bodyText?.length).toBe(15_000);
  });

  it("de-quotes a Spanish reply and reads an html-only body", async () => {
    const f = mail("es", {
      bodyHtml: "<p>Hola,</p><p>Gracias por aplicar.</p><p>El lun, 5 oct 2026, Owner escribió:</p>",
    });
    delete f.bodyText; // html only
    const { ctx, llm } = await setup(f);
    await runExtract(ctx, "es");
    const stored = await row("es");
    expect(stored.bodyText).toContain("Gracias por aplicar.");
    expect(stored.bodyText).not.toContain("escribió");
    expect(llm.calls).toHaveLength(1);
  });

  it("keeps the model's times when the calendar start or end is unknown, and stores the event for its UID and METHOD", async () => {
    // A TZID nobody can resolve: the parser leaves start and end null (T2.2).
    const ics = ICS.replace(
      "DTSTART:20261008T210000Z",
      "DTSTART;TZID=Imaginary Standard Time:20261008T150000",
    ).replace("DTEND:20261008T220000Z", "DTEND;TZID=Imaginary Standard Time:20261008T160000");
    const f = mail("m1", { bodyText: "See the invite.", ics });
    const { ctx, llm } = await setup(f);
    llm.register("extract", { messageId: "m1" }, extraction());
    await runExtract(ctx, "m1");
    const stored = await row("m1");
    expect(stored.icsEvents).toMatchObject([
      { uid: "invite-1@quarry.example", method: "REQUEST", start: null, end: null },
    ]);
    expect(stored.extraction).toMatchObject({
      interview: { startsAt: "2026-10-08T15:00:00-06:00", endsAt: "2026-10-08T16:00:00-06:00" },
    });
  });

  it("an outbound message is extracted as outbound", async () => {
    const f = mail("out", { labels: ["SENT"], bodyText: "Following up on my application." });
    const { ctx, llm } = await setup(f);
    await runExtract(ctx, "out");
    expect((llm.calls[0]?.input as { direction: string }).direction).toBe("outbound");
  });
});

describe("runExtract: invalid output (AC-3.6)", () => {
  it("invalid output once, then valid → extracted, and the second call carries previousError", async () => {
    const f = mail("m1", { bodyText: "Hello" });
    const { ctx, llm } = await setup(f);
    llm.register("extract", { messageId: "m1" }, extraction());
    llm.failNext("extract", invalid("Output failed validation: category: expected one of"));

    await runExtract(ctx, "m1");

    expect((await row("m1")).state).toBe("extracted");
    expect(llm.calls).toHaveLength(2);
    expect((llm.calls[0]?.input as { previousError: unknown }).previousError).toBeNull();
    expect((llm.calls[1]?.input as { previousError: string }).previousError).toContain(
      "Output failed validation",
    );
    expect(ctx.queue.sentNames).toEqual(["email.apply"]);
  });

  it("invalid output twice → state failed, an extraction_failed review item, no records changed", async () => {
    const f = mail("m1", { bodyText: "Hello" });
    const { ctx, llm } = await setup(f);
    llm.failNext("extract", invalid());
    llm.failNext("extract", invalid());

    await runExtract(ctx, "m1");

    expect(llm.calls).toHaveLength(2);
    expect(await row("m1")).toMatchObject({
      state: "failed",
      lastError: "llm_invalid_output",
      extraction: null,
      category: null,
      bodyText: null,
      // What triage stored stays, so the review item can show the email and a retry can reuse it.
      subject: "Interview with Quarry AI",
      fromEmail: "priya@quarry.example",
    });
    expect(await prisma.reviewItem.findMany()).toMatchObject([
      { kind: "extraction_failed", state: "open", messageId: "m1" },
    ]);
    expect(await recordCounts()).toEqual(NO_RECORDS);
    expect(ctx.queue.sent).toEqual([]);
  });

  it("a request the model rejects (400) fails the message at once, with a review item", async () => {
    const f = mail("m1", { bodyText: "Hello" });
    const { ctx, llm } = await setup(f);
    llm.failNext("extract", new LlmError("bad_request", "rejected (400)", { retryable: false }));
    await runExtract(ctx, "m1");
    expect(llm.calls).toHaveLength(1);
    expect(await row("m1")).toMatchObject({ state: "failed", lastError: "llm_bad_request" });
    expect(await prisma.reviewItem.count({ where: { kind: "extraction_failed" } })).toBe(1);
  });
});

describe("runExtract: failures that are retried", () => {
  it("a retryable LLM error rethrows so pg-boss retries (4 retries, base 30 s)", async () => {
    const f = mail("m1", { bodyText: "Hello" });
    const { ctx, llm } = await setup(f);
    for (const code of ["rate_limited", "upstream", "timeout"] as const) {
      const error = new LlmError(code, "try later", { retryable: true });
      llm.failNext("extract", error);
      await expect(runExtract(ctx, "m1")).rejects.toBe(error);
    }
    // Still waiting for its retry: not failed, no review item, nothing sent.
    expect(await row("m1")).toMatchObject({ state: "job_related", extraction: null });
    expect(await prisma.reviewItem.count()).toBe(0);
    expect(ctx.queue.sent).toEqual([]);

    // The queue's retry settings are the spec's (§8.3, §9).
    const { QUEUE_CONFIG } = await import("../jobs/queues.js");
    expect(QUEUE_CONFIG["email.extract"]).toMatchObject({ retryLimit: 4, retryDelay: 30 });
  });

  it("an incomplete answer is rethrown so pg-boss retries it; only a 400 fails at once", async () => {
    const f = mail("m1", { bodyText: "Hello" });
    const { ctx, llm } = await setup(f);
    const error = new LlmError("incomplete", "cut off", { retryable: false });
    llm.failNext("extract", error);
    await expect(runExtract(ctx, "m1")).rejects.toBe(error);
    expect(await row("m1")).toMatchObject({ state: "job_related", lastError: null });
    expect(await prisma.reviewItem.count()).toBe(0);
  });

  it("a retryable Gmail error is rethrown and changes nothing", async () => {
    const f = mail("m1", { bodyText: "Hello" });
    const error = new GmailRetryableError(429, 30_000);
    const gmail = withFull(new FakeGmailClient([f]), () => Promise.reject(error));
    const { ctx, llm } = await setup(f, gmail);
    await expect(runExtract(ctx, "m1")).rejects.toBe(error);
    expect((await row("m1")).state).toBe("job_related");
    expect(llm.calls).toEqual([]);
  });

  it("lost authorization is rethrown and changes nothing", async () => {
    const f = mail("m1", { bodyText: "Hello" });
    const { ctx } = await setup(f);
    const error = new GmailAuthError("invalid_grant");
    await expect(runExtract({ ...ctx, gmail: () => Promise.reject(error) }, "m1")).rejects.toBe(
      error,
    );
    expect((await row("m1")).state).toBe("job_related");
  });

  it("a message Gmail no longer has is skipped for good, with no content", async () => {
    const f = mail("m1", { bodyText: "Hello" });
    const gmail = withFull(new FakeGmailClient([f]), () =>
      Promise.reject(new GmailMessageNotFoundError()),
    );
    const { ctx, llm } = await setup(f, gmail);
    await runExtract(ctx, "m1");
    expect(await row("m1")).toMatchObject({
      state: "skipped",
      lastError: "gmail_message_not_found",
      fromEmail: null,
      subject: null,
      snippet: null,
      toEmails: [],
      bodyText: null,
    });
    expect(llm.calls).toEqual([]);
    expect(await prisma.reviewItem.count()).toBe(0);
  });

  it("a request Gmail refuses fails the message at once", async () => {
    const f = mail("m1", { bodyText: "Hello" });
    const gmail = withFull(new FakeGmailClient([f]), () =>
      Promise.reject(new GmailRequestError(400)),
    );
    const { ctx } = await setup(f, gmail);
    await runExtract(ctx, "m1");
    expect(await row("m1")).toMatchObject({ state: "failed", lastError: "gmail_request_failed" });
    expect(await prisma.reviewItem.count({ where: { kind: "extraction_failed" } })).toBe(1);
  });
});

describe("runExtract: idempotency and races", () => {
  it("running it again on an extracted message does nothing", async () => {
    const f = mail("m1", { bodyText: "Hello" });
    const { ctx, llm } = await setup(f);
    llm.register("extract", { messageId: "m1" }, extraction());
    await runExtract(ctx, "m1");
    const before = await row("m1");
    ctx.queue.sent.length = 0;

    await runExtract(ctx, "m1");

    expect(llm.calls).toHaveLength(1);
    expect(ctx.queue.sent).toEqual([]);
    expect(await row("m1")).toEqual(before);
  });

  it("does nothing, and fetches nothing, unless the message is job_related", async () => {
    let fetches = 0;
    const real = new FakeGmailClient([]);
    const gmail = withFull(real, () => {
      fetches += 1;
      return Promise.reject(new Error("must not be called"));
    });
    const ctx = testWorkerCtx({
      gmail: fakeGmailFactory(gmail),
      llm: FakeLlmProvider.fromFixtures({ emails: [], leadBatches: [] }),
    });
    for (const state of [
      "discovered",
      "skipped",
      "triaged_out",
      "extracted",
      "applied",
      "needs_review",
      "failed",
    ] as const) {
      await prisma.gmailMessage.create({
        data: {
          id: `s-${state}`,
          threadId: "t",
          internalDate: new Date(0),
          direction: "inbound",
          labelIds: [],
          state,
        },
      });
      await runExtract(ctx, `s-${state}`);
      expect((await row(`s-${state}`)).state).toBe(state);
    }
    await runExtract(ctx, "no-such-message");
    expect(fetches).toBe(0);
    expect(ctx.queue.sent).toEqual([]);
    expect((ctx.llm as FakeLlmProvider).calls).toEqual([]);
  });

  it("leaves a message alone that left job_related while the model was answering", async () => {
    const f = mail("m1", { bodyText: "Hello" });
    const { ctx, llm } = await setup(f);
    const slow = Object.create(llm) as FakeLlmProvider;
    slow.extract = async (input, callCtx) => {
      const result = await llm.extract(input, callCtx);
      // A second worker finished first.
      await prisma.gmailMessage.update({ where: { id: "m1" }, data: { state: "applied" } });
      return result;
    };
    await runExtract({ ...ctx, llm: slow }, "m1");
    expect(await row("m1")).toMatchObject({ state: "applied", extraction: null, bodyText: null });
    expect(ctx.queue.sent).toEqual([]);
  });

  it("an email.apply send that fails does not fail the extraction; the sweep picks it up", async () => {
    const f = mail("m1", { bodyText: "Hello" });
    const { ctx } = await setup(f);
    ctx.queue.failSendWith = new Error("queue down");
    await runExtract(ctx, "m1");
    expect((await row("m1")).state).toBe("extracted");
  });
});

describe("markExtractionFailed (retry exhaustion)", () => {
  it("marks a job_related message failed with one review item, and is repeatable", async () => {
    const f = mail("m1", { bodyText: "Hello" });
    const { ctx } = await setup(f);
    await markExtractionFailed(ctx, "m1", "llm_upstream");
    await markExtractionFailed(ctx, "m1", "llm_upstream");
    expect(await row("m1")).toMatchObject({
      state: "failed",
      lastError: "llm_upstream",
      subject: "Interview with Quarry AI",
    });
    expect(await prisma.reviewItem.findMany()).toMatchObject([
      { kind: "extraction_failed", state: "open", messageId: "m1" },
    ]);
  });

  it("does not touch a message that is no longer job_related", async () => {
    const f = mail("m1", { bodyText: "Hello" });
    const { ctx } = await setup(f, undefined, { state: "extracted" });
    await markExtractionFailed(ctx, "m1", "llm_upstream");
    expect((await row("m1")).state).toBe("extracted");
    expect(await prisma.reviewItem.count()).toBe(0);
  });
});

describe("runExtract: logging", () => {
  it("logs no subject, address or body, whether the stage fails or succeeds", async () => {
    const secrets = [
      "Confidential offer terms",
      "stranger.person@unknown.example",
      "salary of 999",
    ];
    const f = mail("m1", {
      headers: {
        from: `Stranger <${secrets[1]}>`,
        to: ["owner@example.com"],
        subject: secrets[0] as string,
        date: "Mon, 05 Oct 2026 10:00:00 +0000",
      },
      bodyText: `Your ${secrets[2]} is attached.`,
    });
    const { ctx: base, llm } = await setup(f, undefined, {
      fromEmail: secrets[1],
      subject: secrets[0],
    });
    const lines: string[] = [];
    const log = pino({ level: "trace" }, { write: (line: string) => void lines.push(line) });
    const ctx = { ...base, log };

    llm.failNext(
      "extract",
      new LlmError("upstream", `down ${secrets.join(" ")}`, { retryable: true }),
    );
    await expect(runExtract(ctx, "m1")).rejects.toBeInstanceOf(LlmError);
    llm.failNext("extract", invalid(`bad ${secrets.join(" ")}`));
    llm.failNext("extract", invalid());
    await runExtract(ctx, "m1");

    const logged = lines.join("\n");
    for (const secret of secrets) expect(logged).not.toContain(secret);
    expect(logged).not.toContain("owner@example.com");
  });
});
