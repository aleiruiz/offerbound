import type { FastifyInstance } from "fastify";
import type { MessageDetail } from "@offerbound/contracts";
import type { AppDeps } from "../deps.js";
import { getMessageDetail, reprocessMessage } from "../review/service.js";

/**
 * Message routes (TECHNICAL_SPEC §10.1). Register inside the guarded scope. The body is personal
 * content: it is returned, never logged.
 */
export function registerMessageRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get<{ Params: { id: string } }>("/messages/:id", (request): Promise<MessageDetail> =>
    getMessageDetail(deps.prisma, request.params.id),
  );

  app.post<{ Params: { id: string } }>("/messages/:id/reprocess", async (request, reply) => {
    await reprocessMessage({ ...deps, log: request.log }, request.params.id);
    return reply.code(202).send();
  });
}
