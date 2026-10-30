import { buildApp } from "./app.js";
import { EnvError, loadEnv } from "./config/env.js";
import { createDeps } from "./deps.js";

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

  const deps = createDeps(env);
  // The API only sends and schedules jobs; the worker runs them. /ready is 503 until this is up.
  await deps.queue.start();
  const app = await buildApp(deps);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await deps.queue.stop();
    await deps.prisma.$disconnect();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ host: "0.0.0.0", port: env.port });
}

main().catch((error: unknown) => {
  console.error("Failed to start:", error instanceof Error ? error.name : "unknown error");
  process.exit(1);
});
