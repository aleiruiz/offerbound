import type { Prisma } from "@prisma/client";
import { ExtractionSchema, IcsEventSchema, type Extraction } from "@offerbound/contracts";
import { planChanges, type ChangePlan, type PlanMessage } from "@offerbound/domain";
import { z } from "zod";
import { withIntakeLock } from "../db/lock.js";
import type { WorkerCtx } from "../deps.js";
import { enqueueLeadChecks } from "../leads/intake.js";
import { createReviewItem } from "../review/create.js";
import { getSettings } from "../settings/service.js";
import { executePlan, VersionConflictError, type LeadChecks } from "./execute-plan.js";
import { loadPlanSnapshot } from "./snapshot.js";
import { NO_CONTENT } from "./triage.js";

/**
 * The apply stage (TECHNICAL_SPEC §5.6, §6.5, §6.8; AC-3.8, AC-3.9, AC-4.1, AC-4.2; Review Focus
 * 4). It turns `extracted` messages into records, oldest first, and only behind the watermark:
 * the minimum `internal_date` of the messages still `discovered` or `job_related`. A message is
 * applied only when its date is strictly before the watermark (equal dates wait: ATS systems
 * send several emails in the same second, and the pending one may sort first), or when nothing
 * is pending. `failed`, `skipped` and `triaged_out` messages hold nothing back.
 *
 * `email.apply` runs under a singleton policy and is sent without a key, so one run drains every
 * eligible message in `(internal_date, id)` order. Each message gets its own transaction under
 * the intake lock; the watermark and the next message are read inside it, so a message triage
 * moves on between two applies is seen. A message ends in one of three states:
 * - `applied`: the plan ran (`executePlan`), and each notice opened a review item;
 * - `needs_review`: the plan needs the owner; one review item holds it, nothing else changes;
 * - `triaged_out`: the plan says it is not about a job; every content column is cleared in the
 *   same update (DATA_MODEL §3.6).
 *
 * Failures:
 * - {@link VersionConflictError} (an owner edit landed after the snapshot): the transaction is
 *   abandoned, the message stays `extracted`, and the drain stops here, since later messages must
 *   not pass it. The next sweep plans it again.
 * - A stored extraction that no longer parses: the message is `failed` with a review item, and
 *   the drain goes on (a failed message holds nothing back).
 * - Anything else (a database error, a bug): counted in `attempts`. The error is rethrown for
 *   pg-boss's retries until {@link MAX_APPLY_ATTEMPTS} are used up, then the message is failed
 *   like the cases above, so one poison message cannot block the pipeline for ever.
 *
 * Nothing here logs subjects, addresses, bodies or summaries: only counts and error names.
 */

/** Failed attempts after which an `extracted` message is `failed` (`attempts` counts them). */
export const MAX_APPLY_ATTEMPTS = 3;

/** A message that can never be applied as it is; `code` goes to `last_error`. */
class ApplyFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ApplyFailure";
  }
}

type Tx = Prisma.TransactionClient;
type Step =
  | { kind: "none" }
  | {
      kind: "done";
      messageId: string;
      state: "applied" | "other";
      /** `leads.check` jobs to send once the transaction has committed. */
      leadChecks: LeadChecks[];
    };

const IcsEventsSchema = z.array(IcsEventSchema);

function describeNotice(names: string[]): string {
  return names.length === 0
    ? "A company with a similar name already exists"
    : `Might be the same company as ${names.join(", ")}`;
}

/** Applies the next eligible message inside the lock. `current` is set once a message is chosen. */
async function applyNext(tx: Tx, ctx: WorkerCtx, current: { id: string | null }): Promise<Step> {
  const pending = await tx.gmailMessage.aggregate({
    where: { state: { in: ["discovered", "job_related"] } },
    _min: { internalDate: true },
  });
  const watermark = pending._min.internalDate;
  const message = await tx.gmailMessage.findFirst({
    where: {
      state: "extracted",
      ...(watermark === null ? {} : { internalDate: { lt: watermark } }),
    },
    orderBy: [{ internalDate: "asc" }, { id: "asc" }],
  });
  if (message === null) return { kind: "none" };
  current.id = message.id;

  const parsed = ExtractionSchema.safeParse(message.extraction);
  if (!parsed.success) throw new ApplyFailure("stored_extraction_invalid");
  const extraction: Extraction = parsed.data;
  const ics = IcsEventsSchema.safeParse(message.icsEvents ?? []);
  const planMessage: PlanMessage = {
    id: message.id,
    threadId: message.threadId,
    internalDate: message.internalDate,
    direction: message.direction,
    fromEmail: message.fromEmail,
    icsEvents: ics.success ? ics.data : [],
  };

  const settings = await getSettings(tx);
  const { automation } = settings;
  const snapshot = await loadPlanSnapshot(tx, planMessage, extraction, ctx.env.userTimezone);
  const plan: ChangePlan = planChanges(snapshot, planMessage, extraction, {
    autoApplyMinConfidence: automation.autoApplyMinConfidence,
  });
  const now = ctx.clock();
  const move = (data: Prisma.GmailMessageUpdateManyMutationInput) =>
    tx.gmailMessage.updateMany({
      where: { id: message.id, state: "extracted" },
      data: { ...data, processedAt: now, lastError: null },
    });

  if (plan.autoApply && plan.messageOutcome === "triaged_out") {
    await move({ ...NO_CONTENT, state: "triaged_out" });
    return { kind: "done", messageId: message.id, state: "other", leadChecks: [] };
  }

  if (!plan.autoApply || plan.review !== null) {
    const { review } = plan;
    if (review === null) throw new Error("The planner left a plan unapplied without a review");
    await createReviewItem(tx, {
      kind: review.kind,
      messageId: message.id,
      confidence: plan.confidence,
      plan,
      candidates: review.candidates,
      reasons: review.reasons,
    });
    await move({ state: "needs_review" });
    return { kind: "done", messageId: message.id, state: "other", leadChecks: [] };
  }

  const { refs, leadChecks } = await executePlan(tx, plan, {
    messageId: message.id,
    occurredAt: message.internalDate,
    actor: "system",
    settings,
  });
  for (const notice of plan.notices) {
    const companyId = "id" in notice.company ? notice.company.id : refs[notice.company.ref];
    await createReviewItem(tx, {
      kind: notice.kind,
      messageId: message.id,
      ...(companyId === undefined ? {} : { companyId }),
      confidence: null,
      plan: null,
      candidates: notice.candidates,
      reasons: [describeNotice(notice.candidates.map((c) => c.label))],
    });
  }
  await move({ state: "applied" });
  return { kind: "done", messageId: message.id, state: "applied", leadChecks };
}

/**
 * Records that a message could not be applied, in one short transaction under the intake lock
 * (the failed apply transaction was rolled back, so nothing else is held). With `retry` the
 * failure is counted in `attempts`, and the message is failed once {@link MAX_APPLY_ATTEMPTS} are
 * used; without it the message is failed at once (`code` goes to `last_error`, one *Extraction
 * failed* review item opens). Returns whether the message is now `failed`.
 *
 * This runs while the original error is being handled, so it never throws: if the database
 * refuses, the caller still reports the original error, and the message stays `extracted` for the
 * next sweep.
 */
async function recordFailure(
  ctx: WorkerCtx,
  messageId: string,
  code: string,
  retry: boolean,
): Promise<boolean> {
  const now = ctx.clock();
  try {
    return await withIntakeLock(ctx.prisma, async (tx) => {
      if (retry) {
        const { count } = await tx.gmailMessage.updateMany({
          where: { id: messageId, state: "extracted" },
          data: { attempts: { increment: 1 }, lastError: code },
        });
        if (count === 0) return false;
        const row = await tx.gmailMessage.findUniqueOrThrow({
          where: { id: messageId },
          select: { attempts: true },
        });
        if (row.attempts < MAX_APPLY_ATTEMPTS) return false;
      }
      const { count } = await tx.gmailMessage.updateMany({
        where: { id: messageId, state: "extracted" },
        data: { state: "failed", lastError: code, processedAt: now },
      });
      if (count === 0) return false;
      await tx.reviewItem.createMany({
        data: [{ kind: "extraction_failed", messageId, reasons: ["apply_failed"] }],
        skipDuplicates: true,
      });
      return true;
    });
  } catch (recordError) {
    ctx.log.error(
      { errorName: recordError instanceof Error ? recordError.name : "unknown" },
      "could not record an apply failure",
    );
    return false;
  }
}

/**
 * Sends `leads.check` for the leads an applied message stored, after its transaction committed. A
 * failed send is logged by error name and does not undo the message: the leads wait in `checking`
 * until T7.5's `sendPendingChecks` sweep sends their checks again.
 */
async function sendLeadChecks(ctx: WorkerCtx, batches: LeadChecks[]): Promise<void> {
  for (const batch of batches) {
    try {
      await enqueueLeadChecks(ctx.queue, batch);
    } catch (error) {
      ctx.log.warn(
        {
          errorName: error instanceof Error ? error.name : "unknown",
          leads: batch.checkIds.length,
        },
        "could not queue lead checks",
      );
    }
  }
}

/**
 * Applies every eligible `extracted` message, oldest first (see the module comment). Returns how
 * many reached `applied`.
 */
export async function applyEligibleMessages(ctx: WorkerCtx): Promise<{ applied: number }> {
  let applied = 0;
  let previous: string | null = null;
  for (;;) {
    const current: { id: string | null } = { id: null };
    let step: Step;
    try {
      step = await withIntakeLock(ctx.prisma, (tx) => applyNext(tx, ctx, current));
    } catch (error) {
      if (error instanceof VersionConflictError) {
        ctx.log.warn(
          "an owner edit changed a record mid-apply; the message waits for the next sweep",
        );
        break;
      }
      const messageId = current.id;
      if (messageId === null) throw error;
      if (error instanceof ApplyFailure) {
        if (await recordFailure(ctx, messageId, error.code, false)) {
          ctx.log.warn({ errorName: error.name }, "a message could not be applied and was failed");
          continue;
        }
        throw error;
      }
      ctx.log.error(
        { errorName: error instanceof Error ? error.name : "unknown" },
        "applying a message failed",
      );
      if (await recordFailure(ctx, messageId, "apply_error", true)) continue;
      throw error;
    }
    if (step.kind === "none") break;
    await sendLeadChecks(ctx, step.leadChecks);
    // Cannot happen under the lock; a guard so a bug can never spin this loop.
    if (step.messageId === previous) break;
    previous = step.messageId;
    if (step.state === "applied") applied += 1;
  }
  if (applied > 0) ctx.log.info({ applied }, "applied messages");
  return { applied };
}
