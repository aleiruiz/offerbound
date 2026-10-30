import { PgBoss } from "pg-boss";

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
