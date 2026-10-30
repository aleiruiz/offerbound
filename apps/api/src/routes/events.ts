import type { FastifyInstance } from "fastify";
import type { UndoResult } from "@offerbound/contracts";
import type { AppDeps } from "../deps.js";
import { undoEvent } from "../undo/service.js";

/** Event routes (TECHNICAL_SPEC §10.1). Register inside the guarded scope. */
export function registerEventRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.post<{ Params: { id: string } }>("/events/:id/undo", async (request): Promise<UndoResult> => {
    await undoEvent(deps.prisma, request.params.id, deps.clock());
    return { undone: true };
  });
}
