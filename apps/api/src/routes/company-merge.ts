import type { FastifyInstance } from "fastify";
import { ApplicationMergeSchema } from "@offerbound/contracts";
import { withIntakeLock } from "../db/lock.js";
import type { AppDeps } from "../deps.js";
import { ApiError } from "../http/errors.js";
import { toCompanyDto } from "../leads/dto.js";
import { assertId } from "../leads/owner-actions.js";
import { mergeCompanies } from "../review/merge-companies.js";

/**
 * `POST /companies/:id/merge { intoId }` (TECHNICAL_SPEC §10.1; Should): folds this company into
 * another with the same `mergeCompanies` the review queue's *Merge* uses, under the intake lock.
 * Answers the target company. Like the review queue's merge, it writes no timeline event: the
 * moved events keep their place and no event can anchor to a company alone. Register inside the
 * guarded scope.
 *
 * The body is `{ intoId }`, the same shape `ApplicationMergeSchema` parses; the contracts package
 * has no company-specific name for it.
 */
export function registerCompanyMergeRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.post<{ Params: { id: string } }>("/companies/:id/merge", async (request) => {
    const { id } = request.params;
    assertId(id, "company");
    const { intoId } = ApplicationMergeSchema.parse(request.body);
    if (intoId === id) {
      throw new ApiError(400, "validation_failed", "Pick a different company to merge into.", {
        intoId: "same_company",
      });
    }
    assertId(intoId, "company");
    return withIntakeLock(deps.prisma, async (tx) => {
      await mergeCompanies(tx, id, intoId);
      return toCompanyDto(await tx.company.findUniqueOrThrow({ where: { id: intoId } }));
    });
  });
}
