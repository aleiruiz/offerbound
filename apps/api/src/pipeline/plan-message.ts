import type { GmailMessage, Prisma } from "@prisma/client";
import { ExtractionSchema, IcsEventSchema, type Extraction } from "@offerbound/contracts";
import type { ChangePlan, PlanMessage } from "@offerbound/domain";
import { z } from "zod";
import { createReviewItem } from "../review/create.js";

/**
 * What the apply stage and review resolution share about a stored message: the planner's view of
 * it, its stored extraction, and the review items an executed plan's notices open.
 */

const IcsEventsSchema = z.array(IcsEventSchema);

/** The planner's view of a stored message. Calendar events that no longer parse are ignored. */
export function toPlanMessage(message: GmailMessage): PlanMessage {
  const ics = IcsEventsSchema.safeParse(message.icsEvents ?? []);
  return {
    id: message.id,
    threadId: message.threadId,
    internalDate: message.internalDate,
    direction: message.direction,
    fromEmail: message.fromEmail,
    icsEvents: ics.success ? ics.data : [],
  };
}

/** The stored extraction, or null when there is none or it no longer parses. */
export function parseStoredExtraction(
  message: Pick<GmailMessage, "extraction">,
): Extraction | null {
  const parsed = ExtractionSchema.safeParse(message.extraction);
  return parsed.success ? parsed.data : null;
}

function describeNotice(names: string[]): string {
  return names.length === 0
    ? "A company with a similar name already exists"
    : `Might be the same company as ${names.join(", ")}`;
}

/**
 * Opens a *Possible duplicate company* item for each notice of an executed plan. The change
 * already applied; the notice only asks the owner whether the companies are one.
 */
export async function openNoticeItems(
  tx: Prisma.TransactionClient,
  messageId: string,
  plan: ChangePlan,
  refs: Record<string, string>,
): Promise<void> {
  for (const notice of plan.notices) {
    const companyId = "id" in notice.company ? notice.company.id : refs[notice.company.ref];
    await createReviewItem(tx, {
      kind: notice.kind,
      messageId,
      ...(companyId === undefined ? {} : { companyId }),
      confidence: null,
      plan: null,
      candidates: notice.candidates,
      reasons: [describeNotice(notice.candidates.map((c) => c.label))],
    });
  }
}
