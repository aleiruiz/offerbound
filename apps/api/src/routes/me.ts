import type { FastifyInstance } from "fastify";
import type { Me } from "@offerbound/contracts";
import type { AppDeps } from "../deps.js";
import { getOnboardingCompletedAt } from "../settings/service.js";

/** The `Me` DTO. In demo mode there is no email: every request acts as the demo owner. */
export async function loadMe(deps: AppDeps): Promise<Me> {
  return {
    mode: deps.env.mode,
    email: deps.env.mode === "private" ? deps.env.ownerEmail : null,
    onboardingCompleted: (await getOnboardingCompletedAt(deps.prisma)) !== null,
    timezone: deps.env.userTimezone,
  };
}

export function registerMeRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/me", async () => loadMe(deps));
}
