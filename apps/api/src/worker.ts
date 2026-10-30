import { pathToFileURL } from "node:url";
import pino from "pino";
import { LOG_REDACT_PATHS } from "./app.js";
import { EnvError, loadEnv } from "./config/env.js";
import { createDeps, type WorkerCtx } from "./deps.js";
import { resetDemo } from "./demo/reset.js";
import { resumeGmailJobs } from "./gmail/control.js";
import { createBoss, registerSchedules } from "./jobs/boss.js";
import { HANDLERS, registerHandlers } from "./jobs/handlers.js";
import { PgBossQueue, type QueueName } from "./jobs/queues.js";
import { markStaleRuns, registerSearchSchedule } from "./leads/search.js";
import { getSettings } from "./settings/service.js";

export type { WorkerCtx } from "./deps.js";

/** Jobs get this long to finish after SIGTERM; compose gives the container a little longer. */
const STOP_TIMEOUT_MS = 30_000;

/**
 * Starts pg-boss, creates the queues, registers the job handlers and the recurring schedules of
 * the queues that have one, and picks up where the last run stopped (a running backfill
 * continues, the sync schedule is registered again). The jobs
 * send further jobs through the worker's own queue, so `ctx.queue` is replaced by it. The worker
 * stops gracefully, letting running jobs finish, on SIGTERM or SIGINT or when `stop()` is called.
 */
export async function startWorker(base: WorkerCtx): Promise<{ stop: () => Promise<void> }> {
  const queue = new PgBossQueue(createBoss(base.env.databaseUrl, "worker"), (info) => {
    base.log.error(info, "pg-boss error");
  });
  const boss = queue.boss;
  const ctx: WorkerCtx = { ...base, queue };
  await queue.start();
  // The demo starts from its seed (§12); the hourly `demo.reset` keeps it there. Before the
  // handlers start and the schedules read the settings, which the reset writes.
  if (ctx.env.mode === "demo") await resetDemo(ctx, ctx.clock());
  await registerHandlers(boss, ctx);
  // A schedule for a queue nobody consumes would only pile up jobs; later tasks add handlers.
  await registerSchedules(
    queue,
    ctx.env.mode,
    await getSettings(ctx.prisma),
    ctx.env.userTimezone,
    new Set(Object.keys(HANDLERS) as QueueName[]),
  );
  await resumeGmailJobs(ctx);
  // Search: close runs lost with the previous worker, then register the daily run (private mode;
  // the demo has no search of its own). `PUT /settings` calls `registerSearchSchedule` on changes.
  await markStaleRuns(ctx.prisma, ctx.clock());
  if (ctx.env.mode === "private") {
    const { search } = await getSettings(ctx.prisma);
    await registerSearchSchedule(queue, search, ctx.env.userTimezone);
  }

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      process.off("SIGTERM", onSigterm);
      process.off("SIGINT", onSigint);
      await queue.stop({ graceful: true, timeout: STOP_TIMEOUT_MS });
      ctx.log.info("worker stopped");
    })();
    return stopping;
  };
  const onSignal = (signal: string): void => {
    ctx.log.info({ signal }, "worker shutting down");
    stop().catch((error: unknown) => {
      ctx.log.error({ errorName: error instanceof Error ? error.name : "unknown" }, "stop failed");
    });
  };
  const onSigterm = (): void => onSignal("SIGTERM");
  const onSigint = (): void => onSignal("SIGINT");
  process.once("SIGTERM", onSigterm);
  process.once("SIGINT", onSigint);

  ctx.log.info("worker started");
  return { stop };
}

async function main(): Promise<void> {
  let env;
  try {
    env = loadEnv(process.env);
  } catch (error) {
    if (error instanceof EnvError) {
      // Names only, never values.
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const log = pino({
    level: env.logLevel,
    redact: { paths: LOG_REDACT_PATHS, censor: "[redacted]" },
  });
  const deps = createDeps(env, log);
  const worker = await startWorker({ ...deps, log });

  // Resolves after the first SIGTERM/SIGINT has finished stopping pg-boss.
  await new Promise<void>((resolve) => {
    const done = (): void => {
      worker.stop().then(resolve, resolve);
    };
    process.once("SIGTERM", done);
    process.once("SIGINT", done);
  });
  await deps.prisma.$disconnect();
  process.exit(0);
}

// Run only as the entry point (`node dist/worker.js`), not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error("Failed to start:", error instanceof Error ? error.name : "unknown error");
    process.exit(1);
  });
}
