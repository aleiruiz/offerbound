import { spawn as nodeSpawn } from "node:child_process";
import { mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ownerLocalDay } from "@offerbound/domain";
import type { WorkerCtx } from "../deps.js";

/** Where the compose `backups` volume is mounted in the worker (TECHNICAL_SPEC §16). */
export const BACKUP_DIR = "/backups";

const BACKUP_FILE = /^offerbound-(\d{4}-\d{2}-\d{2})\.dump$/;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Enough of pg_dump's own error text to diagnose a failure, never more. */
const STDERR_LIMIT = 500;

/** Runs a command and resolves with its exit code. Tests replace it with a fake. */
export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: { env: Record<string, string | undefined> },
) => Promise<{ code: number | null; stderr?: string }>;

export type BackupDeps = { spawn?: SpawnFn; dir?: string };

export type BackupResult = {
  /** The dump that was written. */
  file: string;
  /** File names of the dumps removed because they were older than the retention. */
  deleted: string[];
};

/** The real `spawn`: stdout and stdin are ignored, stderr is kept (truncated) for the log. */
const defaultSpawn: SpawnFn = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    const child = nodeSpawn(cmd, args, { env: opts.env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < STDERR_LIMIT) stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stderr: stderr.slice(0, STDERR_LIMIT) });
    });
  });

/**
 * Splits a connection URL into the URL without its password and the password. pg_dump reads the
 * password from `PGPASSWORD`, so it never appears in the argument list (visible in `ps`).
 */
function splitPassword(databaseUrl: string): { url: string; password: string | undefined } {
  const parsed = new URL(databaseUrl);
  const password = parsed.password === "" ? undefined : decodeURIComponent(parsed.password);
  parsed.password = "";
  return { url: parsed.toString(), password };
}

/** Whole calendar days from `from` to `to` (both `YYYY-MM-DD`). */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/**
 * `backup.nightly` (TECHNICAL_SPEC §9, §16): writes `offerbound-YYYY-MM-DD.dump` (the owner's
 * calendar day) with `pg_dump -Fc`, then deletes dumps older than `BACKUP_RETENTION_DAYS`. A
 * failed dump removes its partial file, keeps the older dumps and throws so pg-boss retries.
 * The connection string is never logged.
 */
export async function runBackup(
  ctx: Pick<WorkerCtx, "env" | "log">,
  now: Date,
  deps: BackupDeps = {},
): Promise<BackupResult> {
  const dir = deps.dir ?? BACKUP_DIR;
  const spawn = deps.spawn ?? defaultSpawn;
  const today = ownerLocalDay(now, ctx.env.userTimezone);
  const file = join(dir, `offerbound-${today}.dump`);
  const { url, password } = splitPassword(ctx.env.databaseUrl);

  await mkdir(dir, { recursive: true });
  const env: Record<string, string | undefined> = { ...process.env };
  if (password === undefined) delete env.PGPASSWORD;
  else env.PGPASSWORD = password;

  const result = await spawn("pg_dump", ["-Fc", "-f", file, url], { env });
  if (result.code !== 0) {
    await unlink(file).catch(() => undefined);
    ctx.log.error({ code: result.code, stderr: result.stderr }, "backup: pg_dump failed");
    throw new Error(`pg_dump exited with code ${String(result.code)}`);
  }

  const deleted: string[] = [];
  for (const name of (await readdir(dir)).sort()) {
    const day = BACKUP_FILE.exec(name)?.[1];
    if (day && daysBetween(day, today) > ctx.env.backupRetentionDays) {
      await unlink(join(dir, name));
      deleted.push(name);
    }
  }
  ctx.log.info({ file: `offerbound-${today}.dump`, deleted: deleted.length }, "backup written");
  return { file, deleted };
}
