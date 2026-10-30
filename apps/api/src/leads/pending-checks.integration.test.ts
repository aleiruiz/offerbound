import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import { normalizeCompanyName } from "@offerbound/domain";
import { resetDb, testPrisma } from "../../test/db.js";
import { RecordingQueue } from "../../test/queue.js";
import { testWorkerCtx } from "../../test/worker.js";
import { HANDLERS } from "../jobs/handlers.js";
import { QUEUES, type QueueName, type SendOptions } from "../jobs/queues.js";
import { enqueueLeadChecks, PENDING_CHECK_AFTER_MS, sendPendingChecks } from "./intake.js";

const prisma = testPrisma();
const NOW = new Date("2026-10-01T12:00:00.000Z");
const minutesAgo = (n: number): Date => new Date(NOW.getTime() - n * 60_000);

beforeEach(async () => {
  await resetDb(prisma);
});

async function seedBatch(): Promise<string> {
  const batch = await prisma.intakeBatch.create({
    data: {
      kind: "sheet_import",
      counts: { received: 0, duplicates: 0, suppressed: 0, dead: 0, accepted: 0 },
    },
  });
  return batch.id;
}

async function seedLead(
  batchId: string,
  name: string,
  over: Partial<Prisma.LeadUncheckedCreateInput> & { updatedAt: Date },
): Promise<string> {
  const company = await prisma.company.create({
    data: { name, normalizedName: normalizeCompanyName(name), createdSource: "sheet_import" },
  });
  const lead = await prisma.lead.create({
    data: {
      companyId: company.id,
      intakeBatchId: batchId,
      title: "Backend Engineer",
      statusChangedAt: NOW,
      source: "sheet_import",
      pipelineState: "checking",
      ...over,
    },
  });
  return lead.id;
}

/** A queue whose first `failures` sends are lost. */
class LossyQueue extends RecordingQueue {
  constructor(private failures: number) {
    super();
  }

  override send(
    name: QueueName,
    data: Record<string, unknown> = {},
    opts: SendOptions = {},
  ): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      return Promise.reject(new Error("queue down"));
    }
    return super.send(name, data, opts);
  }
}

describe("enqueueLeadChecks", () => {
  it("queue.send throwing for the first of three leads still sends the other two", async () => {
    const queue = new LossyQueue(1);
    const errors: unknown[] = [];
    const failed = await enqueueLeadChecks(
      queue,
      { batchId: "b1", checkIds: ["l1", "l2", "l3"] },
      { error: (...args: unknown[]) => errors.push(args) },
    );
    expect(failed).toBe(1);
    expect(queue.sent.map((s) => s.data)).toEqual([
      { leadId: "l2", batchId: "b1" },
      { leadId: "l3", batchId: "b1" },
    ]);
    expect(errors).toHaveLength(1);
  });
});

describe("sendPendingChecks", () => {
  it("sends leads.check for a lead stranded in checking for over 10 minutes and ignores a recent one", async () => {
    const batchId = await seedBatch();
    const stale = await seedLead(batchId, "Stale Example", {
      updatedAt: minutesAgo(PENDING_CHECK_AFTER_MS / 60_000 + 1),
    });
    await seedLead(batchId, "Recent Example", { updatedAt: minutesAgo(2) });
    await seedLead(batchId, "Ranking Example", {
      updatedAt: minutesAgo(60),
      pipelineState: "ranking",
    });
    await seedLead(batchId, "Ready Example", { updatedAt: minutesAgo(60), pipelineState: "ready" });

    const ctx = testWorkerCtx({ clock: () => NOW });
    expect(await sendPendingChecks(ctx)).toBe(1);
    expect(ctx.queue.sent).toEqual([
      {
        name: QUEUES.leadsCheck,
        data: { leadId: stale, batchId },
        opts: {},
      },
    ]);
  });

  it("two sweeps in a row send a stranded lead only once, and again after another 10 minutes", async () => {
    const batchId = await seedBatch();
    const stale = await seedLead(batchId, "Stale Example", { updatedAt: minutesAgo(30) });
    let now = NOW;
    const ctx = testWorkerCtx({ clock: () => now });

    expect(await sendPendingChecks(ctx)).toBe(1);
    now = new Date(NOW.getTime() + 60_000);
    expect(await sendPendingChecks(ctx)).toBe(0);
    expect(ctx.queue.sent).toHaveLength(1);

    now = new Date(NOW.getTime() + PENDING_CHECK_AFTER_MS + 60_000);
    expect(await sendPendingChecks(ctx)).toBe(1);
    expect(ctx.queue.sent.map((s) => s.data.leadId)).toEqual([stale, stale]);
  });

  it("carries on past a send that fails", async () => {
    const batchId = await seedBatch();
    const first = await seedLead(batchId, "One Example", { updatedAt: minutesAgo(30) });
    const second = await seedLead(batchId, "Two Example", { updatedAt: minutesAgo(30) });
    const queue = new LossyQueue(1);
    const ctx = testWorkerCtx({ clock: () => NOW, queue });
    await sendPendingChecks(ctx);
    expect(queue.sent).toHaveLength(1);
    expect([first, second]).toContain(queue.sent[0]?.data.leadId);
  });

  it("runs from the 1-minute email.triage sweep", async () => {
    const batchId = await seedBatch();
    const stale = await seedLead(batchId, "Stale Example", { updatedAt: minutesAgo(30) });
    const ctx = testWorkerCtx({ clock: () => NOW });
    await HANDLERS[QUEUES.emailTriage]?.(ctx, { data: {}, retryCount: 0, retryLimit: 3 });
    expect(ctx.queue.sent.filter((s) => s.name === QUEUES.leadsCheck).map((s) => s.data)).toEqual([
      { leadId: stale, batchId },
    ]);
  });
});
