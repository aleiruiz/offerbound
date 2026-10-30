import type { WorkerCtx } from "../deps.js";

/** `llm_call` rows are kept this long (DATA_MODEL §6). */
export const LLM_CALL_RETENTION_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

export type MaintenanceResult = { sessions: number; importPreviews: number; llmCalls: number };

/**
 * `maintenance.daily` (TECHNICAL_SPEC §9, DATA_MODEL §6): deletes expired sessions, expired
 * import previews and `llm_call` rows older than 180 days. Safe to run any number of times.
 */
export async function runMaintenance(
  ctx: Pick<WorkerCtx, "prisma" | "log">,
  now: Date,
): Promise<MaintenanceResult> {
  const llmCutoff = new Date(now.getTime() - LLM_CALL_RETENTION_DAYS * DAY_MS);
  const [sessions, importPreviews, llmCalls] = await Promise.all([
    ctx.prisma.session.deleteMany({ where: { expiresAt: { lte: now } } }),
    ctx.prisma.importPreview.deleteMany({ where: { expiresAt: { lte: now } } }),
    ctx.prisma.llmCall.deleteMany({ where: { createdAt: { lt: llmCutoff } } }),
  ]);
  const result = {
    sessions: sessions.count,
    importPreviews: importPreviews.count,
    llmCalls: llmCalls.count,
  };
  ctx.log.info(result, "maintenance done");
  return result;
}
