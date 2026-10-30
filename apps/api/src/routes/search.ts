import type { FastifyInstance } from "fastify";
import type { SearchRun } from "@offerbound/contracts";
import type { AppDeps } from "../deps.js";
import { listSearchRuns, requestSearchRun } from "../leads/search.js";

/**
 * Search routes (TECHNICAL_SPEC §10.1). Register inside the guarded scope.
 *
 * `POST /search/run` only creates the `running` record and queues `search.run`, then answers
 * `202` with the record; the worker does the rounds. `409 already_running` when a run exists.
 * `GET /search/runs` lists the last 14 runs, newest first (AC-10.5).
 */
export function registerSearchRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/search/runs", async (): Promise<SearchRun[]> => listSearchRuns(deps.prisma));

  app.post("/search/run", async (_request, reply): Promise<SearchRun> => {
    const run = await requestSearchRun(deps, "manual");
    return reply.code(202).send(run);
  });
}
