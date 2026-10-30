import type { FastifyInstance, FastifyReply } from "fastify";
import {
  API_ERROR_STATUS,
  LeadCreateSchema,
  LeadPatchSchema,
  LeadRerankSchema,
  LeadsQuerySchema,
  type ApplicationDetail,
  type Lead,
  type Page,
} from "@offerbound/contracts";
import type { AppDeps } from "../deps.js";
import { errorBody } from "../http/errors.js";
import {
  createManualLead,
  listLeads,
  loadNewApplicationDetail,
  markLeadApplied,
  patchLead,
  reconsiderLead,
  rerankNewLeads,
  VersionConflictError,
} from "../leads/owner-actions.js";

/**
 * Sends a stale-version answer as `{ error, current }` (TECHNICAL_SPEC §10: "409 version_conflict
 * with the current record"); the web client keeps the extra key and refreshes from it.
 */
export function sendVersionConflict(reply: FastifyReply, error: VersionConflictError<unknown>) {
  return reply
    .code(API_ERROR_STATUS.version_conflict)
    .send({ ...errorBody("version_conflict", error.message), current: error.current });
}

/**
 * Lead routes (TECHNICAL_SPEC §10.1). Register inside the guarded scope. `POST /leads/rerank` is a
 * static path next to `/leads/:id/...` and wins over it.
 */
export function registerLeadRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/leads", async (request): Promise<Page<Lead>> => {
    return listLeads(deps.prisma, LeadsQuerySchema.parse(request.query));
  });

  app.post("/leads", async (request, reply): Promise<Lead> => {
    const input = LeadCreateSchema.parse(request.body);
    const lead = await createManualLead({ ...deps, log: request.log }, input);
    return reply.code(201).send(lead);
  });

  app.post("/leads/rerank", async (request, reply) => {
    LeadRerankSchema.parse(request.body);
    await rerankNewLeads({ ...deps, log: request.log });
    return reply.code(202).send();
  });

  app.patch<{ Params: { id: string } }>("/leads/:id", async (request, reply) => {
    const body = LeadPatchSchema.parse(request.body);
    try {
      return await patchLead({ ...deps, log: request.log }, request.params.id, body);
    } catch (error) {
      if (error instanceof VersionConflictError) return sendVersionConflict(reply, error);
      throw error;
    }
  });

  app.post<{ Params: { id: string } }>("/leads/:id/mark-applied", async (request, reply) => {
    try {
      const applicationId = await markLeadApplied(deps, request.params.id, deps.clock());
      const detail: ApplicationDetail = await loadNewApplicationDetail(deps.prisma, applicationId);
      return await reply.code(201).send(detail);
    } catch (error) {
      if (error instanceof VersionConflictError) return sendVersionConflict(reply, error);
      throw error;
    }
  });

  app.post<{ Params: { id: string } }>("/leads/:id/reconsider", async (request, reply) => {
    try {
      return await reconsiderLead({ ...deps, log: request.log }, request.params.id);
    } catch (error) {
      if (error instanceof VersionConflictError) return sendVersionConflict(reply, error);
      throw error;
    }
  });
}
