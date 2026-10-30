import { pathToFileURL } from "node:url";
import type { FastifyBaseLogger } from "fastify";
import pino from "pino";
import { LOG_REDACT_PATHS } from "./app.js";
import { EnvError, loadEnv } from "./config/env.js";
import { createDeps, type AppDeps } from "./deps.js";
import { createBoss } from "./jobs/boss.js";

/** Everything a background job needs: the app dependencies plus a logger. */
export type WorkerCtx = AppDeps & { log: FastifyBaseLogger };

/** Jobs get this long to finish after SIGTERM; compose gives the container a little longer. */
const STOP_TIMEOUT_MS = 30_000;

/**
 * Starts pg-boss and the job handlers (none yet; later tasks register them here). The worker
 * stops gracefully, letting running jobs finish, on SIGTERM or SIGINT or when `stop()` is called.
 */
export async function startWorker(ctx: WorkerCtx): Promise<{ stop: () => Promise<void> }> {
  const boss = createBoss(ctx.env.databaseUrl);
  boss.on("error", (error) => {
    ctx.log.error({ errorName: error.name }, "pg-boss error");
  });
  await boss.start();

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      process.off("SIGTERM", onSigterm);
      process.off("SIGINT", onSigint);
      await boss.stop({ graceful: true, timeout: STOP_TIMEOUT_MS });
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
  const deps = createDeps(env);
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
