import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../deps.js";
import { simulateEmail } from "../demo/simulate.js";

/**
 * Demo-only routes (TECHNICAL_SPEC §10.1, §12). `buildApp` registers them in demo mode only, so
 * a private instance answers 404.
 *
 * `POST /demo/simulate-email` answers 202 with the id of the email that arrived; by then it has
 * been through triage, extraction and apply.
 */
export function registerDemoRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.post("/demo/simulate-email", async (request, reply) => {
    const { messageId } = await simulateEmail({ ...deps, log: request.log });
    return reply.code(202).send({ messageId });
  });
}
