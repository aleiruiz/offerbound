import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../deps.js";
import { ApiError } from "../http/errors.js";

const READY_TIMEOUT_MS = 2_000;

/**
 * `/health` is liveness: 200 while the process is up. `/ready` answers 200 only when the
 * database answers `SELECT 1` and the job queue has started (AC-17.1, TECHNICAL_SPEC §16).
 */
export function registerHealthRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/health", () => ({ status: "ok" }));

  app.get("/ready", async (request) => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        deps.prisma.$queryRaw`SELECT 1`,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), READY_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      request.log.warn({ errorName: (error as Error).name }, "readiness check failed");
      throw new ApiError(503, "not_ready", "The service is not ready.");
    } finally {
      clearTimeout(timer);
    }
    if (!deps.queue.isReady()) {
      request.log.warn("readiness check failed: job queue not started");
      throw new ApiError(503, "not_ready", "The service is not ready.");
    }
    return { status: "ready" };
  });
}
