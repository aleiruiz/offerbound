import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@offerbound/contracts";
import { createBoss, schedulesFor } from "./jobs/boss.js";
import { HANDLERS } from "./jobs/handlers.js";
import { startWorker } from "./worker.js";
import { testPrisma } from "../test/db.js";
import { testEnv } from "../test/app.js";
import { testWorkerCtx } from "../test/worker.js";
import { demoWorkerCtx } from "../test/demo.js";
import { loadSeed } from "./demo/seed.js";
import { resetDb } from "../test/db.js";

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
});

describe("worker", () => {
  it("createBoss returns an unstarted pg-boss for the given database", () => {
    const boss = createBoss(testEnv().databaseUrl);
    expect(typeof boss.start).toBe("function");
    expect(typeof boss.stop).toBe("function");
  });

  it("starts pg-boss, creating its schema, and stops cleanly", async () => {
    const worker = await startWorker(testWorkerCtx());
    stops.push(worker.stop);
    const prisma = testPrisma();
    const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
      select count(*) as n from information_schema.schemata where schema_name = 'pgboss'`;
    expect(Number(rows[0]?.n)).toBe(1);
    await worker.stop();
    await worker.stop(); // idempotent
  });

  it("registers the schedules of the queues that have a handler, in the owner's time zone", async () => {
    const ctx = testWorkerCtx();
    const worker = await startWorker(ctx);
    stops.push(worker.stop);
    const rows = await testPrisma().$queryRaw<
      Array<{ name: string; cron: string; timezone: string }>
    >`
      select name, cron, timezone from pgboss.schedule order by name`;
    expect(rows).toContainEqual({
      name: "email.triage",
      cron: "* * * * *",
      timezone: ctx.env.userTimezone,
    });
    // Exactly the scheduled queues that have a handler: a queue nobody consumes gets no schedule,
    // so no jobs pile up for it, and a handler added later brings its schedule with it.
    const handled = schedulesFor(ctx.env.mode, DEFAULT_SETTINGS)
      .map((schedule) => schedule.name)
      .filter((name) => name in HANDLERS);
    expect(rows.map((r) => r.name).sort()).toEqual(handled.sort());
    expect(handled).toContain("email.triage");
  });

  it("in demo mode it seeds the demo at start and schedules demo.reset every hour (TECHNICAL_SPEC §12)", async () => {
    const prisma = testPrisma();
    await resetDb(prisma);
    const ctx = demoWorkerCtx();
    const worker = await startWorker(ctx);
    stops.push(worker.stop);
    expect(await prisma.application.count()).toBe(loadSeed().applications.length);

    const rows = await prisma.$queryRaw<Array<{ name: string; cron: string; timezone: string }>>`
      select name, cron, timezone from pgboss.schedule order by name`;
    expect(rows).toContainEqual({
      name: "demo.reset",
      cron: "0 * * * *",
      timezone: ctx.env.userTimezone,
    });
    expect(rows.map((r) => r.name)).not.toContain("backup.nightly");
    await worker.stop();
    // Leave the shared pg-boss schema as the private-mode tests expect it.
    await prisma.$executeRaw`delete from pgboss.schedule where name = 'demo.reset'`;
  });

  it("stops gracefully on SIGTERM and removes its signal listeners", async () => {
    const before = process.listenerCount("SIGTERM");
    const worker = await startWorker(testWorkerCtx());
    stops.push(worker.stop);
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);
    process.emit("SIGTERM");
    await worker.stop(); // joins the stop already in progress
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
});
