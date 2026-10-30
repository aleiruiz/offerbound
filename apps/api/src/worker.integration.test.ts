import { afterEach, describe, expect, it } from "vitest";
import pino from "pino";
import { createDisabledGoogleClient } from "./auth/google.js";
import { createBoss } from "./jobs/boss.js";
import { startWorker, type WorkerCtx } from "./worker.js";
import { testPrisma } from "../test/db.js";
import { testEnv } from "../test/app.js";

function workerCtx(): WorkerCtx {
  return {
    env: testEnv(),
    prisma: testPrisma(),
    clock: () => new Date(),
    google: createDisabledGoogleClient(),
    log: pino({ level: "silent" }),
  };
}

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
    const worker = await startWorker(workerCtx());
    stops.push(worker.stop);
    const prisma = testPrisma();
    const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
      select count(*) as n from information_schema.schemata where schema_name = 'pgboss'`;
    expect(Number(rows[0]?.n)).toBe(1);
    await worker.stop();
    await worker.stop(); // idempotent
  });

  it("stops gracefully on SIGTERM and removes its signal listeners", async () => {
    const before = process.listenerCount("SIGTERM");
    const worker = await startWorker(workerCtx());
    stops.push(worker.stop);
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);
    process.emit("SIGTERM");
    await worker.stop(); // joins the stop already in progress
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
});
