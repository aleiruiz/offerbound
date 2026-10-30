import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";
import { ApiError } from "./errors.js";

/** 300 requests per minute per client IP (TECHNICAL_SPEC §4). Later tasks add stricter route limits. */
export const GLOBAL_RATE_LIMIT = { max: 300, timeWindow: "1 minute" } as const;

/**
 * Registers the global limiter. The key is `request.ip`, which honours `X-Forwarded-For` only when
 * the peer is in `trustProxy` (set from TRUSTED_PROXY_IPS). Stricter limits for one route go in
 * that route's `config: { rateLimit: { max, timeWindow } }`.
 */
export async function registerRateLimit(app: FastifyInstance): Promise<void> {
  await app.register(rateLimit, {
    global: true,
    ...GLOBAL_RATE_LIMIT,
    errorResponseBuilder: (_request, context) =>
      new ApiError(429, "rate_limited", `Too many requests. Try again in ${context.after}.`),
  });
}

/** Mutating requests a demo visitor may make per minute and IP (AC-16.7, TECHNICAL_SPEC §4). */
export const DEMO_MUTATION_RATE_LIMIT = { max: 30, timeWindow: "1 minute" } as const;
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * In demo mode every `POST`, `PUT`, `PATCH` and `DELETE` also counts against 30 a minute per
 * client IP, on top of the global limit; the 31st is `429 rate_limited`. The counter is its own,
 * so reads never use it up. Requests the guard or the CSRF check will reject count too: the
 * limit is on what a visitor sends, not on what works.
 */
export function registerDemoMutationLimit(app: FastifyInstance): void {
  const check = app.createRateLimit(DEMO_MUTATION_RATE_LIMIT);
  app.addHook("onRequest", async (request, reply) => {
    if (!MUTATING_METHODS.has(request.method)) return;
    const result = await check(request);
    if (!result.isAllowed && result.isExceeded) {
      void reply.header("retry-after", String(result.ttlInSeconds));
      throw new ApiError(
        429,
        "rate_limited",
        `Too many requests. Try again in ${result.ttlInSeconds} seconds.`,
      );
    }
  });
}
