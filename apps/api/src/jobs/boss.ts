import type { Settings } from "@offerbound/contracts";
import { PgBoss } from "pg-boss";
import { QUEUES, type JobQueue, type QueueName } from "./queues.js";

/**
 * Creates the pg-boss instance. pg-boss keeps its own tables in the `pgboss` schema of the
 * application database and creates or migrates them on `start()`.
 *
 * The worker runs the schedules and queue maintenance. The API process only sends and schedules
 * jobs (`role: "api"`), so it runs neither.
 */
export function createBoss(databaseUrl: string, role: "api" | "worker" = "worker"): PgBoss {
  return new PgBoss({
    connectionString: databaseUrl,
    application_name: `offerbound-${role}`,
    ...(role === "api" ? { schedule: false, supervise: false } : {}),
  });
}

/** A recurring job and its cron expression (evaluated in the owner's time zone). */
export type Schedule = { name: QueueName; cron: string };

/**
 * The recurring jobs the worker registers (TECHNICAL_SPEC §9). Private mode backs up nightly;
 * demo mode resets hourly instead. `gmail.sync` is scheduled by *Start syncing* (T2.4) and
 * `search.run` from the search settings (T6.4), so neither is listed here. `settings` is part of
 * the signature for schedules that depend on it; none of these do.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- part of the agreed signature
export function schedulesFor(mode: "private" | "demo", _settings: Settings): Schedule[] {
  return [
    { name: QUEUES.emailTriage, cron: "* * * * *" },
    { name: QUEUES.emailApply, cron: "* * * * *" },
    { name: QUEUES.timersTick, cron: "*/15 * * * *" },
    mode === "demo"
      ? { name: QUEUES.demoReset, cron: "0 * * * *" }
      : { name: QUEUES.backupNightly, cron: "30 3 * * *" },
    { name: QUEUES.maintenanceDaily, cron: "0 4 * * *" },
    // The demo's postings are fictional: checking them would dismiss every one.
    ...(mode === "private" ? [{ name: QUEUES.leadsRecheck, cron: "30 4 * * *" }] : []),
  ];
}

/**
 * Registers `schedulesFor(mode)` with `tz` (`USER_TIMEZONE`), only for the queues in `handled`
 * when given, and removes the schedule that belongs to the other mode, since pg-boss keeps
 * schedules in the database between deploys.
 */
export async function registerSchedules(
  queue: JobQueue,
  mode: "private" | "demo",
  settings: Settings,
  tz: string,
  handled?: ReadonlySet<QueueName>,
): Promise<void> {
  for (const { name, cron } of schedulesFor(mode, settings)) {
    if (handled && !handled.has(name)) continue;
    await queue.schedule(name, cron, { tz });
  }
  await queue.unschedule(mode === "demo" ? QUEUES.backupNightly : QUEUES.demoReset);
  if (mode === "demo") await queue.unschedule(QUEUES.leadsRecheck);
}
