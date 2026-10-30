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
import { FakeLlmProvider } from "./llm/fake-provider.js";
import { OpenAiProvider } from "./llm/openai-provider.js";
import type { LlmProvider } from "./llm/provider.js";
import type { WarnLogger } from "./llm/record.js";

/** Everything the app needs from outside. Tests replace any of it with fakes. */
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
  /** The model provider (T3.2); tests replace it with `FakeLlmProvider`. */
  llm: LlmProvider;
};

/** Everything a background job needs: the app dependencies plus a logger. */
export type WorkerCtx = AppDeps & { log: FastifyBaseLogger };

/** The real provider in private mode; the fixture-backed fake in demo mode, which has no key. */
function createLlm(env: Env, prisma: PrismaClient, log?: WarnLogger): LlmProvider {
  if (!env.openai) return FakeLlmProvider.fromFixtures({ emails: [], leadBatches: [], db: prisma });
  return new OpenAiProvider(
    {
      apiKey: env.openai.apiKey,
      models: env.openai.models,
      efforts: env.openai.efforts,
      pricing: env.aiPricing,
      webSearchCostPerCallMicros: env.webSearchCostPerCallMicros,
      searchMaxToolCallsPerRound: env.searchMaxToolCallsPerRound,
    },
    prisma,
    undefined,
    log,
  );
}

/**
 * The real dependencies. `queue` is the API process's pg-boss (send and schedule only, no
 * workers); the caller starts it. The worker replaces it with its own, see `startWorker`.
 * `log` receives the LLM layer's warnings (cost unknown, usage not recorded); it carries no content.
 */
export function createDeps(env: Env, log?: WarnLogger): AppDeps & { queue: PgBossQueue } {
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
    llm: createLlm(env, prisma, log),
  };
}
