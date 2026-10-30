import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiErrorBody } from "@offerbound/contracts";
import { seedMessage, stateOf } from "../../test/apply.js";
import { buildTestApp, testEnv, signIn } from "../../test/app.js";
import { resetDb, testPrisma } from "../../test/db.js";
import { emailFixture, seedStartedConnection } from "../../test/gmail.js";
import { testWorkerCtx } from "../../test/worker.js";
import { withIntakeLock } from "../db/lock.js";
import { QUEUES } from "../jobs/queues.js";
import type { GmailClient } from "../gmail/client.js";
import { FakeGmailClient, fakeGmailFactory } from "../gmail/fake-client.js";
import { runIncrementalSync } from "../gmail/sync.js";
import { applyEligibleMessages } from "../pipeline/apply.js";
import { NO_CONTENT } from "../pipeline/triage.js";
import { resendPendingExtractions, runTriageBatch } from "../pipeline/triage.js";

const prisma = testPrisma();
const CSRF = { "x-offerbound-request": "1" };

const apps: FastifyInstance[] = [];
async function setup(options: Parameters<typeof buildTestApp>[1] = {}, env = testEnv()) {
  const built = await buildTestApp({ env }, options);
  apps.push(built.app);
  const cookie = await signIn(built.app, built.deps);
  const purge = (payload: object = { confirm: "DELETE" }) =>
    built.app.inject({
      method: "POST",
      url: "/api/v1/data/purge-email-content",
      headers: { cookie, ...CSRF },
      payload,
    });
  return { ...built, cookie, purge };
}

beforeEach(async () => {
  await resetDb(prisma);
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
// Leaves no connection row behind for the files that run after this one.
afterAll(async () => {
  await resetDb(prisma);
});

const CONTENT = ["fromEmail", "fromName", "subject", "snippet", "bodyText"] as const;
const messageRow = (id: string) => prisma.gmailMessage.findUniqueOrThrow({ where: { id } });

/** An `applied` message with every content column filled, linked to an application. */
async function seedApplied(id: string, at: string, applicationId?: string) {
  await seedMessage(prisma, { id, at, state: "extracted" });
  await prisma.gmailMessage.update({
    where: { id },
    data: { state: "applied", ...(applicationId ? { applicationId } : {}) },
  });
}

async function seedRecord() {
  const company = await prisma.company.create({
    data: { name: "Quarry AI", normalizedName: "quarry ai", createdSource: "manual" },
  });
  const application = await prisma.application.create({
    data: {
      companyId: company.id,
      title: "Platform Engineer",
      status: "applied",
      statusChangedAt: new Date("2026-09-20T10:00:00.000Z"),
      source: "manual",
    },
  });
  return { company, application };
}

describe("POST /data/purge-email-content", () => {
  it("purges stored email content and returns the count", async () => {
    const { purge } = await setup();
    await seedApplied("m1", "2026-10-05T10:00:00.000Z");
    await seedApplied("m2", "2026-10-05T11:00:00.000Z");
    // A message that never held content is not counted.
    await prisma.gmailMessage.create({
      data: {
        id: "m3",
        threadId: "thr-m3",
        internalDate: new Date("2026-10-05T12:00:00.000Z"),
        direction: "inbound",
        labelIds: [],
        state: "triaged_out",
      },
    });

    // What triage, extraction and review write for a skipped or triaged_out message: the content
    // columns cleared, with `to_emails` an empty array rather than NULL.
    await prisma.gmailMessage.create({
      data: {
        id: "m4",
        threadId: "thr-m4",
        internalDate: new Date("2026-10-05T13:00:00.000Z"),
        direction: "inbound",
        labelIds: [],
        state: "triaged_out",
        ...NO_CONTENT,
      },
    });
    const emptyList = await prisma.$queryRaw<{ empty: boolean }[]>`
      SELECT to_emails = '{}' AS empty FROM gmail_message WHERE id = 'm4'`;
    expect(emptyList[0]?.empty).toBe(true);

    const res = await purge();

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ messagesPurged: 2 });
    for (const id of ["m1", "m2", "m3", "m4"]) {
      const row = await messageRow(id);
      for (const column of CONTENT) expect(row[column], `${id}.${column}`).toBeNull();
      expect(row.toEmails).toEqual([]);
    }
    const raw = await prisma.$queryRaw<{ to_emails: string[] | null }[]>`
      SELECT to_emails FROM gmail_message WHERE id = 'm1'`;
    expect(raw[0]?.to_emails).toBeNull();

    // Nothing left to purge.
    expect(JSON.parse((await purge()).body)).toEqual({ messagesPurged: 0 });
  });

  it("keeps records and timelines", async () => {
    const { purge } = await setup();
    const { application } = await seedRecord();
    await seedApplied("m1", "2026-10-05T10:00:00.000Z", application.id);
    await prisma.event.create({
      data: {
        applicationId: application.id,
        companyId: application.companyId,
        type: "email_received",
        actor: "system",
        messageId: "m1",
        summary: "Application received",
        undoable: true,
      },
    });
    const before = await messageRow("m1");

    expect((await purge()).statusCode).toBe(200);

    const after = await messageRow("m1");
    expect(after.state).toBe("applied");
    expect(after.applicationId).toBe(application.id);
    expect(after.summary).toBe(before.summary);
    expect(after.category).toBe(before.category);
    expect(after.threadId).toBe(before.threadId);
    expect(after.internalDate).toEqual(before.internalDate);
    expect(await prisma.application.count()).toBe(1);
    expect(await prisma.company.count()).toBe(1);
    expect(await prisma.event.count()).toBe(1);
    const kept = await prisma.event.findFirstOrThrow();
    expect(kept.summary).toBe("Application received");
    expect(kept.messageId).toBe("m1");
  });

  it("a wrong confirm → 400 and nothing is purged", async () => {
    const { purge } = await setup();
    await seedApplied("m1", "2026-10-05T10:00:00.000Z");

    for (const payload of [{}, { confirm: "delete" }, { confirm: "" }, { confirm: true }]) {
      const res = await purge(payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect((JSON.parse(res.body) as ApiErrorBody).error.code).toBe("validation_failed");
    }
    expect((await messageRow("m1")).subject).not.toBeNull();
  });

  it("runs under the intake lock", async () => {
    const { purge } = await setup();
    await seedApplied("m1", "2026-10-05T10:00:00.000Z");

    let release: () => void = () => undefined;
    let held: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const holder = withIntakeLock(prisma, async () => {
      held();
      await new Promise<void>((resolve) => (release = resolve));
    });
    await holding;

    let done = false;
    const pending = purge().then((res) => {
      done = true;
      return res;
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(done).toBe(false);
    expect((await messageRow("m1")).subject).not.toBeNull();

    release();
    await holder;
    expect((await pending).statusCode).toBe(200);
    expect((await messageRow("m1")).subject).toBeNull();
  });

  it("logs only the count", async () => {
    const lines: string[] = [];
    const logStream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const { purge } = await setup({ logStream }, testEnv({ LOG_LEVEL: "info" }));
    await seedApplied("m1", "2026-10-05T10:00:00.000Z");

    expect((await purge()).statusCode).toBe(200);

    const logged = lines.join("");
    expect(logged).toContain('"messagesPurged":1');
    for (const secret of [
      "Subject of m1",
      "Snippet of m1",
      "Body of m1",
      "careers@quarry.example",
    ]) {
      expect(logged).not.toContain(secret);
    }
  });

  it("answers 403 csrf_header_missing without the request header", async () => {
    const { app, cookie } = await setup();
    await seedApplied("m1", "2026-10-05T10:00:00.000Z");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/data/purge-email-content",
      headers: { cookie },
      payload: { confirm: "DELETE" },
    });
    expect(res.statusCode).toBe(403);
    expect((JSON.parse(res.body) as ApiErrorBody).error.code).toBe("csrf_header_missing");
    expect((await messageRow("m1")).subject).not.toBeNull();
  });

  it("answers 401 without a session", async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/data/purge-email-content",
      headers: CSRF,
      payload: { confirm: "DELETE" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("after a purge", () => {
  it("a purged extracted message still applies, with no sender", async () => {
    const { purge } = await setup();
    await seedMessage(prisma, { id: "x1", at: "2026-10-05T10:00:00.000Z", state: "extracted" });

    expect(JSON.parse((await purge()).body)).toEqual({ messagesPurged: 1 });
    expect((await messageRow("x1")).fromEmail).toBeNull();

    expect(await applyEligibleMessages(testWorkerCtx())).toEqual({ applied: 1 });
    expect(await stateOf(prisma, "x1")).toBe("applied");
    expect(await prisma.application.count()).toBe(1);
    expect(await prisma.reviewItem.count()).toBe(0);
  });

  /** Counts every Gmail fetch the pipeline makes. */
  class CountingClient implements GmailClient {
    fetched: string[] = [];
    constructor(private readonly inner: GmailClient) {}
    getProfile() {
      return this.inner.getProfile();
    }
    listMessages(q: string, pageToken: string | null) {
      return this.inner.listMessages(q, pageToken);
    }
    listHistory(start: string, pageToken: string | null) {
      return this.inner.listHistory(start, pageToken);
    }
    getMetadata(id: string) {
      this.fetched.push(id);
      return this.inner.getMetadata(id);
    }
    getFull(id: string) {
      this.fetched.push(id);
      return this.inner.getFull(id);
    }
  }

  it("a later pipeline run does not re-fetch or re-process purged messages", async () => {
    const { purge } = await setup();
    await seedStartedConnection(prisma, { historyId: "5" });
    const states = {
      a1: "applied",
      s1: "skipped",
      t1: "triaged_out",
      f1: "failed",
    } as const;
    let hour = 0;
    for (const [id, state] of Object.entries(states)) {
      hour += 1;
      await seedMessage(prisma, { id, at: `2026-10-05T0${hour}:00:00.000Z`, state: "extracted" });
      await prisma.gmailMessage.update({ where: { id }, data: { state } });
    }
    const before = await prisma.gmailMessage.findMany({ orderBy: { id: "asc" } });

    expect(JSON.parse((await purge()).body)).toEqual({ messagesPurged: 4 });

    // The mailbox still holds all four, and the history listing reports them again.
    const mailbox = Object.keys(states).map((id) =>
      emailFixture(id, `2026-10-05T0${Object.keys(states).indexOf(id) + 1}:00:00.000Z`),
    );
    // A control: a message that is still `discovered` is fetched, so the counter below can fail.
    mailbox.push(emailFixture("d1", "2026-10-05T09:00:00.000Z", { labels: ["INBOX", "SPAM"] }));
    await prisma.gmailMessage.create({
      data: {
        id: "d1",
        threadId: "thr-d1",
        internalDate: new Date(0),
        direction: "inbound",
        labelIds: [],
      },
    });
    const client = new CountingClient(
      new FakeGmailClient(mailbox, { historyExpired: true, profileHistoryId: "9" }),
    );
    const ctx = testWorkerCtx({ gmail: fakeGmailFactory(client) });

    await runIncrementalSync(ctx);
    await runTriageBatch(ctx);
    await resendPendingExtractions(ctx);
    await applyEligibleMessages(ctx);

    expect(client.fetched).toEqual(["d1"]);
    expect(ctx.queue.sent.map((job) => job.name)).not.toContain(QUEUES.emailTriage);
    expect((await messageRow("d1")).state).toBe("skipped");
    const after = await prisma.gmailMessage.findMany({
      where: { id: { not: "d1" } },
      orderBy: { id: "asc" },
    });
    expect(after.map((row) => [row.id, row.state, row.attempts])).toEqual(
      before.map((row) => [row.id, row.state, row.attempts]),
    );
    for (const row of after) {
      for (const column of CONTENT) expect(row[column], `${row.id}.${column}`).toBeNull();
    }
    expect(await prisma.reviewItem.count()).toBe(0);
  });
});
