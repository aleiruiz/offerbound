import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../deps.js";
import { disconnectGmail, startSyncing, syncNow } from "../gmail/control.js";
import { getSyncStatus } from "../gmail/sync.js";

/** Gmail connection and sync (TECHNICAL_SPEC §10.1). */
export function registerGmailRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/gmail/status", () => getSyncStatus(deps.prisma));

  app.post("/gmail/start", async (_request, reply) => {
    const status = await startSyncing(deps);
    return reply.code(202).send(status);
  });

  app.post("/gmail/sync", async (_request, reply) => {
    await syncNow(deps);
    return reply.code(202).send();
  });

  app.post("/gmail/disconnect", async (_request, reply) => {
    await disconnectGmail(deps);
    return reply.code(204).send();
  });
}
