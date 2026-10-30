import type { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import type { Env } from "./config/env.js";
import { createDisabledGoogleClient, createGoogleAuthClient } from "./auth/google.js";
import type { GoogleAuthClient } from "./auth/google.js";
import { createPrisma } from "./db/prisma.js";
import { createSafeFetcher, type LinkFetcher } from "./leads/ssrf.js";
import { createBoss } from "./jobs/boss.js";
import { PgBossQueue, type JobQueue } from "./jobs/queues.js";
import {
  createGmailClientFactory,
  createPrismaConnectionStore,
  type GmailClientFactory,
} from "./gmail/client.js";

/**
 * Everything the app needs from outside. Later tasks add fields (llm, fetchLink); tests replace
 * any of them with fakes.
 */
export type AppDeps = {
  env: Env;
  prisma: PrismaClient;
  clock: () => Date;
  google: GoogleAuthClient;
  /** SSRF-guarded GET used by the link check (T6.2); tests replace it with a fake. */
  fetchLink: LinkFetcher;
  /** Loads the owner's stored tokens and returns a Gmail client (T2.3). */
  gmail: GmailClientFactory;
  /** Sends and schedules background jobs (T2.4). */
  queue: JobQueue;
};

/** Everything a background job needs: the app dependencies plus a logger. */
export type WorkerCtx = AppDeps & { log: FastifyBaseLogger };

/**
 * The real dependencies. `queue` is the API process's pg-boss (send and schedule only, no
 * workers); the caller starts it. The worker replaces it with its own, see `startWorker`.
 */
export function createDeps(env: Env): AppDeps & { queue: PgBossQueue } {
  const prisma = createPrisma(env.databaseUrl);
  const clock = (): Date => new Date();
  return {
    env,
    prisma,
    clock,
    google: env.google ? createGoogleAuthClient(env.google) : createDisabledGoogleClient(),
    fetchLink: createSafeFetcher(),
    gmail: createGmailClientFactory({ store: createPrismaConnectionStore(prisma), env, clock }),
    queue: new PgBossQueue(createBoss(env.databaseUrl, "api")),
  };
}
