import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";
import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppDeps } from "./deps.js";
import { registerCsrf } from "./http/csrf.js";
import { notFoundHandler, registerErrorHandling } from "./http/errors.js";
import { registerRateLimit } from "./http/rate-limit.js";
import { requireSession } from "./http/session-guard.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerGmailRoutes } from "./routes/gmail.js";
import { registerCompanyRoutes } from "./routes/companies.js";
import { registerCvRoutes } from "./routes/cv.js";
import { registerDailyActivityRoutes } from "./routes/daily-activity.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerImportRoutes } from "./routes/import.js";
import { registerInterviewRoutes } from "./routes/interviews.js";
import { registerLeadRoutes } from "./routes/leads.js";
import { registerMeRoutes } from "./routes/me.js";
import { registerNavCountsRoutes } from "./routes/nav-counts.js";
import { registerOnboardingRoutes } from "./routes/onboarding.js";
import { registerTodayRoutes } from "./routes/today.js";

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
  /** Called for every route as it is registered (not HEAD or OPTIONS). Tests use it to walk routes. */
  onRoute?: (route: { method: string; url: string }) => void;
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

  const { onRoute } = options;
  if (onRoute) {
    app.addHook("onRoute", (route) => {
      for (const method of [route.method].flat()) {
        if (method !== "HEAD" && method !== "OPTIONS") onRoute({ method, url: route.url });
      }
    });
  }

  // No CORS plugin, ever: the API sends no Access-Control-* headers (SECURITY §5).
  registerErrorHandling(app);
  await registerRateLimit(app);
  await app.register(cookie);
  registerCsrf(app);
  // Unknown routes are not routes to the limiter's onRoute hook, so they get the limiter explicitly
  // (header-less mutations are counted by the CSRF hook, which rejects them first).
  app.setNotFoundHandler({ preValidation: app.rateLimit() }, notFoundHandler);

  registerHealthRoutes(app, deps);

  await app.register(
    async (api) => {
      // Demo mode has no sign-in (TECHNICAL_SPEC §4).
      if (deps.env.mode === "private") await registerAuthRoutes(api, deps);

      // Everything below needs a session. Later tasks register their routes here.
      await api.register(async (guarded) => {
        guarded.addHook("preHandler", requireSession(deps));
        registerMeRoutes(guarded, deps);
        registerGmailRoutes(guarded, deps);
        registerOnboardingRoutes(guarded, deps);
        await registerCvRoutes(guarded, deps);
        await registerImportRoutes(guarded, deps);
        registerLeadRoutes(guarded, deps);
        registerCompanyRoutes(guarded, deps);
        registerInterviewRoutes(guarded, deps);
        registerTodayRoutes(guarded, deps);
        registerDailyActivityRoutes(guarded, deps);
        registerNavCountsRoutes(guarded, deps);
      });
    },
    { prefix: "/api/v1" },
  );

  return app;
}
