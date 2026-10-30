import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ReviewResolveSchema, type Page, type ReviewItem } from "@offerbound/contracts";
import type { AppDeps } from "../deps.js";
import { VersionConflictError } from "../leads/owner-actions.js";
import { listReviewItems, resolveReviewItem } from "../review/service.js";
import { sendVersionConflict } from "./leads.js";

const ReviewListQuerySchema = z.object({
  state: z.enum(["open", "resolved"]).default("open"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
});

/** Review queue routes (TECHNICAL_SPEC §10.1). Register inside the guarded scope. */
export function registerReviewItemRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/review-items", async (request): Promise<Page<ReviewItem>> => {
    const query = ReviewListQuerySchema.parse(request.query);
    return listReviewItems(deps.prisma, query.state, {
      limit: query.limit,
      cursor: query.cursor ?? null,
    });
  });

  app.post<{ Params: { id: string } }>("/review-items/:id/resolve", async (request, reply) => {
    const body = ReviewResolveSchema.parse(request.body);
    try {
      return await resolveReviewItem({ ...deps, log: request.log }, request.params.id, body);
    } catch (error) {
      if (error instanceof VersionConflictError) return sendVersionConflict(reply, error);
      throw error;
    }
  });
}
