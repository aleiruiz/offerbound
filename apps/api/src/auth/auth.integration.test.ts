import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiErrorBodySchema, DEFAULT_SETTINGS, MeSchema } from "@offerbound/contracts";
import { loadEnv } from "../config/env.js";
import { buildTestApp, signIn, testEnv } from "../../test/app.js";
import { resetDb, testPrisma } from "../../test/db.js";
import type { FakeGoogleAuthClient } from "../../test/fake-google.js";
import { decryptToken, encryptToken } from "./crypto.js";
import { createGoogleAuthClient, GOOGLE_SCOPES } from "./google.js";
import { createSession } from "./sessions.js";
import {
  getOnboardingCompletedAt,
  getSettings,
  saveSettings,
  setOnboardingCompleted,
} from "../settings/service.js";

const prisma = testPrisma();
const CSRF = { "x-offerbound-request": "1" };
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-01T12:00:00.000Z");
const GMAIL = "https://www.googleapis.com/auth/gmail.readonly";

const apps: FastifyInstance[] = [];
async function appWith(...args: Parameters<typeof buildTestApp>) {
  const built = await buildTestApp(...args);
  apps.push(built.app);
  const google = built.deps.google as FakeGoogleAuthClient;
  return { ...built, google };
}

beforeEach(async () => {
  await resetDb(prisma);
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

type Injected = Awaited<ReturnType<FastifyInstance["inject"]>>;

function cookieOf(res: Injected, name: string) {
  return res.cookies.find((c) => c.name === name);
}

/** Runs /start and returns the callback URL and Cookie header that a browser would send. */
async function begin(app: FastifyInstance, google: FakeGoogleAuthClient) {
  const res = await app.inject({ method: "GET", url: "/api/v1/auth/google/start" });
  expect(res.statusCode).toBe(302);
  const oauth = cookieOf(res, "ob_oauth");
  const last = google.authUrls.at(-1);
  if (!oauth || !last) throw new Error("start did not set the oauth cookie");
  return { oauthCookie: `ob_oauth=${oauth.value}`, state: last.state, nonce: last.nonce };
}

async function callback(
  app: FastifyInstance,
  google: FakeGoogleAuthClient,
  overrides: { state?: string; code?: string | null; cookie?: string | null; query?: string } = {},
) {
  const { oauthCookie, state } = await begin(app, google);
  const params = new URLSearchParams();
  if (overrides.code !== null) params.set("code", overrides.code ?? "auth-code-1");
  params.set("state", overrides.state ?? state);
  const cookie = overrides.cookie === undefined ? oauthCookie : overrides.cookie;
  return app.inject({
    method: "GET",
    url: `/api/v1/auth/google/callback?${overrides.query ?? params.toString()}`,
    ...(cookie ? { headers: { cookie } } : {}),
  });
}

async function seedConnection(
  key: Buffer,
  overrides: { refresh?: string | null; status?: "active" | "needs_reauth" } = {},
) {
  const refresh = overrides.refresh === undefined ? "stored-refresh-token" : overrides.refresh;
  await prisma.gmailConnection.create({
    data: {
      id: 1,
      googleSub: "google-sub-owner",
      email: "owner@example.com",
      scopes: [...GOOGLE_SCOPES],
      refreshTokenEnc: refresh === null ? null : encryptToken(refresh, key),
      status: overrides.status ?? "active",
      backfillSince: new Date("2026-09-01"),
    },
  });
}

describe("GET /auth/google/start", () => {
  it("redirects with the four scopes, access_type=offline and include_granted_scopes=true", async () => {
    // The real client builds the URL locally; nothing is sent to Google.
    const google = createGoogleAuthClient({
      clientId: "test-client-id.example",
      clientSecret: "s",
    });
    const { app } = await appWith({ google });
    const res = await app.inject({ method: "GET", url: "/api/v1/auth/google/start" });
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.origin + location.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    const q = location.searchParams;
    expect(q.get("scope")?.split(" ").sort()).toEqual(["openid", "email", "profile", GMAIL].sort());
    expect(q.get("access_type")).toBe("offline");
    expect(q.get("include_granted_scopes")).toBe("true");
    expect(q.get("response_type")).toBe("code");
    expect(q.get("client_id")).toBe("test-client-id.example");
    expect(q.get("redirect_uri")).toBe("https://offerbound.example/api/v1/auth/google/callback");
    expect(q.get("state")).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(q.get("nonce")).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(q.get("prompt")).toBe("consent");
  });

  it("uses prompt=consent without a stored refresh token and prompt=select_account with one", async () => {
    const { app, google, deps } = await appWith();
    await app.inject({ method: "GET", url: "/api/v1/auth/google/start" });
    expect(google.authUrls.at(-1)?.prompt).toBe("consent");
    expect(google.authUrls.at(-1)?.redirectUri).toBe(
      "https://offerbound.example/api/v1/auth/google/callback",
    );

    await seedConnection(deps.env.tokenEncryptionKey as Buffer);
    await app.inject({ method: "GET", url: "/api/v1/auth/google/start" });
    expect(google.authUrls.at(-1)?.prompt).toBe("select_account");

    await prisma.gmailConnection.update({
      where: { id: 1 },
      data: { refreshTokenEnc: null, status: "needs_reauth" },
    });
    await app.inject({ method: "GET", url: "/api/v1/auth/google/start" });
    expect(google.authUrls.at(-1)?.prompt).toBe("consent");
  });

  it("sets ob_oauth (HttpOnly, Secure, SameSite=Lax, Max-Age=600)", async () => {
    const { app } = await appWith();
    const res = await app.inject({ method: "GET", url: "/api/v1/auth/google/start" });
    const cookie = cookieOf(res, "ob_oauth");
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax", maxAge: 600 });
    expect(cookie?.value.length).toBeGreaterThan(40);
  });
});

describe("GET /auth/google/callback", () => {
  it("with a mismatched state → 302 /login?error=expired and no session", async () => {
    const { app, google } = await appWith();
    const res = await callback(app, google, { state: "some-other-state" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/login?error=expired");
    expect(cookieOf(res, "ob_session")).toBeUndefined();
    expect(google.exchanged).toHaveLength(0);
    expect(await prisma.session.count()).toBe(0);
    expect(await prisma.gmailConnection.count()).toBe(0);
  });

  it("without the oauth cookie or a code → 302 /login?error=expired", async () => {
    const { app, google } = await appWith();
    const noCookie = await callback(app, google, { cookie: null });
    expect(noCookie.headers.location).toBe("/login?error=expired");
    const noCode = await callback(app, google, { code: null });
    expect(noCode.headers.location).toBe("/login?error=expired");
    expect(google.exchanged).toHaveLength(0);
  });

  it("when the owner cancels at Google → 302 /login?error=denied", async () => {
    const { app, google } = await appWith();
    const res = await callback(app, google, { query: "error=access_denied" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/login?error=denied");
    expect(await prisma.session.count()).toBe(0);
  });

  it("a token that fails verification → 302 /login?error=expired and nothing stored", async () => {
    const { app, google } = await appWith();
    google.verifyIdToken = () => Promise.reject(new Error("bad nonce"));
    const res = await callback(app, google);
    expect(res.headers.location).toBe("/login?error=expired");
    expect(await prisma.session.count()).toBe(0);
    expect(await prisma.gmailConnection.count()).toBe(0);
  });

  it("passes the nonce from the oauth cookie to id token verification", async () => {
    const { app, google } = await appWith();
    const { oauthCookie, state, nonce } = await begin(app, google);
    await app.inject({
      method: "GET",
      url: `/api/v1/auth/google/callback?code=c1&state=${state}`,
      headers: { cookie: oauthCookie },
    });
    expect(google.verified).toEqual([{ idToken: "fake-id-token", nonce }]);
    expect(google.exchanged[0]?.redirectUri).toBe(
      "https://offerbound.example/api/v1/auth/google/callback",
    );
  });

  it("for another account → 403 HTML 'This Offerbound is private.' and stores no session and no gmail_connection", async () => {
    const { app, google } = await appWith();
    google.identity = { sub: "sub-x", email: "someone@gmail.example", emailVerified: true };
    const res = await callback(app, google);
    expect(res.statusCode).toBe(403);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("This Offerbound is private.");
    expect(res.body).toContain("someone@gmail.example isn't its owner, so nothing was saved.");
    expect(res.body).toContain("Use another account");
    expect(res.body).toContain('href="/api/v1/auth/google/start"');
    expect(cookieOf(res, "ob_session")).toBeUndefined();
    expect(await prisma.session.count()).toBe(0);
    expect(await prisma.gmailConnection.count()).toBe(0);
  });

  it("escapes the signed-in email in the 403 page", async () => {
    const { app, google } = await appWith();
    google.identity = { sub: "s", email: "<script>x</script>@evil.example", emailVerified: true };
    const res = await callback(app, google);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain("<script>");
    expect(res.body).toContain("&lt;script&gt;");
  });

  it("matches OWNER_EMAIL case-insensitively and requires email_verified", async () => {
    const { app, google } = await appWith();
    google.identity = { sub: "s1", email: "Owner@Example.COM", emailVerified: true };
    const ok = await callback(app, google);
    expect(ok.statusCode).toBe(302);
    expect(cookieOf(ok, "ob_session")).toBeDefined();

    await resetDb(prisma);
    google.identity = { sub: "s1", email: "owner@example.com", emailVerified: false };
    const unverified = await callback(app, google);
    expect(unverified.statusCode).toBe(403);
    expect(await prisma.session.count()).toBe(0);
    expect(await prisma.gmailConnection.count()).toBe(0);
  });

  it("owner callback sets ob_session (HttpOnly, Secure, SameSite=Lax, Path=/, Max-Age=2592000)", async () => {
    const { app, google } = await appWith();
    const res = await callback(app, google);
    const session = cookieOf(res, "ob_session");
    expect(session).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 2_592_000,
    });
    expect(session?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await prisma.session.count()).toBe(1);
    // The one-time oauth cookie is cleared.
    expect(cookieOf(res, "ob_oauth")).toMatchObject({ value: "", maxAge: 0 });
  });

  it("owner callback redirects to /onboarding until onboarding completes, then to /today", async () => {
    const { app, google, deps } = await appWith();
    const first = await callback(app, google);
    expect(first.statusCode).toBe(302);
    expect(first.headers.location).toBe("/onboarding");

    await setOnboardingCompleted(prisma, deps.clock());
    const second = await callback(app, google);
    expect(second.headers.location).toBe("/today");
  });

  it("owner callback stores encrypted tokens and scopes with status active", async () => {
    const { app, google, deps } = await appWith();
    google.exchange = {
      ...google.exchange,
      accessToken: "access-plain",
      refreshToken: "refresh-plain",
      expiresAt: new Date("2026-10-01T13:00:00.000Z"),
    };
    await callback(app, google);
    const row = await prisma.gmailConnection.findUniqueOrThrow({ where: { id: 1 } });
    const key = deps.env.tokenEncryptionKey as Buffer;
    expect(row.status).toBe("active");
    expect(row.googleSub).toBe("google-sub-owner");
    expect(row.email).toBe("owner@example.com");
    expect([...row.scopes].sort()).toEqual([...GOOGLE_SCOPES].sort());
    expect(row.refreshTokenEnc).toMatch(/^v1:/);
    expect(row.refreshTokenEnc).not.toContain("refresh-plain");
    expect(decryptToken(row.refreshTokenEnc as string, key)).toBe("refresh-plain");
    expect(decryptToken(row.accessTokenEnc as string, key)).toBe("access-plain");
    expect(row.accessTokenExpiresAt).toEqual(new Date("2026-10-01T13:00:00.000Z"));
    expect(row.backfillSince.toISOString().slice(0, 10)).toBe("2026-09-01");
  });

  it("without gmail.readonly the connection status is missing_scope", async () => {
    const { app, google } = await appWith();
    google.exchange = { ...google.exchange, scopes: ["openid", "email", "profile"] };
    const res = await callback(app, google);
    expect(res.statusCode).toBe(302);
    expect(cookieOf(res, "ob_session")).toBeDefined();
    const row = await prisma.gmailConnection.findUniqueOrThrow({ where: { id: 1 } });
    expect(row.status).toBe("missing_scope");
    expect(row.scopes).not.toContain(GMAIL);
  });

  it("without a refresh token and none stored the status is needs_reauth", async () => {
    const { app, google } = await appWith();
    google.exchange = { ...google.exchange, refreshToken: null };
    await callback(app, google);
    const row = await prisma.gmailConnection.findUniqueOrThrow({ where: { id: 1 } });
    expect(row.status).toBe("needs_reauth");
    expect(row.refreshTokenEnc).toBeNull();
    expect(row.accessTokenEnc).not.toBeNull();
  });

  it("treats an empty refresh token like a missing one", async () => {
    const { app, google } = await appWith();
    google.exchange = { ...google.exchange, refreshToken: "" };
    const res = await callback(app, google);
    expect(res.statusCode).toBe(302);
    const row = await prisma.gmailConnection.findUniqueOrThrow({ where: { id: 1 } });
    expect(row.status).toBe("needs_reauth");
    expect(row.refreshTokenEnc).toBeNull();
  });

  it("keeps the stored refresh token when Google returns none", async () => {
    const { app, google, deps } = await appWith();
    const key = deps.env.tokenEncryptionKey as Buffer;
    await seedConnection(key, { refresh: "stored-refresh-token" });
    google.exchange = { ...google.exchange, refreshToken: null };
    await callback(app, google);
    const row = await prisma.gmailConnection.findUniqueOrThrow({ where: { id: 1 } });
    expect(row.status).toBe("active");
    expect(decryptToken(row.refreshTokenEnc as string, key)).toBe("stored-refresh-token");
  });

  it("replaces the stored refresh token when Google returns a new one, and recovers needs_reauth", async () => {
    const { app, google, deps } = await appWith();
    const key = deps.env.tokenEncryptionKey as Buffer;
    await seedConnection(key, { refresh: null, status: "needs_reauth" });
    google.exchange = { ...google.exchange, refreshToken: "new-refresh" };
    await callback(app, google);
    const row = await prisma.gmailConnection.findUniqueOrThrow({ where: { id: 1 } });
    expect(row.status).toBe("active");
    expect(decryptToken(row.refreshTokenEnc as string, key)).toBe("new-refresh");
    expect(await prisma.gmailConnection.count()).toBe(1);
  });

  it("never logs codes, state, nonce, tokens or the email address", async () => {
    const lines: string[] = [];
    const logStream = new Writable({
      write(chunk: Buffer, _enc, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const env = testEnv({ LOG_LEVEL: "debug" });
    const { app, deps } = await buildTestApp({ env }, { logStream });
    apps.push(app);
    const google = deps.google as FakeGoogleAuthClient;
    google.exchange = {
      ...google.exchange,
      accessToken: "secret-access-token",
      refreshToken: "secret-refresh-token",
    };
    const res = await callback(app, google, { code: "secret-auth-code" });
    const session = cookieOf(res, "ob_session")?.value as string;
    const state = google.authUrls.at(-1)?.state as string;
    const nonce = google.authUrls.at(-1)?.nonce as string;
    const out = lines.join("");
    expect(out.length).toBeGreaterThan(0);
    for (const secret of [
      "secret-auth-code",
      "secret-access-token",
      "secret-refresh-token",
      "fake-id-token",
      "owner@example.com",
      session,
      state,
      nonce,
    ]) {
      expect(out).not.toContain(secret);
    }
  });
});

describe("session guard", () => {
  it("an /api/v1 route without a session → 401 unauthenticated", async () => {
    const { app } = await appWith();
    const res = await app.inject({ method: "GET", url: "/api/v1/me" });
    expect(res.statusCode).toBe(401);
    expect(ApiErrorBodySchema.parse(res.json()).error.code).toBe("unauthenticated");
    const bogus = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: `ob_session=${"A".repeat(43)}` },
    });
    expect(bogus.statusCode).toBe(401);
  });

  it("a session with 6 days left is renewed to 30 days; an expired one → 401", async () => {
    const { app, deps } = await appWith();
    const sixDays = await createSession(prisma, null, new Date(NOW.getTime() - 24 * DAY));
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: `ob_session=${sixDays.cookieValue}` },
    });
    expect(res.statusCode).toBe(200);
    expect(cookieOf(res, "ob_session")).toMatchObject({
      value: sixDays.cookieValue,
      maxAge: 2_592_000,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
    });
    const row = await prisma.session.findFirstOrThrow();
    expect(row.expiresAt).toEqual(new Date(deps.clock().getTime() + 30 * DAY));

    // A session with more than 7 days left is not re-sent.
    const fresh = await createSession(prisma, null, NOW);
    const ok = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: `ob_session=${fresh.cookieValue}` },
    });
    expect(ok.statusCode).toBe(200);
    expect(cookieOf(ok, "ob_session")).toBeUndefined();

    const old = await createSession(prisma, null, new Date(NOW.getTime() - 31 * DAY));
    const expired = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: `ob_session=${old.cookieValue}` },
    });
    expect(expired.statusCode).toBe(401);
  });

  it("is skipped in demo mode, where /me reports the demo owner", async () => {
    const env = loadEnv({
      APP_MODE: "demo",
      PUBLIC_BASE_URL: "https://demo.offerbound.example",
      DATABASE_URL: process.env.DATABASE_URL ?? "",
      LOG_LEVEL: "silent",
    });
    const { app } = await appWith({ env });
    const res = await app.inject({ method: "GET", url: "/api/v1/me" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ mode: "demo", email: null });
    // No auth routes in demo mode.
    const start = await app.inject({ method: "GET", url: "/api/v1/auth/google/start" });
    expect(start.statusCode).toBe(404);
  });
});

describe("POST /auth/logout", () => {
  it("deletes the session row and clears the cookie", async () => {
    const { app, deps } = await appWith();
    const cookie = await signIn(app, deps);
    expect(await prisma.session.count()).toBe(1);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { ...CSRF, cookie },
    });
    expect(res.statusCode).toBe(204);
    expect(await prisma.session.count()).toBe(0);
    expect(cookieOf(res, "ob_session")).toMatchObject({ value: "", maxAge: 0, path: "/" });
    const after = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });

  it("still answers 204 without a session, and needs the CSRF header", async () => {
    const { app } = await appWith();
    const ok = await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: CSRF });
    expect(ok.statusCode).toBe(204);
    const blocked = await app.inject({ method: "POST", url: "/api/v1/auth/logout" });
    expect(blocked.statusCode).toBe(403);
  });
});

describe("GET /me and POST /onboarding/complete", () => {
  it("GET /me → { mode: 'private', email, onboardingCompleted, timezone: 'America/Monterrey' }", async () => {
    const { app, deps } = await appWith();
    const cookie = await signIn(app, deps);
    const res = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const me = MeSchema.parse(res.json());
    expect(me).toEqual({
      mode: "private",
      email: "owner@example.com",
      onboardingCompleted: false,
      timezone: "America/Monterrey",
    });
  });

  it("POST /onboarding/complete sets onboarding.completedAt", async () => {
    const { app, deps } = await appWith();
    const cookie = await signIn(app, deps);
    expect(await getOnboardingCompletedAt(prisma)).toBeNull();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/onboarding/complete",
      headers: { ...CSRF, cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(MeSchema.parse(res.json()).onboardingCompleted).toBe(true);
    expect(await getOnboardingCompletedAt(prisma)).toEqual(deps.clock());
    const row = await prisma.setting.findUniqueOrThrow({ where: { key: "onboarding" } });
    expect(row.value).toEqual({ completedAt: deps.clock().toISOString() });

    const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
    expect(MeSchema.parse(me.json()).onboardingCompleted).toBe(true);
  });

  it("POST /onboarding/complete needs a session", async () => {
    const { app } = await appWith();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/onboarding/complete",
      headers: CSRF,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("auth rate limit", () => {
  it("the 21st auth request in a minute from one IP → 429 rate_limited", async () => {
    const { app } = await appWith();
    for (let i = 0; i < 20; i++) {
      const res = await app.inject({ method: "GET", url: "/api/v1/auth/google/start" });
      expect(res.statusCode).toBe(302);
    }
    const limited = await app.inject({ method: "GET", url: "/api/v1/auth/google/start" });
    expect(limited.statusCode).toBe(429);
    expect(ApiErrorBodySchema.parse(limited.json()).error.code).toBe("rate_limited");
    // The limit is for auth routes only.
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
  });
});

describe("settings service", () => {
  it("returns the defaults when nothing is stored", async () => {
    expect(await getSettings(prisma)).toEqual(DEFAULT_SETTINGS);
  });

  it("saves, reads back and merges stored keys over the defaults", async () => {
    const next = structuredClone(DEFAULT_SETTINGS);
    next.timers = { followUpDays: 5, abandonDays: 10 };
    next.search.enabled = true;
    await saveSettings(prisma, next);
    expect(await getSettings(prisma)).toEqual(next);
    expect(await prisma.setting.count({ where: { key: "onboarding" } })).toBe(0);

    // A section written before a field existed falls back to the default for that field.
    await prisma.setting.update({
      where: { key: "automation" },
      data: { value: { senderIgnoreList: ["noreply@spam.example"] } },
    });
    const merged = await getSettings(prisma);
    expect(merged.automation).toEqual({
      autoApplyMinConfidence: DEFAULT_SETTINGS.automation.autoApplyMinConfidence,
      senderIgnoreList: ["noreply@spam.example"],
    });
  });

  it("keeps the first onboarding completion time", async () => {
    await setOnboardingCompleted(prisma, NOW);
    await setOnboardingCompleted(prisma, new Date(NOW.getTime() + DAY));
    expect(await getOnboardingCompletedAt(prisma)).toEqual(NOW);
  });
});
