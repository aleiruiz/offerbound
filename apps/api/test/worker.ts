import pino from "pino";
import type { WorkerCtx } from "../src/deps.js";
import { FakeGmailClient, fakeGmailFactory } from "../src/gmail/fake-client.js";
import { buildTestDeps } from "./app.js";
import { RecordingQueue } from "./queue.js";

/**
 * A worker context for integration tests: test environment, shared test database, a clock fixed
 * at 2026-10-01T12:00:00Z, an empty FakeGmailClient and a RecordingQueue. Silent logger.
 */
export function testWorkerCtx(overrides: Partial<WorkerCtx> = {}): WorkerCtx & {
  queue: RecordingQueue;
} {
  const deps = buildTestDeps();
  return {
    ...deps,
    gmail: fakeGmailFactory(new FakeGmailClient([])),
    queue: new RecordingQueue(),
    log: pino({ level: "silent" }),
    ...overrides,
  } as WorkerCtx & { queue: RecordingQueue };
}
