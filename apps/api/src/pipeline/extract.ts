import {
  clampExtraction,
  type Extraction,
  type IcsEvent,
  type MessageMetadata,
} from "@offerbound/contracts";
import type { WorkerCtx } from "../deps.js";
import { withIntakeLock } from "../db/lock.js";
import { GmailMessageNotFoundError, GmailRequestError } from "../gmail/client.js";
import { stripQuotedHistory } from "../gmail/dequote.js";
import { parseFullMessage } from "../gmail/mime.js";
import { QUEUES } from "../jobs/queues.js";
import { toExtractInput } from "../llm/inputs.js";
import { LlmError, type ExtractInput } from "../llm/provider.js";
import { markExtractionFailed } from "./failure.js";
import { NO_CONTENT } from "./triage.js";

export { markExtractionFailed };

/**
 * The extraction stage (TECHNICAL_SPEC §5.5, §8.3, §13; AC-3.6, AC-3.7). For one `job_related`
 * message it reads the full message from Gmail, takes the plain text (de-quoted, at most 15,000
 * characters) and the calendar events, asks the model for a structured `Extraction`, and stores
 * all of it in one guarded update: state `extracted`, then `email.apply` is queued.
 *
 * The email is untrusted input. It reaches the model only as data fields of `ExtractInput`, in a
 * body capped at 15,000 characters and calendar fields capped in length, and what comes back must
 * pass the strict schema. Calendar times are *not* merged into the extraction here: the apply
 * stage prefers the calendar's start, end, location and link, and ignores a null start or end
 * (an unknown TZID) so the model's time stays. Nothing here logs subjects, addresses, bodies or
 * model output; only error names and codes are written to `last_error`.
 *
 * Failures:
 * - The model's output is invalid: asked once more with the validation error as `previousError`;
 *   a second invalid answer fails the message with an *Extraction failed* review item (AC-3.6).
 * - The model rejects the request (400, `bad_request`): fails at once (§13).
 * - Any other model error (429, 5xx, timeouts, `incomplete` answers), Gmail 429/5xx, lost
 *   authorization or anything unexpected: rethrown, so the
 *   job handler can defer for `Retry-After`, stop the sync schedule, or let pg-boss retry (4
 *   retries, base 30 s). When the last retry fails, the handler calls {@link markExtractionFailed}.
 * - Gmail has no such message, or refuses the request: skipped, respectively failed, at once.
 */

/** Longest `previousError` handed back to the model. */
const MAX_PREVIOUS_ERROR_CHARS = 1_000;
/** Calendar text is untrusted and unbounded (up to 256 KB of file): each field is cut for the model. */
const MAX_ICS_FIELD_CHARS = 1_000;

const capText = (value: string | null): string | null =>
  value === null ? null : value.slice(0, MAX_ICS_FIELD_CHARS);

/** What the model sees of the calendar: the stored events, with every text field cut short. */
function icsForModel(events: IcsEvent[]): IcsEvent[] {
  return events.map((event) => ({
    ...event,
    uid: capText(event.uid),
    timezone: capText(event.timezone),
    summary: capText(event.summary),
    location: capText(event.location),
    url: capText(event.url),
    descriptionLink: capText(event.descriptionLink),
    organizer: capText(event.organizer),
  }));
}

type ExtractResult =
  | { kind: "extracted"; extraction: Extraction }
  /** A failure no retry fixes; `code` goes to `last_error`. */
  | { kind: "failed"; code: string };

/** Calls the model; an invalid answer gets exactly one more try, with the reason attached. */
async function askModel(
  ctx: WorkerCtx,
  input: ExtractInput,
  messageId: string,
): Promise<ExtractResult> {
  let previousError: string | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const { output } = await ctx.llm.extract({ ...input, previousError }, { messageId });
      return { kind: "extracted", extraction: clampExtraction(output) };
    } catch (error) {
      if (!(error instanceof LlmError)) throw error;
      if (error.code === "invalid_output") {
        if (attempt === 0) {
          previousError = error.message.slice(0, MAX_PREVIOUS_ERROR_CHARS);
          continue;
        }
        return { kind: "failed", code: "llm_invalid_output" };
      }
      // Only a rejected request (400) is not retried (§13). 429, 5xx, timeouts and incomplete
      // answers are retried by the queue, and the handler fails the message when retries run out.
      if (error.code === "bad_request") return { kind: "failed", code: "llm_bad_request" };
      throw error;
    }
  }
  return { kind: "failed", code: "llm_invalid_output" };
}

/** Gmail no longer has the message: nothing to read, nothing to keep (AC-3.5). */
async function markGone(ctx: WorkerCtx, messageId: string): Promise<void> {
  const now = ctx.clock();
  await withIntakeLock(ctx.prisma, (tx) =>
    tx.gmailMessage.updateMany({
      where: { id: messageId, state: "job_related" },
      data: {
        ...NO_CONTENT,
        state: "skipped",
        lastError: "gmail_message_not_found",
        processedAt: now,
      },
    }),
  );
}

/**
 * Extracts one message. Does nothing unless its state is `job_related`, so a duplicate delivery,
 * a resend or a message another worker finished is harmless.
 */
export async function runExtract(ctx: WorkerCtx, messageId: string): Promise<void> {
  const { prisma, env, queue } = ctx;

  const row = await prisma.gmailMessage.findUnique({
    where: { id: messageId },
    select: {
      state: true,
      threadId: true,
      internalDate: true,
      labelIds: true,
      snippet: true,
    },
  });
  if (row?.state !== "job_related") return;

  let parsed: ReturnType<typeof parseFullMessage>;
  try {
    const client = await ctx.gmail();
    parsed = parseFullMessage(await client.getFull(messageId));
  } catch (error) {
    if (error instanceof GmailMessageNotFoundError) return markGone(ctx, messageId);
    if (error instanceof GmailRequestError) {
      return markExtractionFailed(ctx, messageId, "gmail_request_failed");
    }
    throw error;
  }

  const body = stripQuotedHistory(parsed.textBody);
  const meta: MessageMetadata = {
    id: messageId,
    threadId: row.threadId,
    internalDate: row.internalDate,
    labelIds: row.labelIds,
    snippet: row.snippet ?? "",
    headers: parsed.headers,
  };
  const input = toExtractInput(
    meta,
    { ...parsed, icsEvents: icsForModel(parsed.icsEvents) },
    body,
    env.userTimezone,
  );

  const result = await askModel(ctx, input, messageId);
  if (result.kind === "failed") return markExtractionFailed(ctx, messageId, result.code);

  const { extraction } = result;
  const now = ctx.clock();
  const written = await withIntakeLock(prisma, async (tx) => {
    const { count } = await tx.gmailMessage.updateMany({
      where: { id: messageId, state: "job_related" },
      data: {
        state: "extracted",
        bodyText: body,
        icsEvents: parsed.icsEvents,
        extraction: extraction,
        category: extraction.category,
        extractConfidence: extraction.confidence,
        summary: extraction.summary,
        lastError: null,
        processedAt: now,
      },
    });
    return count > 0;
  });
  if (!written) return;

  // After the commit. A send lost here is covered by the 1-minute apply sweep (§5.6).
  try {
    await queue.send(QUEUES.emailApply);
  } catch (error) {
    ctx.log.warn(
      { errorName: error instanceof Error ? error.name : "unknown" },
      "could not queue email.apply; the sweep will apply the message",
    );
  }
}
