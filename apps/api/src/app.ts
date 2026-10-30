import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppDeps } from "./deps.js";
import { registerCsrf } from "./http/csrf.js";
import { notFoundHandler, registerErrorHandling } from "./http/errors.js";
import { registerRateLimit } from "./http/rate-limit.js";
import { registerHealthRoutes } from "./routes/health.js";

/**
 * pino redaction (SECURITY §4, TECHNICAL_SPEC §16). Handlers log ids and codes only; these paths
 * are the backstop for anything that slips through.
 */
export const LOG_REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  "*.token",
  "*.body_text",
  "*.subject",
  "*.snippet",
];

export type BuildAppOptions = {
  /** Destination for log lines; tests use it to inspect what is logged. Defaults to stdout. */
  logStream?: Writable;
};

export async function buildApp(
  deps: AppDeps,
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const { env } = deps;

  const app = Fastify({
    logger: {
      level: env.logLevel,
      redact: { paths: LOG_REDACT_PATHS, censor: "[redacted]" },
      serializers: {
        // The default serializer logs the full URL; OAuth callbacks carry `code` and `state` in it.
        // Headers and bodies are never part of it.
        req: (request) => ({
          method: request.method,
          url: request.url?.split("?")[0],
          // `ip` honours X-Forwarded-For only from trusted proxies (TRUSTED_PROXY_IPS).
          ip: request.ip,
        }),
      },
      ...(options.logStream ? { stream: options.logStream } : {}),
    },
    genReqId: () => randomUUID(),
    trustProxy: env.trustedProxyIps,
  });

  // No CORS plugin, ever: the API sends no Access-Control-* headers (SECURITY §5).
  registerErrorHandling(app);
  await registerRateLimit(app);
  registerCsrf(app);
  // Unknown routes are not routes to the limiter's onRoute hook, so they get the limiter explicitly
  // (header-less mutations are counted by the CSRF hook, which rejects them first).
  app.setNotFoundHandler({ preValidation: app.rateLimit() }, notFoundHandler);

  registerHealthRoutes(app, deps);

  return app;
}
