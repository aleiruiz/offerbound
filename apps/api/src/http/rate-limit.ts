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
