import { spawn as nodeSpawn } from "node:child_process";
import { mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ownerLocalDay } from "@offerbound/domain";
import type { WorkerCtx } from "../deps.js";

/** Where the compose `backups` volume is mounted in the worker (TECHNICAL_SPEC §16). */
export const BACKUP_DIR = "/backups";
/** A dump that runs longer than this is killed and counts as a failure. */
export const BACKUP_TIMEOUT_MS = 60 * 60 * 1000;

const BACKUP_FILE = /^offerbound-(\d{4}-\d{2}-\d{2})\.dump$/;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The only variables the child process gets: no application secrets reach pg_dump. */
const CHILD_ENV_KEYS = ["PATH", "HOME", "LANG"] as const;

/** How a command ended. `code` is null when it was killed by a signal. */
export type SpawnResult = { code: number | null; signal?: string | null; timedOut?: boolean };

/** Runs a command and resolves when it ends. Tests replace it with a fake. */
export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: { env: Record<string, string | undefined>; timeoutMs: number },
) => Promise<SpawnResult>;

export type BackupDeps = { spawn?: SpawnFn; dir?: string; timeoutMs?: number };

export type BackupResult = {
  /** The dump that was written. */
  file: string;
  /** File names of the dumps removed because they were older than the retention. */
  deleted: string[];
};

/**
 * The real `spawn`. All three standard streams are ignored, so nothing the command prints can
 * reach a log. After `timeoutMs` the command is killed and the result says so.
 */
export const spawnProcess: SpawnFn = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    const child = nodeSpawn(cmd, args, { env: opts.env, stdio: "ignore" });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut });
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

function childEnv(password: string | undefined): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const key of CHILD_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (password !== undefined) env.PGPASSWORD = password;
  return env;
}

/** Whole calendar days from `from` to `to` (both `YYYY-MM-DD`). */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** Why a dump failed, without anything the command printed: exit code or signal only. */
function describeFailure(result: SpawnResult): string {
  if (result.timedOut) return "timed out";
  if (result.code === null) return `killed by signal ${result.signal ?? "unknown"}`;
  return `exited with code ${String(result.code)}`;
}

/**
 * `backup.nightly` (TECHNICAL_SPEC §9, §16): writes `offerbound-YYYY-MM-DD.dump` (the owner's
 * calendar day) with `pg_dump -Fc`, then deletes dumps older than `BACKUP_RETENTION_DAYS`.
 *
 * pg_dump writes to `<file>.partial`, which is renamed to the final name only after a clean exit
 * and a non-empty file. A failed dump removes only the partial file, so a good dump from earlier
 * the same day survives, nothing is pruned, and the error is thrown for pg-boss to retry.
 * Neither the connection string nor pg_dump's output is logged or put in an error.
 */
export async function runBackup(
  ctx: Pick<WorkerCtx, "env" | "log">,
  now: Date,
  deps: BackupDeps = {},
): Promise<BackupResult> {
  const dir = deps.dir ?? BACKUP_DIR;
  const spawn = deps.spawn ?? spawnProcess;
  const today = ownerLocalDay(now, ctx.env.userTimezone);
  const name = `offerbound-${today}.dump`;
  const file = join(dir, name);
  const partial = `${file}.partial`;
  const { url, password } = splitPassword(ctx.env.databaseUrl);

  await mkdir(dir, { recursive: true });
  await unlink(partial).catch(() => undefined);

  const fail = async (reason: string): Promise<never> => {
    await unlink(partial).catch(() => undefined);
    ctx.log.error({ file: name }, `backup failed: ${reason}`);
    throw new Error(`backup failed: pg_dump ${reason}`);
  };

  let result: SpawnResult;
  try {
    result = await spawn("pg_dump", ["-Fc", "-f", partial, url], {
      env: childEnv(password),
      timeoutMs: deps.timeoutMs ?? BACKUP_TIMEOUT_MS,
    });
  } catch {
    return fail("could not be started");
  }
  if (result.timedOut || result.code !== 0) return fail(describeFailure(result));
  const size = await stat(partial)
    .then((s) => s.size)
    .catch(() => 0);
  if (size === 0) return fail("wrote no data");
  await rename(partial, file);

  const deleted: string[] = [];
  for (const entry of (await readdir(dir)).sort()) {
    const day = BACKUP_FILE.exec(entry)?.[1];
    if (day && daysBetween(day, today) > ctx.env.backupRetentionDays) {
      await unlink(join(dir, entry));
      deleted.push(entry);
    }
  }
  ctx.log.info({ file: name, bytes: size, deleted: deleted.length }, "backup written");
  return { file, deleted };
}
