import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb, testPrisma } from "../../test/db.js";
import { testEnv } from "../../test/app.js";
import { testWorkerCtx } from "../../test/worker.js";
import { HANDLERS } from "../jobs/handlers.js";
import { QUEUES } from "../jobs/queues.js";
import { runBackup, type SpawnFn } from "./backup.js";
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

/** A spawn that records the call and writes a small file where `-f` points, like pg_dump. */
function recordingSpawn(): {
  spawn: SpawnFn;
  calls: { cmd: string; args: string[]; env: Record<string, string | undefined> }[];
} {
  const calls: { cmd: string; args: string[]; env: Record<string, string | undefined> }[] = [];
  const spawn: SpawnFn = async (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts.env });
    const out = args[args.indexOf("-f") + 1];
    if (out) await writeFile(out, "dump");
    return { code: 0 };
  };
  return { spawn, calls };
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe("runBackup", () => {
  it("runs pg_dump -Fc -f /tmp/x/offerbound-2026-10-30.dump <DATABASE_URL> for 03:30 local on Oct 30", async () => {
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
      file,
      "postgresql://offerbound@db.example:5432/offerbound",
    ]);
    expect(calls[0]?.args.join(" ")).not.toContain("word");
    expect(calls[0]?.env.PGPASSWORD).toBe("p@ss word");
    expect((await stat(file)).isFile()).toBe(true);
  });

  it("names the file by the owner's day, not the UTC day", async () => {
    // 22:00 on Oct 29 in Monterrey is already Oct 30 in UTC.
    const { spawn, calls } = recordingSpawn();
    await runBackup(testWorkerCtx(), new Date("2026-10-30T04:00:00.000Z"), { spawn, dir });
    expect(calls[0]?.args[2]).toBe(join(dir, "offerbound-2026-10-29.dump"));
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
      /pg_dump exited with code 1/,
    );
    expect(await readdir(target)).toEqual(["offerbound-2026-10-01.dump"]);
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
