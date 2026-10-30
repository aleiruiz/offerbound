import { Prisma, type ReviewKind } from "@prisma/client";
import type { Candidate, ChangePlan } from "@offerbound/domain";

export type NewReviewItem = {
  kind: ReviewKind;
  messageId: string | null;
  applicationId?: string;
  leadId?: string;
  companyId?: string;
  confidence: number | null;
  plan: ChangePlan | null;
  candidates: Candidate[];
  reasons: string[];
};

/** A plan as JSON: dates become ISO strings, which is how it reads back. */
function planJson(plan: ChangePlan | null): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return plan === null
    ? Prisma.DbNull
    : (JSON.parse(JSON.stringify(plan)) as Prisma.InputJsonValue);
}

/**
 * Opens a review item (DATA_MODEL §3.9) and returns its id. For a message there is at most one
 * open item per kind: asking again returns the existing item and leaves it as it is, so a
 * repeated apply or a retried job never queues the same question twice.
 *
 * The stored plan is for display and for the owner's decision. Resolving the item plans again
 * against the then-current records (TECHNICAL_SPEC §6.5); it never replays this plan.
 */
export async function createReviewItem(
  tx: Prisma.TransactionClient,
  r: NewReviewItem,
): Promise<string> {
  const data = {
    kind: r.kind,
    messageId: r.messageId,
    applicationId: r.applicationId ?? null,
    leadId: r.leadId ?? null,
    companyId: r.companyId ?? null,
    confidence: r.confidence,
    plan: planJson(r.plan),
    candidates: r.candidates as unknown as Prisma.InputJsonValue,
    reasons: r.reasons,
  };
  if (r.messageId === null) return (await tx.reviewItem.create({ data, select: { id: true } })).id;

  // ON CONFLICT DO NOTHING on the partial unique index (message_id, kind) where state = 'open'.
  await tx.reviewItem.createMany({ data: [data], skipDuplicates: true });
  const open = await tx.reviewItem.findFirstOrThrow({
    where: { messageId: r.messageId, kind: r.kind, state: "open" },
    select: { id: true },
  });
  return open.id;
}
