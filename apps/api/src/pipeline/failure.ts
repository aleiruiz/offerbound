import type { Prisma, PrismaClient } from "@prisma/client";
import type { WorkerCtx } from "../deps.js";
import { withIntakeLock } from "../db/lock.js";

/**
 * Marks a `job_related` message `failed` and opens one *Extraction failed* review item. The
 * columns triage stored (sender, subject, preview) stay, so the item can show the email and a
 * retry can go straight back to extraction. A message in any other state is left alone. Called
 * by extraction for failures that cannot be retried, by the job handler when the retries run out,
 * and by triage's resend sweep for a message that keeps coming back.
 */
export async function markExtractionFailed(
  ctx: WorkerCtx,
  messageId: string,
  code: string,
): Promise<void> {
  const now = ctx.clock();
  await withIntakeLock(ctx.prisma, async (tx: Prisma.TransactionClient) => {
    const { count } = await tx.gmailMessage.updateMany({
      where: { id: messageId, state: "job_related" },
      data: { state: "failed", lastError: code, processedAt: now },
    });
    if (count === 0) return;
    await tx.reviewItem.createMany({
      data: [{ kind: "extraction_failed", messageId, reasons: ["extraction_failed"] }],
      skipDuplicates: true,
    });
  });
}

/**
 * True when a Gmail connection exists and is no longer `active` (`needs_reauth`,
 * `missing_scope`, `disconnected`): every Gmail call would fail with `GmailAuthError`, so stages
 * that only need Gmail wait for the owner to reconnect instead of failing once per message. With
 * no connection row at all (demo mode, tests) the stages go on.
 */
export async function gmailAuthIsLost(db: Pick<PrismaClient, "gmailConnection">): Promise<boolean> {
  const connection = await db.gmailConnection.findUnique({
    where: { id: 1 },
    select: { status: true },
  });
  return connection !== null && connection.status !== "active";
}
