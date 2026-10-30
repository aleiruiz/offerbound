import type { GmailMessage, Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import type {
  Extraction,
  MessageDetail,
  Page,
  ReviewItem as ReviewItemDto,
  ReviewKind,
  ReviewResolve,
} from "@offerbound/contracts";
import { planChanges, type OwnerChoice } from "@offerbound/domain";
import { withIntakeLock } from "../db/lock.js";
import type { WorkerCtx } from "../deps.js";
import { ApiError } from "../http/errors.js";
import { VersionConflictError as ConflictWithCurrent } from "../leads/owner-actions.js";
import { QUEUES, type QueueName } from "../jobs/queues.js";
import { sendLeadChecks } from "../pipeline/apply.js";
import { executePlan, VersionConflictError, type LeadChecks } from "../pipeline/execute-plan.js";
import { openNoticeItems, parseStoredExtraction, toPlanMessage } from "../pipeline/plan-message.js";
import { loadPlanSnapshot } from "../pipeline/snapshot.js";
import { NO_CONTENT } from "../pipeline/triage.js";
import { getSettings } from "../settings/service.js";
import { APPLY_FAILED, REVIEW_ITEM_INCLUDE, toReviewItemDto } from "./dto.js";
import { mergeCompanies } from "./merge-companies.js";

export { describePlan, toReviewItemDto, REVIEW_ITEM_INCLUDE } from "./dto.js";
export type { ReviewRow } from "./dto.js";

/**
 * The review queue (TECHNICAL_SPEC §6.5, §10.1; AC-5.1 to AC-5.4). Resolving an item plans the
 * email again against a fresh snapshot with the owner's choice, and executes that plan through
 * the plan executor, in the intake-lock transaction, exactly as an automatic change runs
 * (AC-5.3): the owner's choice never replays the stored proposal, it is only what the owner was
 * shown. Nothing here logs: the rows hold email-derived text.
 *
 * Answers:
 * - `404 not_found`: no such item or email.
 * - `400 validation_failed`: an action the item's kind doesn't offer, or a missing or unusable
 *   `applicationId` / `edits`.
 * - `409 changed_since`: the item is no longer open, or the email it holds is no longer waiting
 *   for the owner (it was handled some other way). Nothing is changed.
 * - `409 version_conflict` with `current` (the item as it is now): an owner edit landed on a
 *   record while the change was being written. Nothing is changed; the item stays open.
 */

type Tx = Prisma.TransactionClient;
type Db = PrismaClient | Prisma.TransactionClient;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const notFound = (what: string) => new ApiError(404, "not_found", `No such ${what}.`);
const changedSince = (message: string) => new ApiError(409, "changed_since", message);

// --- listing -----------------------------------------------------------------------------------

const CursorSchema = z.object({ t: z.iso.datetime(), i: z.string() });

function encodeCursor(at: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: at.toISOString(), i: id })).toString("base64url");
}

function decodeCursor(raw: string): { at: Date; id: string } {
  const invalid = () =>
    new ApiError(400, "validation_failed", "The cursor is not valid.", { cursor: "invalid" });
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  const parsed = CursorSchema.safeParse(json);
  if (!parsed.success || !UUID.test(parsed.data.i)) throw invalid();
  return { at: new Date(parsed.data.t), id: parsed.data.i };
}

/**
 * One page of review items. Open items are listed newest first (AC-5.1); resolved ones (resolved
 * or dismissed) by when they were decided, latest first. The id breaks ties, so a cursor never
 * skips or repeats an item.
 */
export async function listReviewItems(
  db: Pick<PrismaClient, "reviewItem">,
  state: "open" | "resolved",
  page: { limit: number; cursor: string | null },
): Promise<Page<ReviewItemDto>> {
  const open = state === "open";
  const column = open ? "createdAt" : "resolvedAt";
  const cursor = page.cursor === null ? null : decodeCursor(page.cursor);
  const rows = await db.reviewItem.findMany({
    where: {
      state: open ? "open" : { in: ["resolved", "dismissed"] },
      ...(open ? {} : { resolvedAt: { not: null } }),
      ...(cursor === null
        ? {}
        : {
            OR: [{ [column]: { lt: cursor.at } }, { [column]: cursor.at, id: { lt: cursor.id } }],
          }),
    },
    orderBy: [{ [column]: "desc" }, { id: "desc" }],
    take: page.limit + 1,
    include: REVIEW_ITEM_INCLUDE,
  });
  const shown = rows.slice(0, page.limit);
  const last = shown.at(-1);
  const at = last === undefined ? null : open ? last.createdAt : last.resolvedAt;
  return {
    items: shown.map(toReviewItemDto),
    nextCursor: rows.length > page.limit && last && at ? encodeCursor(at, last.id) : null,
  };
}

// --- jobs to send after the commit ---------------------------------------------------------------

type Job = { name: QueueName; data?: Record<string, unknown>; singletonKey?: string };

/**
 * Sends the jobs a resolution queued, after its transaction committed. A send that fails is
 * logged by error name only: every stage has a sweep (triage and apply every minute, the resend
 * sweep for extraction) that picks the message up anyway.
 */
async function sendJobs(ctx: WorkerCtx, jobs: Job[]): Promise<void> {
  for (const job of jobs) {
    try {
      await ctx.queue.send(
        job.name,
        job.data,
        job.singletonKey === undefined ? undefined : { singletonKey: job.singletonKey },
      );
    } catch (error) {
      ctx.log.warn(
        { errorName: error instanceof Error ? error.name : "unknown", queue: job.name },
        "could not queue a job after a review decision; the sweep will pick the email up",
      );
    }
  }
}

// --- sending a message back through the pipeline ---------------------------------------------------

/** Open items a message going back through the pipeline makes obsolete. */
const SUPERSEDED_BY_REQUEUE: ReviewKind[] = [
  "extraction_failed",
  "low_confidence",
  "ambiguous_match",
  "unexpected_transition",
  "undone_change",
];

const IN_FLIGHT: GmailMessage["state"][] = ["discovered", "job_related", "extracted"];

/**
 * Puts a message back at the start of the stage that can redo its work, with the retry counters
 * and the `processed_at` heartbeat reset (otherwise the extract resend sweep would fail it again
 * without sending):
 * - `keepExtraction` and the stored extraction still parses → `extracted`, so the next apply
 *   drain plans it again (no model call);
 * - triage content is stored → `job_related`, so it is extracted again;
 * - otherwise → `discovered`, so it is triaged again.
 * A message already in one of those stages is left alone (it is being processed). Open items the
 * new run makes obsolete are closed, except `exceptItemId`. Returns the job to send.
 */
async function requeueMessage(
  tx: Tx,
  message: GmailMessage,
  now: Date,
  options: { exceptItemId?: string; keepExtraction?: boolean } = {},
): Promise<Job | null> {
  if (IN_FLIGHT.includes(message.state)) return null;
  const hasContent = [message.fromEmail, message.subject, message.snippet, message.bodyText].some(
    (value) => value !== null,
  );
  let state: "extracted" | "job_related" | "discovered";
  let job: Job;
  if (options.keepExtraction === true && parseStoredExtraction(message) !== null) {
    state = "extracted";
    job = { name: QUEUES.emailApply };
  } else if (hasContent) {
    state = "job_related";
    job = { name: QUEUES.emailExtract, data: { messageId: message.id }, singletonKey: message.id };
  } else {
    state = "discovered";
    job = { name: QUEUES.emailTriage };
  }
  const { count } = await tx.gmailMessage.updateMany({
    where: { id: message.id, state: message.state },
    data: { state, attempts: 0, lastError: null, processedAt: state === "discovered" ? null : now },
  });
  if (count === 0) return null;
  await tx.reviewItem.updateMany({
    where: {
      messageId: message.id,
      state: "open",
      kind: { in: SUPERSEDED_BY_REQUEUE },
      ...(options.exceptItemId === undefined ? {} : { id: { not: options.exceptItemId } }),
    },
    data: {
      state: "resolved",
      resolvedAt: now,
      resolution: { action: "reprocess", by: "owner", at: now.toISOString() },
    },
  });
  return job;
}

/**
 * `POST /messages/:id/reprocess`: sends the email back through the pipeline (see
 * {@link requeueMessage}) and queues the stage's job. Answers 404 for an unknown email. An email
 * that is already being processed is left as it is.
 */
export async function reprocessMessage(ctx: WorkerCtx, id: string): Promise<void> {
  const job = await withIntakeLock(ctx.prisma, async (tx) => {
    const message = await tx.gmailMessage.findUnique({ where: { id } });
    if (message === null) throw notFound("email");
    return requeueMessage(tx, message, ctx.clock());
  });
  if (job !== null) await sendJobs(ctx, [job]);
}

// --- one email ---------------------------------------------------------------------------------

/** `GET /messages/:id` (AC-6.2): the email with its stored plain-text body. Never HTML. */
export async function getMessageDetail(db: Db, id: string): Promise<MessageDetail> {
  const message = await db.gmailMessage.findUnique({ where: { id } });
  if (message === null) throw notFound("email");
  return {
    id: message.id,
    internalDate: message.internalDate.toISOString(),
    direction: message.direction,
    fromName: message.fromName,
    fromEmail: message.fromEmail,
    subject: message.subject,
    summary: message.summary,
    category: message.category,
    bodyText: message.bodyText,
    toEmails: message.toEmails ?? [],
  };
}

// --- resolving an item ---------------------------------------------------------------------------

type Action = ReviewResolve["action"];

/** AC-5.2: the actions each kind offers. */
const ACTIONS: Record<ReviewKind, readonly Action[]> = {
  low_confidence: ["apply", "edit_apply", "dismiss"],
  ambiguous_match: ["attach", "create_new", "dismiss"],
  unexpected_transition: ["reopen", "timeline_only"],
  possible_duplicate_company: ["merge", "same_group", "keep_separate"],
  extraction_failed: ["retry", "dismiss"],
  undone_change: ["reprocess", "ignore"],
};

const invalid = (message: string, field: string, reason: string) =>
  new ApiError(400, "validation_failed", message, { [field]: reason });

/**
 * Edit and apply is limited to the category and the job link: a review item carries no
 * extraction, so those are the two fields the owner can see and correct.
 */
function editsOf(body: ReviewResolve): Partial<Extraction> {
  const edits = body.edits;
  if (edits === undefined || Object.keys(edits).length === 0) {
    throw invalid("Choose what to change.", "edits", "required");
  }
  const allowed = new Set(["category", "jobUrl"]);
  const extra = Object.keys(edits).find((key) => !allowed.has(key));
  if (extra !== undefined) {
    throw invalid(
      "Only the category and the job link can be changed.",
      `edits.${extra}`,
      "not_editable",
    );
  }
  return {
    ...(edits.category === undefined ? {} : { category: edits.category }),
    ...(edits.jobUrl === undefined ? {} : { jobUrl: edits.jobUrl }),
  };
}

type Item = Prisma.ReviewItemGetPayload<{
  include: { message: true; company: { select: { name: true } } };
}>;

/** How an action ended: the item is done with this state, or it stays open with a new question. */
type Outcome =
  { done: "resolved" | "dismissed"; resolution?: Record<string, unknown> } | { done: "open" };

/** Plans the held email again with the owner's choice and runs it (AC-5.3). */
async function applyChoice(
  ctx: WorkerCtx,
  tx: Tx,
  item: Item,
  choice: OwnerChoice,
  now: Date,
  after: { leadChecks: LeadChecks[] },
): Promise<Outcome> {
  const message = item.message;
  if (message === null || message.state !== "needs_review") {
    throw changedSince("This email was handled elsewhere.");
  }
  const extraction = parseStoredExtraction(message);
  if (extraction === null) {
    throw changedSince("This email can't be applied any more. Reprocess it instead.");
  }
  const planMessage = toPlanMessage(message);
  const settings = await getSettings(tx);
  const snapshot = await loadPlanSnapshot(tx, planMessage, extraction, ctx.env.userTimezone);
  const plan = planChanges(
    snapshot,
    planMessage,
    extraction,
    { autoApplyMinConfidence: settings.automation.autoApplyMinConfidence },
    choice,
  );

  if (!plan.autoApply || plan.review !== null) {
    // The choice raised another question (the owner's pick does not settle every condition):
    // the same item stays open and asks it.
    const { review } = plan;
    if (review === null) throw new Error("The planner left a plan unapplied without a review");
    const clash = await tx.reviewItem.findFirst({
      where: { messageId: message.id, kind: review.kind, state: "open", id: { not: item.id } },
      select: { id: true },
    });
    if (clash !== null) return { done: "resolved", resolution: { supersededBy: clash.id } };
    await tx.reviewItem.update({
      where: { id: item.id },
      data: {
        kind: review.kind,
        confidence: plan.confidence,
        plan: JSON.parse(JSON.stringify(plan)) as Prisma.InputJsonValue,
        candidates: review.candidates,
        reasons: review.reasons,
      },
    });
    return { done: "open" };
  }

  if (plan.messageOutcome === "triaged_out") {
    await tx.gmailMessage.updateMany({
      where: { id: message.id, state: "needs_review" },
      data: { ...NO_CONTENT, state: "triaged_out", processedAt: now, lastError: null },
    });
    return { done: "resolved" };
  }

  // The plan is made against this transaction's snapshot; the executor's version checks catch an
  // owner edit (which takes no lock) that landed since.
  const { refs, leadChecks } = await executePlan(tx, plan, {
    messageId: message.id,
    occurredAt: message.internalDate,
    actor: "system",
    settings,
  });
  await openNoticeItems(tx, message.id, plan, refs);
  await tx.gmailMessage.updateMany({
    where: { id: message.id, state: "needs_review" },
    data: { state: "applied", processedAt: now, lastError: null },
  });
  after.leadChecks.push(...leadChecks);
  return { done: "resolved" };
}

/** *Dismiss*: nothing changes, and the email stops waiting for a decision. */
async function dismissItem(tx: Tx, item: Item, now: Date): Promise<Outcome> {
  if (item.message?.state === "needs_review") {
    await tx.gmailMessage.updateMany({
      where: { id: item.message.id, state: "needs_review" },
      data: { state: "applied", processedAt: now },
    });
  }
  return { done: "dismissed" };
}

/** The company this duplicate notice is about, and the existing company it may be the same as. */
async function duplicatePair(tx: Tx, item: Item) {
  const candidateId = (Array.isArray(item.candidates) ? item.candidates : [])
    .map((c) => (c as { id?: unknown } | null)?.id)
    .find((id): id is string => typeof id === "string");
  if (item.companyId === null || candidateId === undefined) {
    throw changedSince("These companies changed. Nothing was merged.");
  }
  const [company, other] = await Promise.all([
    tx.company.findUnique({ where: { id: item.companyId } }),
    tx.company.findUnique({ where: { id: candidateId } }),
  ]);
  if (company === null || other === null) {
    throw changedSince("These companies changed. Nothing was merged.");
  }
  return { company, other };
}

/** *Same group*: the company joins the other company's group, one level deep. */
async function joinGroup(tx: Tx, companyId: string, otherId: string, now: Date): Promise<void> {
  const [company, other] = await Promise.all([
    tx.company.findUniqueOrThrow({ where: { id: companyId } }),
    tx.company.findUniqueOrThrow({ where: { id: otherId } }),
  ]);
  const root = other.groupId ?? other.id;
  // Already together: the other company is a member of this one's group, or they share a root.
  if (root === company.id || company.groupId === root) return;
  await tx.company.updateMany({
    where: { groupId: company.id },
    data: { groupId: root },
  });
  await tx.company.update({
    where: { id: company.id },
    data: { groupId: root, updatedAt: now, version: { increment: 1 } },
  });
}

async function runAction(
  ctx: WorkerCtx,
  tx: Tx,
  item: Item,
  body: ReviewResolve,
  now: Date,
  after: { leadChecks: LeadChecks[]; jobs: Job[] },
): Promise<Outcome> {
  switch (body.action) {
    case "apply":
      return applyChoice(ctx, tx, item, { action: "apply" }, now, after);
    case "edit_apply":
      return applyChoice(ctx, tx, item, { action: "edit_apply", edits: editsOf(body) }, now, after);
    case "create_new":
      return applyChoice(ctx, tx, item, { action: "create_new" }, now, after);
    case "reopen":
      return applyChoice(ctx, tx, item, { action: "reopen" }, now, after);
    case "timeline_only":
      return applyChoice(ctx, tx, item, { action: "timeline_only" }, now, after);
    case "attach": {
      const applicationId = body.applicationId;
      if (applicationId === undefined || !UUID.test(applicationId)) {
        throw invalid(
          "Choose the application to attach the email to.",
          "applicationId",
          "required",
        );
      }
      const application = await tx.application.findUnique({
        where: { id: applicationId },
        select: { id: true },
      });
      if (application === null) {
        throw invalid("That application doesn't exist.", "applicationId", "not_found");
      }
      return applyChoice(ctx, tx, item, { action: "attach", applicationId }, now, after);
    }
    case "dismiss":
      return dismissItem(tx, item, now);
    case "merge": {
      const { company, other } = await duplicatePair(tx, item);
      await mergeCompanies(tx, company.id, other.id);
      return { done: "resolved", resolution: { companyId: other.id } };
    }
    case "same_group": {
      const { company, other } = await duplicatePair(tx, item);
      await joinGroup(tx, company.id, other.id, now);
      return { done: "resolved", resolution: { companyId: other.id } };
    }
    case "keep_separate":
      return { done: "resolved" };
    case "retry":
    case "reprocess": {
      const message = item.message;
      if (message === null) throw changedSince("This email is no longer here.");
      if (body.action === "retry" && message.state !== "failed") {
        throw changedSince("This email was handled elsewhere.");
      }
      // An email whose records could not be written keeps its extraction: only the apply stage
      // runs again. Any other failure is read again.
      const job = await requeueMessage(tx, message, now, {
        exceptItemId: item.id,
        keepExtraction: body.action === "retry" && item.reasons.includes(APPLY_FAILED),
      });
      if (job !== null) after.jobs.push(job);
      return { done: "resolved" };
    }
    case "ignore":
      return { done: "resolved" };
  }
}

/**
 * Resolves one review item with the owner's choice (AC-5.2, AC-5.3) and returns the item as it
 * is afterwards. Normally it is `resolved` or `dismissed`; when the owner's choice raises another
 * question (for example *Apply* on a low-confidence change that also needs a status decision) it
 * stays `open` with the new question.
 */
export async function resolveReviewItem(
  ctx: WorkerCtx,
  id: string,
  body: ReviewResolve,
): Promise<ReviewItemDto> {
  if (!UUID.test(id)) throw notFound("review item");
  const after: { leadChecks: LeadChecks[]; jobs: Job[] } = { leadChecks: [], jobs: [] };
  let result: ReviewItemDto;
  try {
    result = await withIntakeLock(ctx.prisma, async (tx) => {
      const item = await tx.reviewItem.findUnique({
        where: { id },
        include: { message: true, company: { select: { name: true } } },
      });
      if (item === null) throw notFound("review item");
      if (item.state !== "open") throw changedSince("This item was already decided.");
      if (!ACTIONS[item.kind].includes(body.action)) {
        throw invalid("That choice isn't available for this item.", "action", "not_allowed");
      }
      const now = ctx.clock();
      const outcome = await runAction(ctx, tx, item, body, now, after);
      if (outcome.done !== "open") {
        await tx.reviewItem.update({
          where: { id },
          data: {
            state: outcome.done,
            resolvedAt: now,
            resolution: {
              action: body.action,
              by: "owner",
              at: now.toISOString(),
              ...(body.action === "attach" && body.applicationId !== undefined
                ? { applicationId: body.applicationId }
                : {}),
              ...(body.action === "edit_apply" && body.edits !== undefined
                ? { edits: body.edits }
                : {}),
              ...outcome.resolution,
            },
          },
        });
      }
      const fresh = await tx.reviewItem.findUniqueOrThrow({
        where: { id },
        include: REVIEW_ITEM_INCLUDE,
      });
      return toReviewItemDto(fresh);
    });
  } catch (error) {
    if (!(error instanceof VersionConflictError)) throw error;
    // An owner edit landed while the change was written; nothing was kept. The caller refreshes
    // from the item as it stands.
    const fresh = await ctx.prisma.reviewItem.findUniqueOrThrow({
      where: { id },
      include: REVIEW_ITEM_INCLUDE,
    });
    throw new ConflictWithCurrent(
      toReviewItemDto(fresh),
      "A record changed while this was being applied. Nothing was changed.",
    );
  }
  await sendLeadChecks(ctx, after.leadChecks);
  await sendJobs(ctx, after.jobs);
  return result;
}
