import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { encryptToken } from "../auth/crypto.js";
import { GMAIL_READONLY_SCOPE } from "../auth/google.js";
import { createSession, deleteSession } from "../auth/sessions.js";
import type { AppDeps } from "../deps.js";
import { ApiError } from "../http/errors.js";
import { clearSessionCookie, sessionCookieOf, setSessionCookie } from "../http/session-guard.js";
import { getOnboardingCompletedAt } from "../settings/service.js";

const OAUTH_COOKIE = "ob_oauth";
const OAUTH_COOKIE_MAX_AGE_SECONDS = 600;
const OAUTH_COOKIE_ATTRIBUTES = {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/api/v1/auth/google",
} as const;
/** Auth routes: 20 requests per minute per IP (TECHNICAL_SPEC §4). */
const AUTH_RATE_LIMIT = { rateLimit: { max: 20, timeWindow: "1 minute" } } as const;

function redirectUri(deps: Pick<AppDeps, "env">): string {
  return `${deps.env.publicBaseUrl.replace(/\/+$/, "")}/api/v1/auth/google/callback`;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** The States board copy for "signed in with the wrong account" (AC-1.3). */
function notOwnerPage(email: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Offerbound</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:Overpass,system-ui,sans-serif;background:#f6f7f9;color:#1c2430}
[role=alert]{box-sizing:border-box;max-width:420px;margin:16px;padding:16px;border-radius:6px;background:#fbe8e6;color:#5c1612;display:flex;flex-direction:column;gap:10px}
p{margin:0;font-size:14px;line-height:20px}
strong{font-weight:700;color:#b3261e}
a{align-self:flex-start;padding:6px 12px;border:1px solid #b3261e;border-radius:4px;color:#b3261e;font-size:14px;text-decoration:none}
</style>
</head>
<body>
<div role="alert">
<p><strong>This Offerbound is private.</strong> ${escapeHtml(email)} isn't its owner, so nothing was saved.</p>
<a href="/api/v1/auth/google/start">Use another account</a>
</div>
</body>
</html>
`;
}

function clearOauthCookie(reply: FastifyReply): void {
  void reply.clearCookie(OAUTH_COOKIE, OAUTH_COOKIE_ATTRIBUTES);
}

/**
 * Google sign-in (TECHNICAL_SPEC §4, SECURITY §5). Registered outside the session guard. Handlers
 * never log the code, state, nonce, tokens or the email address.
 */
export function registerAuthRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { env, prisma, google } = deps;

  app.get("/auth/google/start", { config: AUTH_RATE_LIMIT }, async (_request, reply) => {
    // Without a stored refresh token Google must be asked to consent again to issue one.
    const connection = await prisma.gmailConnection.findUnique({
      where: { id: 1 },
      select: { refreshTokenEnc: true },
    });
    const prompt = connection?.refreshTokenEnc ? "select_account" : "consent";
    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    void reply.setCookie(OAUTH_COOKIE, `${state}.${nonce}`, {
      ...OAUTH_COOKIE_ATTRIBUTES,
      maxAge: OAUTH_COOKIE_MAX_AGE_SECONDS,
    });
    return reply.redirect(
      google.authUrl({ state, nonce, prompt, redirectUri: redirectUri(deps) }),
      302,
    );
  });

  app.get("/auth/google/callback", { config: AUTH_RATE_LIMIT }, async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const code = typeof query.code === "string" ? query.code : "";
    const state = typeof query.state === "string" ? query.state : "";
    const [cookieState = "", nonce = ""] = (request.cookies[OAUTH_COOKIE] ?? "").split(".");
    // The cookie is single-use whatever happens next.
    clearOauthCookie(reply);

    // Declined at Google's consent screen.
    if (typeof query.error === "string") return reply.redirect("/login?error=denied", 302);
    if (!code || !state || !cookieState || !nonce || !safeEqual(state, cookieState)) {
      return reply.redirect("/login?error=expired", 302);
    }

    let tokens;
    let identity;
    try {
      tokens = await google.exchangeCode(code, redirectUri(deps));
      identity = await google.verifyIdToken(tokens.idToken, nonce);
    } catch (error) {
      request.log.warn({ errorName: (error as Error).name }, "google sign-in failed");
      return reply.redirect("/login?error=expired", 302);
    }

    // The owner is the only account that may sign in (AC-1.2, AC-1.3). Nothing is stored otherwise.
    if (!identity.emailVerified || identity.email.toLowerCase() !== env.ownerEmail) {
      return reply
        .code(403)
        .header("content-type", "text/html; charset=utf-8")
        .header("cache-control", "no-store")
        .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'")
        .send(notOwnerPage(identity.email));
    }

    const key = env.tokenEncryptionKey;
    if (!key) throw new ApiError(500, "internal_error", "Something went wrong.");
    const now = deps.clock();

    const existing = await prisma.gmailConnection.findUnique({ where: { id: 1 } });
    // Google sends a refresh token only on consent. Keep the stored one otherwise, but never one
    // that belongs to a different Google account. An empty string counts as none.
    const newRefresh = tokens.refreshToken ? encryptToken(tokens.refreshToken, key) : null;
    const keptRefresh = existing?.googleSub === identity.sub ? existing.refreshTokenEnc : null;
    const refreshTokenEnc = newRefresh ?? keptRefresh;
    const status = !tokens.scopes.includes(GMAIL_READONLY_SCOPE)
      ? "missing_scope"
      : refreshTokenEnc === null
        ? "needs_reauth"
        : "active";
    const fields = {
      googleSub: identity.sub,
      email: identity.email,
      scopes: tokens.scopes,
      refreshTokenEnc,
      accessTokenEnc: tokens.accessToken ? encryptToken(tokens.accessToken, key) : null,
      accessTokenExpiresAt: tokens.expiresAt,
      status,
      ...(status === "active" ? { lastSyncError: null } : {}),
    } as const;
    await prisma.gmailConnection.upsert({
      where: { id: 1 },
      create: { id: 1, ...fields, backfillSince: new Date(env.gmailBackfillSince) },
      update: fields,
    });

    const session = await createSession(prisma, request.headers["user-agent"] ?? null, now);
    setSessionCookie(reply, session.cookieValue);
    const onboarded = (await getOnboardingCompletedAt(prisma)) !== null;
    return reply.redirect(onboarded ? "/today" : "/onboarding", 302);
  });

  app.post("/auth/logout", { config: AUTH_RATE_LIMIT }, async (request, reply) => {
    const cookieValue = sessionCookieOf(request);
    if (cookieValue) await deleteSession(prisma, cookieValue);
    clearSessionCookie(reply);
    return reply.code(204).send();
  });
}
