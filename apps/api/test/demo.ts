import pino from "pino";
import { loadEnv, type Env } from "../src/config/env.js";
import type { AppDeps, WorkerCtx } from "../src/deps.js";
import { createDemoRuntime } from "../src/demo/runtime.js";
import { buildTestApp, buildTestDeps, type TestAppOptions } from "./app.js";
import { testPrisma } from "./db.js";
import { RecordingQueue } from "./queue.js";

/** A demo-mode environment: no secrets, silent logs. */
export function demoTestEnv(): Env {
  return loadEnv({
    APP_MODE: "demo",
    PUBLIC_BASE_URL: "https://demo.offerbound.example",
    DATABASE_URL:
      process.env.DATABASE_URL ??
      "postgresql://offerbound:local-dev-only@localhost:5432/offerbound",
    LOG_LEVEL: "silent",
  });
}

/**
 * Demo dependencies as `createDeps` builds them (fixture mailbox, fixture model, local link
 * check) with a clock the test moves and a recording queue. `clock.now` is mutable.
 */
export function buildDemoDeps(now = new Date("2026-11-02T10:00:00.000Z")): AppDeps & {
  queue: RecordingQueue;
  clock: { now: Date } & (() => Date);
} {
  const prisma = testPrisma();
  const runtime = createDemoRuntime(prisma);
  const clock = Object.assign(() => clock.now, { now });
  return {
    ...buildTestDeps(),
    env: demoTestEnv(),
    clock,
    gmail: runtime.gmail,
    llm: runtime.llm,
    fetchLink: runtime.fetchLink,
    queue: new RecordingQueue(),
  };
}

export async function buildDemoApp(options: TestAppOptions = {}) {
  const deps = buildDemoDeps();
  const built = await buildTestApp(deps, options);
  return { ...built, deps };
}

export function demoWorkerCtx(deps = buildDemoDeps()): WorkerCtx & { queue: RecordingQueue } {
  return { ...deps, log: pino({ level: "silent" }) };
}
