import type { PrismaClient } from "@prisma/client";
import type { Env } from "./config/env.js";
import { createDisabledGoogleClient, createGoogleAuthClient } from "./auth/google.js";
import type { GoogleAuthClient } from "./auth/google.js";
import { createPrisma } from "./db/prisma.js";

/**
 * Everything the app needs from outside. Later tasks add fields (google, gmail, queue, llm,
 * fetchLink); tests replace any of them with fakes.
 */
export type AppDeps = {
  env: Env;
  prisma: PrismaClient;
  clock: () => Date;
  google: GoogleAuthClient;
};

export function createDeps(env: Env): AppDeps {
  return {
    env,
    prisma: createPrisma(env.databaseUrl),
    clock: () => new Date(),
    google: env.google ? createGoogleAuthClient(env.google) : createDisabledGoogleClient(),
  };
}
