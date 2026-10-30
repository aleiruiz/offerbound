import type { FastifyInstance } from "fastify";
import { CompanyPatchSchema } from "@offerbound/contracts";
import type { AppDeps } from "../deps.js";
import { patchCompany } from "../leads/company-edit.js";
import { exclusionListText } from "../leads/exclusions.js";
import { VersionConflictError } from "../leads/owner-actions.js";
import { sendVersionConflict } from "./leads.js";

/** Company routes (TECHNICAL_SPEC §10.1). Register inside the guarded scope. */
export function registerCompanyRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.patch<{ Params: { id: string } }>("/companies/:id", async (request, reply) => {
    const body = CompanyPatchSchema.parse(request.body);
    try {
      return await patchCompany(deps.prisma, request.params.id, body, deps.clock());
    } catch (error) {
      if (error instanceof VersionConflictError) return sendVersionConflict(reply, error);
      throw error;
    }
  });

  // Every company already seen, one name per line with its aliases indented below (AC-9.5).
  app.get("/companies/exclusion-list", async (_request, reply) => {
    const text = await exclusionListText(deps.prisma);
    return reply
      .header("content-type", "text/plain; charset=utf-8")
      .header("cache-control", "no-store")
      .send(text);
  });
}
