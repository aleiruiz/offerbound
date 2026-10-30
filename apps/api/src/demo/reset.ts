import type { WorkerCtx } from "../deps.js";
import { withIntakeLock } from "../db/lock.js";
import { FakeLlmProvider } from "../llm/fake-provider.js";
import { FakeMailbox } from "./fake-mailbox.js";
import { loadSeed, storeSeed, type Seed } from "./seed.js";

/**
 * `demo.reset` (TECHNICAL_SPEC §9, §12), hourly and at worker start: empties every application
 * table, stores `fixtures/demo/seed.json` with each timestamp moved by `now − seedAnchor` so the
 * data looks current, and starts the fake mailbox and the search batches over. The whole swap is
 * one transaction under the intake lock, so a visitor sees the old data or the new, never half.
 *
 * It deletes everything, so it refuses to run anywhere but a demo instance.
 */
export async function resetDemo(
  ctx: Pick<WorkerCtx, "env" | "prisma" | "llm" | "gmail">,
  now: Date,
  seed: Seed = loadSeed(),
): Promise<void> {
  if (ctx.env.mode !== "demo") throw new Error("The demo reset only runs in demo mode.");
  const deltaMs = now.getTime() - Date.parse(seed.anchor);

  await withIntakeLock(ctx.prisma, async (tx) => {
    // Every table of the application, found in the catalog so later migrations are covered.
    // pg-boss keeps its tables in its own schema and is not touched.
    const tables = await tx.$queryRaw<{ tablename: string }[]>`
      select tablename from pg_tables
      where schemaname = 'public' and tablename <> '_prisma_migrations'`;
    if (tables.length > 0) {
      const list = tables.map((t) => `"public"."${t.tablename.replaceAll('"', '""')}"`).join(", ");
      await tx.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
    }
    await storeSeed(tx, seed, deltaMs, ctx.env.userTimezone);
  });

  // In-memory cursors of this process.
  if (ctx.llm instanceof FakeLlmProvider) ctx.llm.resetSearch();
  const mailbox = await ctx.gmail();
  if (mailbox instanceof FakeMailbox) mailbox.reset();
}
