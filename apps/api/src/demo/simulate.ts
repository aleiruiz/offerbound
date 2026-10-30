import type { WorkerCtx } from "../deps.js";
import { withIntakeLock } from "../db/lock.js";
import { ApiError } from "../http/errors.js";
import { QUEUES, type JobQueue, type QueueName } from "../jobs/queues.js";
import { FakeLlmProvider } from "../llm/fake-provider.js";
import { applyEligibleMessages } from "../pipeline/apply.js";
import { runExtract } from "../pipeline/extract.js";
import { runTriageBatch } from "../pipeline/triage.js";
import { FakeMailbox } from "./fake-mailbox.js";

/** The stages `simulateEmail` runs itself, in the request, so the visitor sees the result at once. */
const RUN_INLINE: ReadonlySet<QueueName> = new Set([
  QUEUES.emailTriage,
  QUEUES.emailExtract,
  QUEUES.emailApply,
]);

/**
 * The queue the inline run sees: jobs for the three stages it runs itself are dropped (otherwise
 * the worker would race it for the same message), everything else goes on as usual (`leads.check`
 * for the leads an email brings, which the worker finishes within seconds).
 */
function inlineQueue(queue: JobQueue): JobQueue {
  return {
    send: (name, data, opts) =>
      RUN_INLINE.has(name) ? Promise.resolve() : queue.send(name, data, opts),
    schedule: (name, cron, opts) => queue.schedule(name, cron, opts),
    unschedule: (name) => queue.unschedule(name),
    hasDelayed: (name) => queue.hasDelayed(name),
    isReady: () => queue.isReady(),
  };
}

/**
 * `POST /demo/simulate-email` (TECHNICAL_SPEC §12, AC-16.4): the next unused demo email arrives
 * (dated now) as a `discovered` message, and goes through triage, extraction and apply, the real
 * stages, with the fake model, before this returns. The visitor sees the status, interview or
 * lead change and the timeline entry. Picking the email and storing its row happen together
 * under the intake lock, so two visitors never get the same one.
 */
export async function simulateEmail(ctx: WorkerCtx): Promise<{ messageId: string }> {
  if (ctx.env.mode !== "demo") throw new Error("Simulated email only runs in demo mode.");
  const mailbox = await ctx.gmail();
  const { llm } = ctx;
  if (!(mailbox instanceof FakeMailbox) || !(llm instanceof FakeLlmProvider)) {
    throw new ApiError(503, "not_ready", "The demo mailbox is not available.");
  }
  const now = ctx.clock();

  const delivered = await withIntakeLock(ctx.prisma, async (tx) => {
    const used = new Set(
      (await tx.gmailMessage.findMany({ select: { id: true } })).map((m) => m.id),
    );
    const fixture = mailbox.deliverNext(used, now);
    // The model answers for this message with what the fixture says, moved to now.
    if (fixture.llm.triage !== null) {
      llm.register("triage", { messageId: fixture.id }, fixture.llm.triage);
    }
    if (fixture.llm.extraction !== null) {
      llm.register("extract", { messageId: fixture.id }, fixture.llm.extraction);
    }
    // What sync leaves behind: the id, with placeholder values until triage reads the message.
    await tx.gmailMessage.create({
      data: {
        id: fixture.id,
        threadId: fixture.threadId,
        internalDate: new Date(0),
        direction: "inbound",
        labelIds: [],
        discoveredAt: now,
      },
    });
    return fixture;
  });

  const inline: WorkerCtx = { ...ctx, queue: inlineQueue(ctx.queue) };
  await runTriageBatch(inline);
  await runExtract(inline, delivered.id);
  await applyEligibleMessages(inline);
  return { messageId: delivered.id };
}
