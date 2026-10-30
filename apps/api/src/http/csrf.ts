import type { FastifyInstance } from "fastify";
import { API_ERROR_STATUS } from "@offerbound/contracts";
import { errorBody } from "./errors.js";

export const CSRF_HEADER = "x-offerbound-request";
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Every mutating request must carry `X-Offerbound-Request: 1` (AC-1.5, SECURITY §5). A custom
 * header cannot be sent cross-site without a CORS preflight, which the API never grants.
 *
 * The check runs in `preParsing`: after the rate limiter (an `onRequest` hook) so rejected
 * requests are still counted, and before the body is read. It also covers unknown routes. Those
 * have no `onRequest` limiter (they are not routes to the limiter's `onRoute` hook) and their
 * limiter runs in `preValidation`, after this hook, so a rejected one is counted here instead.
 */
export function registerCsrf(app: FastifyInstance): void {
  app.addHook("preParsing", async (request, reply) => {
    if (!MUTATING_METHODS.has(request.method)) return;
    if (request.headers[CSRF_HEADER] === "1") return;
    // Throws the 429 when the client is over the limit. Counting only on this rejection path keeps
    // a request that passes the check from being counted twice.
    if (request.is404) await app.rateLimit().call(app, request, reply);
    return reply
      .code(API_ERROR_STATUS.csrf_header_missing)
      .send(errorBody("csrf_header_missing", "The X-Offerbound-Request header is required."));
  });
}
