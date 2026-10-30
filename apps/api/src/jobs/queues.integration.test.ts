import { afterEach, describe, expect, it, vi } from "vitest";
import { testPrisma } from "../../test/db.js";
import { testEnv } from "../../test/app.js";
import { createBoss } from "./boss.js";
import { PgBossQueue, QUEUE_CONFIG, QUEUES, type QueueName } from "./queues.js";

const prisma = testPrisma();
const queues: PgBossQueue[] = [];
afterEach(async () => {
  await Promise.all(queues.splice(0).map((q) => q.stop({ graceful: false })));
});

async function started(role: "api" | "worker" = "api"): Promise<PgBossQueue> {
  const queue = new PgBossQueue(createBoss(testEnv().databaseUrl, role));
  queues.push(queue);
  await queue.start();
  return queue;
}

describe("PgBossQueue", () => {
  it("creates every queue at start, with the policy, retries and expiry of the job table", async () => {
    const queue = await started();
    expect(queue.isReady()).toBe(true);
    for (const name of Object.values(QUEUES)) {
      const created = await queue.boss.getQueue(name);
      const config = QUEUE_CONFIG[name];
      expect(created, name).toMatchObject({
        policy: config.policy,
        retryLimit: config.retryLimit,
        expireInSeconds: config.expireInSeconds,
        retryDelay: config.retryDelay,
        retryBackoff: config.retryDelay > 0,
      });
    }
    expect((await queue.boss.getQueue("gmail.sync"))?.policy).toBe("singleton");
    expect((await queue.boss.getQueue("gmail.backfill"))?.policy).toBe("singleton");
  });

  it("starting again leaves the queues in place and refreshes their settings", async () => {
    const first = await started();
    await first.boss.updateQueue("gmail.sync", { retryLimit: 9 });
    await first.stop({ graceful: false });
    queues.length = 0;
    const second = await started();
    expect((await second.boss.getQueue("gmail.sync"))?.retryLimit).toBe(3);
  });

  it("is not ready before start() or after stop()", async () => {
    const queue = new PgBossQueue(createBoss(testEnv().databaseUrl, "api"));
    expect(queue.isReady()).toBe(false);
    await queue.start();
    expect(queue.isReady()).toBe(true);
    await queue.stop({ graceful: false });
    expect(queue.isReady()).toBe(false);
  });

  it("sends a job with data, a singleton key and a delay", async () => {
    const queue = await started();
    const name: QueueName = QUEUES.leadsFinalize;
    await queue.boss.deleteAllJobs(name);
    await queue.send(name, { batch: "b1" }, { singletonKey: "k1", startAfterSeconds: 120 });
    const [stored] = await queue.boss.findJobs<{ batch: string }>(name);
    expect(stored).toBeDefined();
    expect(stored?.data).toEqual({ batch: "b1" });
    expect(stored?.singletonKey).toBe("k1");
    const waitMs = (stored?.startAfter.getTime() ?? 0) - Date.now();
    expect(waitMs).toBeGreaterThan(100_000);
    expect(waitMs).toBeLessThan(125_000);
  });

  it("schedules and unschedules a recurring job in a time zone, from the API process", async () => {
    const queue = await started("api"); // sends and schedules only
    await queue.schedule(QUEUES.gmailSync, "*/5 * * * *", { tz: "America/Monterrey" });
    await queue.schedule(QUEUES.gmailSync, "*/10 * * * *", { tz: "America/Monterrey" });
    const rows = await prisma.$queryRaw<{ cron: string; timezone: string }[]>`
      select cron, timezone from pgboss.schedule where name = 'gmail.sync'`;
    expect(rows).toEqual([{ cron: "*/10 * * * *", timezone: "America/Monterrey" }]);

    await queue.unschedule(QUEUES.gmailSync);
    await queue.unschedule(QUEUES.gmailSync); // nothing left: still fine
    const after = await prisma.$queryRaw<{ n: bigint }[]>`
      select count(*) as n from pgboss.schedule where name = 'gmail.sync'`;
    expect(Number(after[0]?.n)).toBe(0);
  });

  it("survives a pg-boss error event, reporting the error's name and code but not its message", async () => {
    const seen: { errorName: string; errorCode?: string }[] = [];
    const queue = new PgBossQueue(createBoss(testEnv().databaseUrl, "api"), (info) =>
      seen.push(info),
    );
    queues.push(queue);
    await queue.start();
    const secret = "connection to ana@quarry.example reset";
    expect(() =>
      queue.boss.emit("error", Object.assign(new Error(secret), { code: "ECONNRESET" })),
    ).not.toThrow();
    expect(() => queue.boss.emit("error", "not even an Error" as unknown as Error)).not.toThrow();
    expect(seen).toEqual([
      { errorName: "Error", errorCode: "ECONNRESET" },
      { errorName: "unknown" },
    ]);
    expect(JSON.stringify(seen)).not.toContain("quarry");
  });

  it("the default error handler logs the name only and does not throw", () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    try {
      const queue = new PgBossQueue(createBoss(testEnv().databaseUrl, "api"));
      expect(() => queue.boss.emit("error", new Error("secret ana@quarry.example"))).not.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      level: "error",
      msg: "pg-boss error",
      errorName: "Error",
    });
  });

  it("keeps working after Postgres drops its connections", async () => {
    const seen: string[] = [];
    const queue = new PgBossQueue(createBoss(testEnv().databaseUrl, "api"), (info) =>
      seen.push(info.errorName),
    );
    queues.push(queue);
    await queue.start();
    await prisma.$queryRaw`
      select pg_terminate_backend(pid) from pg_stat_activity
      where application_name = 'offerbound-api' and pid <> pg_backend_pid()`;
    await new Promise((r) => setTimeout(r, 500)); // the process is still here to run this
    await queue.send(QUEUES.leadsFinalize, { after: "drop" });
    expect(queue.isReady()).toBe(true);
  });

  it("hasDelayed is true only while a job waits for a start time in the future", async () => {
    const queue = await started();
    const name = QUEUES.leadsFinalize;
    await queue.boss.deleteAllJobs(name);
    expect(await queue.hasDelayed(name)).toBe(false);
    await queue.send(name, {});
    expect(await queue.hasDelayed(name)).toBe(false);
    await queue.send(name, {}, { startAfterSeconds: 300 });
    expect(await queue.hasDelayed(name)).toBe(true);
    await queue.boss.deleteAllJobs(name);
    expect(await queue.hasDelayed(name)).toBe(false);
  });
});
