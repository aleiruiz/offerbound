import { PgBoss } from "pg-boss";

/**
 * Creates the pg-boss instance for the worker. pg-boss keeps its own tables in the `pgboss`
 * schema of the application database and creates or migrates them on `start()`.
 */
export function createBoss(databaseUrl: string): PgBoss {
  return new PgBoss({ connectionString: databaseUrl, application_name: "offerbound-worker" });
}
