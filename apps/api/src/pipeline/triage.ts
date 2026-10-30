import { Prisma, type PrismaClient } from "@prisma/client";
import type { MessageMetadata, TriageItem } from "@offerbound/contracts";
import {
  bareAddress,
  localMidnightUtc,
  triageByRules,
  type TriageDecision,
  type TriageLookups,
} from "@offerbound/domain";
import type { WorkerCtx } from "../deps.js";
import { withIntakeLock } from "../db/lock.js";
import { GmailMessageNotFoundError, GmailRequestError } from "../gmail/client.js";
import { QUEUES } from "../jobs/queues.js";
import { toTriageInput } from "../llm/inputs.js";
import { LlmError } from "../llm/provider.js";
import { getSettings } from "../settings/service.js";
import { gmailAuthIsLost, markExtractionFailed } from "./failure.js";

/**
 * The triage stage (TECHNICAL_SPEC §5.1, §5.3, §5.4; AC-3.1 to AC-3.5). A batch of up to 25
 * `discovered` messages is read from Gmail (metadata only), decided by the rules where they can,
 * and the rest go to the LLM as sender, subject and preview. Every decision is written in one
 * transaction under the intake lock; a message that is triaged out or skipped keeps no content.
 *
 * Nothing here logs ids of senders, subjects, addresses or previews: only message counts and
 * error names.
 */

type Db = PrismaClient | Prisma.TransactionClient;
type Row = { id: string };

export const TRIAGE_BATCH_SIZE = 25;
/** The fifth failed attempt makes a message `failed` (§5.4). */
export const MAX_TRIAGE_ATTEMPTS = 5;
/** `jobRelated = false` below this confidence still goes to extraction: recall first (§5.4). */
export const EXTRACT_BELOW_CONFIDENCE = 0.7;
/** How many stuck `job_related` messages one sweep sends to extraction again. */
const RESEND_LIMIT = 100;
/**
 * A `job_related` message is sent to extraction again only once it has waited this long since its
 * `processed_at`. The extract handler stamps `processed_at` at the start of every attempt and,
 * when it defers for a Gmail `Retry-After`, sets it to the deferred job's due time. A live chain
 * (running, backing off 30 to 240 s, or deferred) therefore never looks stale, so a message still
 * waiting after this had its job lost, and a resend cannot start a second chain beside a live one.
 */
export const EXTRACT_RESEND_AFTER_MS = 10 * 60_000;
/**
 * After this many resends a message is failed with a review item: something about it keeps
 * killing its jobs (a crash, a hang) and no handler ever got the chance to fail it.
 */
export const MAX_EXTRACT_RESENDS = 5;

/** What the rules compare a message against: linked threads, contacts, company domains, ignore list. */
export async function loadTriageLookups(db: Db): Promise<TriageLookups> {
  const [links, contacts, companies, settings] = await Promise.all([
    db.threadLink.findMany({ select: { threadId: true } }),
    db.contact.findMany({ select: { email: true } }),
    db.company.findMany({ select: { domains: true } }),
    getSettings(db),
  ]);
  return {
    linkedThreadIds: new Set(links.map((link) => link.threadId)),
    contactEmails: new Set(contacts.map((contact) => contact.email)),
    companyDomains: new Set(companies.flatMap((company) => company.domains)),
    ignoreList: settings.automation.senderIgnoreList,
  };
}

// ---------------------------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------------------------

/** Every content column, cleared (DATA_MODEL §3.6: skipped and triaged_out rows keep none). */
export const NO_CONTENT = {
  fromEmail: null,
  fromName: null,
  toEmails: [] as string[],
  subject: null,
  snippet: null,
  bodyText: null,
  summary: null,
  extraction: Prisma.DbNull,
  icsEvents: Prisma.DbNull,
  category: null,
  extractConfidence: null,
};

type Decided = {
  kind: "decided";
  row: Row;
  meta: MessageMetadata;
  state: "skipped" | "triaged_out" | "job_related";
  method: "rule" | "llm";
  rule: TriageDecision["rule"];
  direction: "inbound" | "outbound";
  confidence: number | null;
};
/** Gmail has no such message any more (deleted between listing and fetching). */
type Gone = { kind: "gone"; row: Row };
/**
 * An attempt that did not decide the message. `meta` is known when Gmail answered. `fatal` marks
 * a request the model rejected (400): retrying cannot help, so the message fails at once (§13).
 */
type Failed = {
  kind: "failed";
  row: Row;
  meta: MessageMetadata | null;
  code: string;
  fatal: boolean;
};
type Outcome = Decided | Gone | Failed;

/** Real values from Gmail for the columns sync discovery filled with placeholders. */
function metadataColumns(meta: MessageMetadata, direction: "inbound" | "outbound") {
  return { internalDate: meta.internalDate, direction, labelIds: meta.labelIds };
}

function directionOf(meta: MessageMetadata): "inbound" | "outbound" {
  return meta.labelIds.includes("SENT") ? "outbound" : "inbound";
}

async function writeDecided(tx: Prisma.TransactionClient, d: Decided, now: Date): Promise<boolean> {
  const common = {
    ...metadataColumns(d.meta, d.direction),
    state: d.state,
    triageMethod: d.method,
    triageRule: d.rule,
    triageConfidence: d.confidence,
    lastError: null,
    processedAt: now,
  };
  const content =
    d.state === "job_related"
      ? {
          fromEmail: d.meta.headers.fromEmail,
          fromName: d.meta.headers.fromName,
          toEmails: d.meta.headers.to.map(bareAddress).filter((address) => address !== ""),
          subject: d.meta.headers.subject,
          snippet: d.meta.snippet,
          // Triage attempts do not count against extraction: its resend count starts at zero.
          attempts: 0,
        }
      : NO_CONTENT;
  const { count } = await tx.gmailMessage.updateMany({
    where: { id: d.row.id, state: "discovered" },
    data: { ...common, ...content },
  });
  return count > 0;
}

/** Skipped for good: there is nothing to read, so nothing to retry. No rule decided it. */
async function writeGone(tx: Prisma.TransactionClient, g: Gone, now: Date): Promise<boolean> {
  const { count } = await tx.gmailMessage.updateMany({
    where: { id: g.row.id, state: "discovered" },
    data: {
      ...NO_CONTENT,
      state: "skipped",
      lastError: "gmail_message_not_found",
      processedAt: now,
    },
  });
  return count > 0;
}

/**
 * Counts one failed attempt. The message stays `discovered` (and keeps holding the apply
 * watermark with its placeholder date) until the fifth failure, or the first one the model
 * rejects for good (§13: a 400 is not retried). That marks it `failed` and opens an *Extraction
 * failed* review item. Returns whether the message left `discovered`.
 *
 * The count is incremented in the database, so concurrent sweeps cannot overwrite each other's
 * attempts, and the fifth attempt is recognised from the stored value, not the one read when the
 * batch started.
 */
async function writeFailed(tx: Prisma.TransactionClient, f: Failed, now: Date): Promise<boolean> {
  const counted = await tx.gmailMessage.updateMany({
    where: { id: f.row.id, state: "discovered" },
    data: { attempts: { increment: 1 }, lastError: f.code },
  });
  if (counted.count === 0) return false;
  const { count } = await tx.gmailMessage.updateMany({
    where: {
      id: f.row.id,
      state: "discovered",
      ...(f.fatal ? {} : { attempts: { gte: MAX_TRIAGE_ATTEMPTS } }),
    },
    data: {
      ...(f.meta ? metadataColumns(f.meta, directionOf(f.meta)) : {}),
      ...NO_CONTENT,
      state: "failed",
      processedAt: now,
    },
  });
  if (count === 0) return false;
  await tx.reviewItem.createMany({
    data: [{ kind: "extraction_failed", messageId: f.row.id, reasons: ["triage_failed"] }],
    skipDuplicates: true,
  });
  return true;
}

// ---------------------------------------------------------------------------------------------
// The stage
// ---------------------------------------------------------------------------------------------

/** Maps the LLM's verdict to a state (§5.4): job-related, or not job-related with confidence. */
function llmState(item: TriageItem): "job_related" | "triaged_out" {
  return item.jobRelated || item.confidence < EXTRACT_BELOW_CONFIDENCE
    ? "job_related"
    : "triaged_out";
}

/** Short, content-free error text for `last_error`. */
function llmErrorCode(error: unknown): string {
  return error instanceof LlmError ? `llm_${error.code}` : "llm_error";
}

/**
 * Only a rejected request (400, code `bad_request`) is not retried (§13). Every other model
 * error (429, 5xx, timeouts, unusable or incomplete output) counts as an ordinary attempt.
 */
function isFatalLlmError(error: unknown): boolean {
  return error instanceof LlmError && error.code === "bad_request";
}

/**
 * Triages up to {@link TRIAGE_BATCH_SIZE} `discovered` messages, oldest first, and sends
 * `email.extract` (key = message id) for each that is job-related. Returns how many messages left
 * `discovered`.
 *
 * Failures:
 * - The LLM fails, or leaves a message out of its answer: each undecided message gets one failed
 *   attempt. Messages the rules decided are written anyway. The next 1-minute sweep retries. A
 *   rejected request (`bad_request`) fails them at once instead (§13).
 * - Gmail has no such message: skipped for good.
 * - Gmail refuses a message (400/403, not retried by the client): a failed attempt, as above.
 * - Gmail is rate limited, unreachable or the authorization is gone, or anything unexpected
 *   happens: the messages fetched so far are still decided and written, no attempt is counted,
 *   and the error is rethrown for the job handler (`Retry-After`, backoff, unscheduling).
 */
export async function runTriageBatch(ctx: WorkerCtx): Promise<{ processed: number }> {
  const { prisma, env, queue } = ctx;

  const rows: Row[] = await prisma.gmailMessage.findMany({
    where: { state: "discovered" },
    // Placeholder rows share the epoch date, so discovery order breaks the tie.
    orderBy: [{ internalDate: "asc" }, { discoveredAt: "asc" }, { id: "asc" }],
    take: TRIAGE_BATCH_SIZE,
    select: { id: true },
  });
  if (rows.length === 0) return { processed: 0 };

  const client = await ctx.gmail();
  const outcomes: Outcome[] = [];
  const fetched: { row: Row; meta: MessageMetadata }[] = [];
  let abort: { error: unknown } | null = null;
  for (const row of rows) {
    try {
      fetched.push({ row, meta: await client.getMetadata(row.id) });
    } catch (error) {
      if (error instanceof GmailMessageNotFoundError) {
        outcomes.push({ kind: "gone", row });
      } else if (error instanceof GmailRequestError) {
        outcomes.push({
          kind: "failed",
          row,
          meta: null,
          code: "gmail_request_failed",
          fatal: false,
        });
      } else {
        abort = { error };
        break;
      }
    }
  }

  // Stage 1a: the rules, on the real date, direction and labels from Gmail.
  const lookups = await loadTriageLookups(prisma);
  const backfillSince = localMidnightUtc(env.gmailBackfillSince, env.userTimezone);
  const undecided: { row: Row; meta: MessageMetadata; direction: "inbound" | "outbound" }[] = [];
  for (const { row, meta } of fetched) {
    const decision = triageByRules(
      {
        labelIds: meta.labelIds,
        internalDate: meta.internalDate,
        backfillSince,
        threadId: meta.threadId,
        from: meta.headers.from,
        to: meta.headers.to,
        cc: meta.headers.cc,
        ownerEmail: env.ownerEmail,
      },
      lookups,
    );
    if (decision.decision === "llm") {
      undecided.push({ row, meta, direction: decision.direction });
    } else {
      outcomes.push({
        kind: "decided",
        row,
        meta,
        state: decision.decision,
        method: "rule",
        rule: decision.rule,
        direction: decision.direction,
        confidence: null,
      });
    }
  }

  // Stage 1b: one LLM call for everything the rules left open. Sender, subject and preview only.
  if (undecided.length > 0) {
    let verdicts: Map<string, TriageItem> | null = null;
    let failure = "llm_error";
    let fatal = false;
    try {
      const { output } = await ctx.llm.triage(undecided.map(({ meta }) => toTriageInput(meta)));
      verdicts = new Map();
      for (const item of output.results) if (!verdicts.has(item.id)) verdicts.set(item.id, item);
    } catch (error) {
      failure = llmErrorCode(error);
      fatal = isFatalLlmError(error);
      ctx.log.warn(
        { errorName: error instanceof Error ? error.name : "unknown", messages: undecided.length },
        "llm triage failed",
      );
    }
    for (const { row, meta, direction } of undecided) {
      const item = verdicts?.get(row.id);
      if (item === undefined) {
        const code = verdicts === null ? failure : "llm_missing_result";
        outcomes.push({ kind: "failed", row, meta, code, fatal: verdicts === null && fatal });
        continue;
      }
      outcomes.push({
        kind: "decided",
        row,
        meta,
        state: llmState(item),
        method: "llm",
        rule: "R9",
        direction,
        confidence: item.confidence,
      });
    }
  }

  // One transaction, under the intake lock. A message another run already moved on is left alone.
  const now = ctx.clock();
  const extract: string[] = [];
  let processed = 0;
  await withIntakeLock(prisma, async (tx) => {
    for (const outcome of outcomes) {
      let left: boolean;
      if (outcome.kind === "decided") {
        left = await writeDecided(tx, outcome, now);
        if (left && outcome.state === "job_related") extract.push(outcome.row.id);
      } else if (outcome.kind === "gone") {
        left = await writeGone(tx, outcome, now);
      } else {
        left = await writeFailed(tx, outcome, now);
      }
      if (left) processed += 1;
    }
  });

  // After the commit. A send lost here is repeated by `resendPendingExtractions` on the next
  // sweep, because the message is no longer `discovered` and would not be picked up again.
  let sendError: { error: unknown } | null = null;
  for (const messageId of extract) {
    try {
      await queue.send(QUEUES.emailExtract, { messageId }, { singletonKey: messageId });
    } catch (error) {
      sendError ??= { error };
    }
  }
  if (sendError) throw sendError.error;
  if (abort) throw abort.error;
  return { processed };
}

/**
 * Sends `email.extract` again for messages that are still `job_related` and have waited
 * {@link EXTRACT_RESEND_AFTER_MS}: a send was lost after the triage commit, or the job was lost
 * (a worker crash). `attempts` counts the resends; a message past {@link MAX_EXTRACT_RESENDS} is
 * failed with an *Extraction failed* review item instead of being sent for ever. Nothing is sent
 * while the Gmail authorization is lost, since every job would fail the same way. The queue's key
 * (message id) keeps duplicates from piling up, and extraction ignores a message that is no longer
 * `job_related`. Returns how many were sent.
 */
export async function resendPendingExtractions(ctx: WorkerCtx): Promise<number> {
  const { prisma, queue } = ctx;
  if (await gmailAuthIsLost(prisma)) return 0;
  const now = ctx.clock();
  const rows = await prisma.gmailMessage.findMany({
    where: {
      state: "job_related",
      OR: [
        { processedAt: null },
        { processedAt: { lt: new Date(now.getTime() - EXTRACT_RESEND_AFTER_MS) } },
      ],
    },
    orderBy: [{ internalDate: "asc" }, { id: "asc" }],
    take: RESEND_LIMIT,
    select: { id: true, attempts: true, processedAt: true },
  });
  let sent = 0;
  for (const { id, attempts, processedAt } of rows) {
    if (attempts >= MAX_EXTRACT_RESENDS) {
      await markExtractionFailed(ctx, id, "extract_resend_limit");
      continue;
    }
    // Counted before the send, so a crash between the two cannot make the loop endless.
    const { count } = await prisma.gmailMessage.updateMany({
      where: { id, state: "job_related" },
      data: { attempts: { increment: 1 }, processedAt: now },
    });
    if (count === 0) continue;
    try {
      await queue.send(QUEUES.emailExtract, { messageId: id }, { singletonKey: id });
    } catch (error) {
      // Nothing was sent, so nothing was resent: give the count and the wait back.
      await prisma.gmailMessage.updateMany({
        where: { id, state: "job_related" },
        data: { attempts: { decrement: 1 }, processedAt },
      });
      throw error;
    }
    sent += 1;
  }
  return sent;
}
