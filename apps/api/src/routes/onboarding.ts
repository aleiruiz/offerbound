import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../deps.js";
import { setOnboardingCompleted } from "../settings/service.js";
import { loadMe } from "./me.js";

export function registerOnboardingRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.post("/onboarding/complete", async () => {
    await setOnboardingCompleted(deps.prisma, deps.clock());
    return loadMe(deps);
  });
}
