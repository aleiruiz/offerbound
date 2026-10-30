import type { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { buildApp, type BuildAppOptions } from "../src/app.js";
import { loadEnv, type Env } from "../src/config/env.js";
import type { AppDeps } from "../src/deps.js";
import { createSession } from "../src/auth/sessions.js";
import { testPrisma } from "./db.js";
import { FakeGoogleAuthClient } from "./fake-google.js";

/** A complete private-mode environment with fictional values; logging is silent. */
export function testEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv({
    APP_MODE: "private",
    PUBLIC_BASE_URL: "https://offerbound.example",
    DATABASE_URL:
      process.env.DATABASE_URL ??
      "postgresql://offerbound:local-dev-only@localhost:5432/offerbound",
    OWNER_EMAIL: "owner@example.com",
    GOOGLE_CLIENT_ID: "test-client-id.example",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    OPENAI_API_KEY: "test-openai-key",
    AI_PRICING: JSON.stringify({
      "gpt-6-luna": {
        inputPerMTokMicros: 1_000_000,
        cachedInputPerMTokMicros: 100_000,
        outputPerMTokMicros: 4_000_000,
      },
    }),
    AI_WEB_SEARCH_COST_PER_CALL_MICROS: "10000",
    LOG_LEVEL: "silent",
    ...overrides,
  });
}

export type TestAppOptions = { logStream?: Writable; onRoute?: BuildAppOptions["onRoute"] };

/**
 * Builds the app against the test database with a fixed environment. Later tasks add fakes for
 * the dependencies they introduce. `app.close()` does not disconnect the shared test Prisma client.
 */
export async function buildTestApp(
  overrides: Partial<AppDeps> = {},
  options: TestAppOptions = {},
): Promise<{ app: FastifyInstance; deps: AppDeps }> {
  const deps: AppDeps = {
    env: testEnv(),
    prisma: testPrisma(),
    clock: () => new Date("2026-10-01T12:00:00.000Z"),
    google: new FakeGoogleAuthClient(),
    ...overrides,
  };
  const app = await buildApp(deps, {
    ...(options.logStream ? { logStream: options.logStream } : {}),
    ...(options.onRoute ? { onRoute: options.onRoute } : {}),
  });
  return { app, deps };
}

/** Creates a session row and returns the `Cookie` header value that carries it. */
export async function signIn(
  _app: FastifyInstance,
  deps: Pick<AppDeps, "prisma" | "clock">,
): Promise<string> {
  const { cookieValue } = await createSession(deps.prisma, "vitest", deps.clock());
  return `ob_session=${cookieValue}`;
}
