import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Timing for the lock's transaction. Prisma's default is 5 s, and that clock includes the wait for
 * the advisory lock itself, so a writer queued behind a long holder (a sheet import, a search
 * finalize) would fail even though its own work is short. The critical sections are free of
 * network calls (the LLM and Gmail are always called before taking the lock), so a generous
 * ceiling only ever covers waiting for the holders ahead.
 */
export const INTAKE_LOCK_TX_OPTIONS = {
  /** Longest wait for a free database connection from the pool. */
  maxWait: 10_000,
  /** Longest the whole transaction may take, including the wait for the lock. */
  timeout: 60_000,
} as const;

/**
 * Runs `fn` in a transaction that holds the intake lock (TECHNICAL_SPEC §6.8). Every write the
 * pipeline, intake, imports, search, timers, undo and review resolution make goes through here,
 * so "company already seen" and job-key uniqueness are race-free. The lock is released when the
 * transaction ends. Owner edits from the UI do not take it.
 *
 * Keep network calls out of `fn`: anything slow holds up every other writer.
 */
export function withIntakeLock<T>(
  prisma: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options: { maxWait?: number; timeout?: number } = {},
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('offerbound.intake'))`;
      return fn(tx);
    },
    { ...INTAKE_LOCK_TX_OPTIONS, ...options },
  );
}
