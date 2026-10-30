import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import {
  readSession,
  SESSION_COOKIE_MAX_AGE_SECONDS,
  SESSION_COOKIE_NAME,
} from "../auth/sessions.js";
import type { AppDeps } from "../deps.js";
import { ApiError } from "./errors.js";

/** Attributes shared by setting and clearing `ob_session` (SECURITY §5). */
const SESSION_COOKIE_ATTRIBUTES = {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
} as const;

export function setSessionCookie(reply: FastifyReply, cookieValue: string): void {
  void reply.setCookie(SESSION_COOKIE_NAME, cookieValue, {
    ...SESSION_COOKIE_ATTRIBUTES,
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  void reply.clearCookie(SESSION_COOKIE_NAME, SESSION_COOKIE_ATTRIBUTES);
}

export function sessionCookieOf(request: FastifyRequest): string | undefined {
  const value = request.cookies[SESSION_COOKIE_NAME];
  return value === undefined || value === "" ? undefined : value;
}

/**
 * preHandler for every `/api/v1` route except `/auth/*` (AC-1.1). A valid session passes; a
 * session with fewer than 7 days left is renewed and its cookie re-sent (AC-1.4). Skipped in
 * demo mode, where every request acts as the demo owner.
 */
export function requireSession(
  deps: Pick<AppDeps, "env" | "prisma" | "clock">,
): preHandlerAsyncHookHandler {
  return async (request, reply) => {
    if (deps.env.mode === "demo") return;
    const cookieValue = sessionCookieOf(request);
    const session = cookieValue ? await readSession(deps.prisma, cookieValue, deps.clock()) : null;
    if (!cookieValue || !session) {
      throw new ApiError(401, "unauthenticated", "Sign in to continue.");
    }
    if (session.renewedExpiresAt) setSessionCookie(reply, cookieValue);
  };
}
