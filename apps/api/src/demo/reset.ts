import type { Prisma } from "@prisma/client";
import type { WorkerCtx } from "../deps.js";
import { withIntakeLock } from "../db/lock.js";
import { FakeLlmProvider } from "../llm/fake-provider.js";
import { FakeMailbox } from "./fake-mailbox.js";
import { loadSeed, storeSeed, type Seed } from "./seed.js";

type ResetCtx = Pick<WorkerCtx, "env" | "prisma" | "llm" | "gmail">;

/**
 * The swap itself, inside the caller's transaction (which must hold the intake lock): empties
 * every application table and stores the seed with each timestamp moved by `now − seed.anchor`.
 * Nothing is committed here; `resetDemoMemory` follows once the transaction has.
 */
export async function resetDemoTables(
  tx: Prisma.TransactionClient,
  timezone: string,
  now: Date,
  seed: Seed,
): Promise<void> {
  // Every table of the application, found in the catalog so later migrations are covered.
  // pg-boss keeps its tables in its own schema and is not touched.
  const tables = await tx.$queryRaw<{ tablename: string }[]>`
    select tablename from pg_tables
    where schemaname = 'public' and tablename <> '_prisma_migrations'`;
  if (tables.length > 0) {
    const list = tables.map((t) => `"public"."${t.tablename.replaceAll('"', '""')}"`).join(", ");
    await tx.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  }
  await storeSeed(tx, seed, now.getTime() - Date.parse(seed.anchor), timezone);
}

/** The in-memory cursors of this process: search batches and mailbox deliveries. */
export async function resetDemoMemory(ctx: Pick<WorkerCtx, "llm" | "gmail">): Promise<void> {
  if (ctx.llm instanceof FakeLlmProvider) ctx.llm.resetSearch();
  const mailbox = await ctx.gmail();
  if (mailbox instanceof FakeMailbox) mailbox.reset();
}

/**
 * `demo.reset` (TECHNICAL_SPEC §9, §12), hourly and at worker start, and when a visitor has used
 * up the simulated emails (`simulateEmail`): the data is emptied and seeded again, moved to look
 * current, and the fake mailbox and the search batches start over. The whole swap is one
 * transaction under the intake lock, so a visitor sees the old data or the new, never half.
 *
 * It deletes everything, so it refuses to run anywhere but a demo instance.
 */
export async function resetDemo(ctx: ResetCtx, now: Date, seed: Seed = loadSeed()): Promise<void> {
  if (ctx.env.mode !== "demo") throw new Error("The demo reset only runs in demo mode.");
  await withIntakeLock(ctx.prisma, (tx) => resetDemoTables(tx, ctx.env.userTimezone, now, seed));
  await resetDemoMemory(ctx);
}
