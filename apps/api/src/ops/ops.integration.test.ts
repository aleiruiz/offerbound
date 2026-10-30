import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import pino from "pino";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb, testPrisma } from "../../test/db.js";
import { testEnv } from "../../test/app.js";
import { testWorkerCtx } from "../../test/worker.js";
import { HANDLERS, backupNightlyHandler } from "../jobs/handlers.js";
import { QUEUE_CONFIG, QUEUES } from "../jobs/queues.js";
import { BACKUP_TIMEOUT_MS, runBackup, spawnProcess, type SpawnFn } from "./backup.js";
import { runMaintenance } from "./maintenance.js";

const prisma = testPrisma();
const run = promisify(execFile);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "offerbound-ops-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
afterAll(async () => {
  await prisma.$disconnect();
});

type Call = {
  cmd: string;
  args: string[];
  env: Record<string, string | undefined>;
  timeoutMs: number;
};

/** A spawn that records the call and writes a small file where `-f` points, like pg_dump. */
function recordingSpawn(): {
  spawn: SpawnFn;
  calls: Call[];
} {
  const calls: Call[] = [];
  const spawn: SpawnFn = async (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts.env, timeoutMs: opts.timeoutMs });
    const out = args[args.indexOf("-f") + 1];
    if (out) await writeFile(out, "dump");
    return { code: 0 };
  };
  return { spawn, calls };
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe("runBackup", () => {
  it("runs pg_dump -Fc -f /tmp/x/offerbound-2026-10-30.dump <DATABASE_URL> for 03:30 local on Oct 30 (written as .partial, then renamed)", async () => {
    // 03:30 in America/Monterrey (UTC-6) is 09:30 UTC; the file is named by the owner's day.
    const now = new Date("2026-10-30T09:30:00.000Z");
    const ctx = testWorkerCtx({
      env: testEnv({
        DATABASE_URL: "postgresql://offerbound:p%40ss%20word@db.example:5432/offerbound",
      }),
    });
    const { spawn, calls } = recordingSpawn();
    const result = await runBackup(ctx, now, { spawn, dir });

    const file = join(dir, "offerbound-2026-10-30.dump");
    expect(result.file).toBe(file);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe("pg_dump");
    // The password travels in the environment, never in the arguments.
    expect(calls[0]?.args).toEqual([
      "-Fc",
      "-f",
      `${file}.partial`,
      "postgresql://offerbound@db.example:5432/offerbound",
    ]);
    expect(calls[0]?.args.join(" ")).not.toContain("word");
    expect(calls[0]?.env.PGPASSWORD).toBe("p@ss word");
    expect((await stat(file)).isFile()).toBe(true);
  });

  it("names the file by the owner's day, not the UTC day", async () => {
    // 22:00 on Oct 29 in Monterrey is already Oct 30 in UTC.
    const { spawn } = recordingSpawn();
    await runBackup(testWorkerCtx(), new Date("2026-10-30T04:00:00.000Z"), { spawn, dir });
    expect(await readdir(dir)).toEqual(["offerbound-2026-10-29.dump"]);
  });

  it("deletes the 15-day-old dump and keeps the 14-day-old one", async () => {
    const now = new Date("2026-10-30T09:30:00.000Z");
    for (const name of [
      "offerbound-2026-10-15.dump", // 15 days old
      "offerbound-2026-10-16.dump", // 14 days old
      "offerbound-2026-10-29.dump",
      "notes.txt", // not a backup: left alone
      "offerbound-2026-01-01.dump.partial", // not a backup: left alone
    ]) {
      await writeFile(join(dir, name), "x");
    }
    const { spawn } = recordingSpawn();
    const result = await runBackup(testWorkerCtx(), now, { spawn, dir });

    expect(result.deleted).toEqual(["offerbound-2026-10-15.dump"]);
    expect((await readdir(dir)).sort()).toEqual([
      "notes.txt",
      "offerbound-2026-01-01.dump.partial",
      "offerbound-2026-10-16.dump",
      "offerbound-2026-10-29.dump",
      "offerbound-2026-10-30.dump",
    ]);
  });

  it("honours BACKUP_RETENTION_DAYS", async () => {
    const now = new Date("2026-10-30T09:30:00.000Z");
    await writeFile(join(dir, "offerbound-2026-10-22.dump"), "x"); // 8 days
    await writeFile(join(dir, "offerbound-2026-10-23.dump"), "x"); // 7 days
    const ctx = testWorkerCtx({ env: testEnv({ BACKUP_RETENTION_DAYS: "7" }) });
    const { spawn } = recordingSpawn();
    const result = await runBackup(ctx, now, { spawn, dir });
    expect(result.deleted).toEqual(["offerbound-2026-10-22.dump"]);
  });

  it("creates the directory, and a failed dump removes its partial file, keeps old dumps and throws", async () => {
    const now = new Date("2026-10-30T09:30:00.000Z");
    const target = join(dir, "nested");
    await mkdir(target);
    await writeFile(join(target, "offerbound-2026-10-01.dump"), "x");
    const failing: SpawnFn = async (_cmd, args) => {
      await writeFile(args[args.indexOf("-f") + 1] ?? "", "half");
      return { code: 1 };
    };
    await expect(runBackup(testWorkerCtx(), now, { spawn: failing, dir: target })).rejects.toThrow(
      "backup failed: pg_dump exited with code 1",
    );
    expect(await readdir(target)).toEqual(["offerbound-2026-10-01.dump"]);
  });

  it("a failed dump leaves a good dump from earlier the same day untouched", async () => {
    const now = new Date("2026-10-30T09:30:00.000Z");
    const final = join(dir, "offerbound-2026-10-30.dump");
    await writeFile(final, "good");
    const failing: SpawnFn = async (_cmd, args) => {
      await writeFile(args[args.indexOf("-f") + 1] ?? "", "half");
      return { code: 1 };
    };
    await expect(runBackup(testWorkerCtx(), now, { spawn: failing, dir })).rejects.toThrow();
    expect(await readFile(final, "utf8")).toBe("good");
    expect(await readdir(dir)).toEqual(["offerbound-2026-10-30.dump"]);
  });

  it("a successful dump replaces the earlier one from the same day", async () => {
    const now = new Date("2026-10-30T09:30:00.000Z");
    const final = join(dir, "offerbound-2026-10-30.dump");
    await writeFile(final, "old");
    const { spawn } = recordingSpawn();
    await runBackup(testWorkerCtx(), now, { spawn, dir });
    expect(await readFile(final, "utf8")).toBe("dump");
    expect(await readdir(dir)).toEqual(["offerbound-2026-10-30.dump"]);
  });

  it("an empty dump counts as a failure: the good dump stays, nothing is pruned", async () => {
    const now = new Date("2026-10-30T09:30:00.000Z");
    await writeFile(join(dir, "offerbound-2026-10-30.dump"), "good");
    await writeFile(join(dir, "offerbound-2026-09-01.dump"), "ancient");
    const empty: SpawnFn = async (_cmd, args) => {
      await writeFile(args[args.indexOf("-f") + 1] ?? "", "");
      return { code: 0 };
    };
    await expect(runBackup(testWorkerCtx(), now, { spawn: empty, dir })).rejects.toThrow(
      "backup failed: pg_dump wrote no data",
    );
    expect((await readdir(dir)).sort()).toEqual([
      "offerbound-2026-09-01.dump",
      "offerbound-2026-10-30.dump",
    ]);
  });

  it("passes pg_dump only PATH, HOME, LANG and PGPASSWORD, with a 25-minute timeout", async () => {
    process.env.OPENAI_API_KEY = "leak-check-openai";
    process.env.TOKEN_ENCRYPTION_KEY = "leak-check-key";
    try {
      const ctx = testWorkerCtx({
        env: testEnv({ DATABASE_URL: "postgresql://offerbound:pw@db.example:5432/offerbound" }),
      });
      const { spawn, calls } = recordingSpawn();
      await runBackup(ctx, new Date("2026-10-30T09:30:00.000Z"), { spawn, dir });
      const env = calls[0]?.env ?? {};
      expect(
        Object.keys(env).filter((k) => !["PATH", "HOME", "LANG", "PGPASSWORD"].includes(k)),
      ).toEqual([]);
      expect(env.PGPASSWORD).toBe("pw");
      expect(calls[0]?.timeoutMs).toBe(BACKUP_TIMEOUT_MS);
      expect(BACKUP_TIMEOUT_MS).toBe(25 * 60 * 1000);
      expect(BACKUP_TIMEOUT_MS).toBeLessThan(
        QUEUE_CONFIG[QUEUES.backupNightly].expireInSeconds * 1000,
      );
    } finally {
      delete process.env.OPENAI_API_KEY;
      delete process.env.TOKEN_ENCRYPTION_KEY;
    }
  });

  it("a dump that times out counts as a failure and removes the partial file", async () => {
    const hung: SpawnFn = async (_cmd, args) => {
      await writeFile(args[args.indexOf("-f") + 1] ?? "", "half");
      return { code: null, signal: "SIGKILL", timedOut: true };
    };
    await expect(
      runBackup(testWorkerCtx(), new Date("2026-10-30T09:30:00.000Z"), { spawn: hung, dir }),
    ).rejects.toThrow("backup failed: pg_dump timed out");
    expect(await readdir(dir)).toEqual([]);
  });

  it("a signal kill and a spawn error fail with a fixed message", async () => {
    const now = new Date("2026-10-30T09:30:00.000Z");
    const killed: SpawnFn = () => Promise.resolve({ code: null, signal: "SIGTERM" });
    await expect(runBackup(testWorkerCtx(), now, { spawn: killed, dir })).rejects.toThrow(
      "backup failed: pg_dump killed by signal SIGTERM",
    );
    const missing: SpawnFn = () => Promise.reject(new Error("spawn pg_dump ENOENT"));
    await expect(runBackup(testWorkerCtx(), now, { spawn: missing, dir })).rejects.toThrow(
      "backup failed: pg_dump could not be started",
    );
  });

  it("neither the password nor pg_dump's output reaches the logs or the error", async () => {
    const lines: string[] = [];
    const log = pino({ level: "trace" }, { write: (line: string) => void lines.push(line) });
    const ctx = testWorkerCtx({
      log,
      env: testEnv({
        DATABASE_URL: "postgresql://offerbound:s3cr3t-Pw-9@db.example:5432/offerbound",
      }),
    });
    const now = new Date("2026-10-30T09:30:00.000Z");
    const failing: SpawnFn = () => Promise.resolve({ code: 1 });
    let message = "";
    await runBackup(ctx, now, { spawn: failing, dir }).catch((e: unknown) => {
      message = e instanceof Error ? e.message : "";
    });
    await runBackup(ctx, now, { spawn: recordingSpawn().spawn, dir });
    expect(message).toBe("backup failed: pg_dump exited with code 1");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join("\n")).not.toContain("s3cr3t");
    expect(lines.join("\n")).not.toContain("db.example");
  });

  it("spawnProcess kills a command that outlives its timeout, and reports the exit code otherwise", async () => {
    const env = { PATH: process.env.PATH };
    expect(await spawnProcess("sleep", ["5"], { env, timeoutMs: 100 })).toMatchObject({
      timedOut: true,
      signal: "SIGKILL",
    });
    expect(await spawnProcess("sh", ["-c", "exit 3"], { env, timeoutMs: 5000 })).toMatchObject({
      code: 3,
      timedOut: false,
    });
    await expect(
      spawnProcess("no-such-command-here", [], { env, timeoutMs: 1000 }),
    ).rejects.toThrow();
  });

  it("writes a real custom-format dump that pg_restore can read", async () => {
    const now = new Date("2026-10-30T09:30:00.000Z");
    await resetDb(prisma);
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is required for integration tests");
    const ctx = testWorkerCtx({ env: testEnv({ DATABASE_URL: url }) });
    const { file } = await runBackup(ctx, now, { dir });
    const { stdout } = await run("pg_restore", ["-l", file]);
    expect(stdout).toContain("TABLE public session");
  });
});

describe("runMaintenance", () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  const now = new Date("2026-10-30T10:00:00.000Z");
  const ago = (ms: number): Date => new Date(now.getTime() - ms);
  const llm = (createdAt: Date) =>
    prisma.llmCall.create({
      data: {
        purpose: "triage",
        model: "model-triage",
        inputTokens: 1,
        cachedInputTokens: 0,
        outputTokens: 1,
        latencyMs: 1,
        status: "ok",
        createdAt,
      },
    });

  it("maintenance deletes expired sessions, expired previews and llm_call rows older than 180 days, and keeps the rest", async () => {
    await prisma.session.createMany({
      data: [
        { idHash: "expired", expiresAt: ago(1000) },
        { idHash: "live", expiresAt: new Date(now.getTime() + DAY_MS) },
      ],
    });
    await prisma.importPreview.createMany({
      data: [
        { kind: "sheet", payload: {}, expiresAt: ago(1000), createdAt: ago(3_700_000) },
        { kind: "sheet", payload: {}, expiresAt: new Date(now.getTime() + 60_000) },
      ],
    });
    await llm(ago(181 * DAY_MS));
    await llm(ago(179 * DAY_MS));
    await llm(now);

    const result = await runMaintenance(testWorkerCtx(), now);

    expect(result).toEqual({ sessions: 1, importPreviews: 1, llmCalls: 1 });
    expect((await prisma.session.findMany()).map((s) => s.idHash)).toEqual(["live"]);
    expect(await prisma.importPreview.count()).toBe(1);
    expect(await prisma.llmCall.count()).toBe(2);
  });

  it("keeps an llm_call row exactly 180 days old and does nothing on an empty database", async () => {
    expect(await runMaintenance(testWorkerCtx(), now)).toEqual({
      sessions: 0,
      importPreviews: 0,
      llmCalls: 0,
    });
    await llm(ago(180 * DAY_MS));
    expect((await runMaintenance(testWorkerCtx(), now)).llmCalls).toBe(0);
  });
});

describe("job handlers", () => {
  it("backup.nightly and maintenance.daily have handlers", () => {
    expect(HANDLERS[QUEUES.backupNightly]).toBeTypeOf("function");
    expect(HANDLERS[QUEUES.maintenanceDaily]).toBeTypeOf("function");
  });

  it("backup.nightly dumps with the context clock and the injected directory", async () => {
    const handler = backupNightlyHandler({ spawn: recordingSpawn().spawn, dir });
    await handler(testWorkerCtx(), { data: {}, retryCount: 0, retryLimit: 2 });
    // The test context clock is 2026-10-01T12:00:00Z, 06:00 on Oct 1 in Monterrey.
    expect(await readdir(dir)).toEqual(["offerbound-2026-10-01.dump"]);
  });

  it("backup.nightly lets a failed dump reach pg-boss so it retries", async () => {
    const handler = backupNightlyHandler({ spawn: () => Promise.resolve({ code: 1 }), dir });
    await expect(
      handler(testWorkerCtx(), { data: {}, retryCount: 0, retryLimit: 2 }),
    ).rejects.toThrow("backup failed");
  });

  it("maintenance.daily runs maintenance with the context clock", async () => {
    await resetDb(prisma);
    await prisma.session.create({
      data: { idHash: "old", expiresAt: new Date("2026-09-01T00:00:00.000Z") },
    });
    const handler = HANDLERS[QUEUES.maintenanceDaily];
    if (!handler) throw new Error("no maintenance.daily handler");
    await handler(testWorkerCtx(), { data: {}, retryCount: 0, retryLimit: 1 });
    expect(await prisma.session.count()).toBe(0);
  });
});
