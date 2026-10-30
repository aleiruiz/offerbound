import { Writable } from "node:stream";
import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ApiErrorBodySchema, type API_ERROR_STATUS } from "@offerbound/contracts";
import { LOG_REDACT_PATHS } from "./app.js";
import { ApiError } from "./http/errors.js";
import { buildTestApp } from "../test/app.js";

const apps: FastifyInstance[] = [];
async function appWith(...args: Parameters<typeof buildTestApp>) {
  const built = await buildTestApp(...args);
  apps.push(built.app);
  return built;
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const CSRF = { "x-offerbound-request": "1" };

function expectEnvelope(body: string, code: keyof typeof API_ERROR_STATUS) {
  const parsed = ApiErrorBodySchema.parse(JSON.parse(body));
  expect(parsed.error.code).toBe(code);
  return parsed;
}

describe("health", () => {
  it("GET /health → 200", async () => {
    const { app } = await appWith();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("GET /ready → 200 when the database answers", async () => {
    const { app } = await appWith();
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ready" });
  });

  it("GET /ready → 503 not_ready when SELECT 1 fails", async () => {
    const broken = {
      $queryRaw: () => Promise.reject(new Error("connection refused")),
    } as unknown as PrismaClient;
    const { app } = await appWith({ prisma: broken });
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(503);
    expectEnvelope(res.body, "not_ready");
    expect(res.body).not.toContain("connection refused");
  });
});

describe("CSRF header", () => {
  it("POST /api/v1/anything without X-Offerbound-Request → 403 csrf_header_missing", async () => {
    const { app } = await appWith();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const res = await app.inject({ method, url: "/api/v1/anything" });
      expect(res.statusCode).toBe(403);
      expectEnvelope(res.body, "csrf_header_missing");
    }
  });

  it("rejects a header value other than 1", async () => {
    const { app } = await appWith();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/anything",
      headers: { "x-offerbound-request": "yes" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("lets a mutation with the header through to routing", async () => {
    const { app } = await appWith();
    const res = await app.inject({ method: "POST", url: "/api/v1/anything", headers: CSRF });
    expect(res.statusCode).toBe(404);
  });

  it("does not require the header on safe methods", async () => {
    const { app } = await appWith();
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "HEAD", url: "/health" })).statusCode).toBe(200);
  });
});

describe("error envelope", () => {
  it("an unknown route → 404 with the error envelope", async () => {
    const { app } = await appWith();
    const res = await app.inject({ method: "GET", url: "/api/v1/nope" });
    expect(res.statusCode).toBe(404);
    expectEnvelope(res.body, "not_found");
  });

  it("a zod failure → 400 validation_failed with fields", async () => {
    const { app } = await appWith();
    app.post("/api/v1/_test/zod", (request) =>
      z.object({ name: z.string(), nested: z.object({ n: z.number() }) }).parse(request.body),
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/_test/zod",
      headers: CSRF,
      payload: { name: 5, nested: { n: "x" } },
    });
    expect(res.statusCode).toBe(400);
    const { error } = expectEnvelope(res.body, "validation_failed");
    expect(Object.keys(error.fields ?? {}).sort()).toEqual(["name", "nested.n"]);
  });

  it("maps ApiError to its status and envelope", async () => {
    const { app } = await appWith();
    app.get("/api/v1/_test/conflict", () => {
      throw new ApiError(409, "version_conflict", "Stale version", { version: "expected 3" });
    });
    const res = await app.inject({ method: "GET", url: "/api/v1/_test/conflict" });
    expect(res.statusCode).toBe(409);
    expect(expectEnvelope(res.body, "version_conflict").error).toEqual({
      code: "version_conflict",
      message: "Stale version",
      fields: { version: "expected 3" },
    });
  });

  it("a malformed JSON body → 400 validation_failed", async () => {
    const { app } = await appWith();
    app.post("/api/v1/_test/json", (request) => request.body);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/_test/json",
      headers: { ...CSRF, "content-type": "application/json" },
      payload: "{not json",
    });
    expect(res.statusCode).toBe(400);
    expectEnvelope(res.body, "validation_failed");
  });

  it("an unexpected error → 500 without leaking its message", async () => {
    const { app } = await appWith();
    app.get("/api/v1/_test/boom", () => {
      throw new Error("secret detail from an email body");
    });
    const res = await app.inject({ method: "GET", url: "/api/v1/_test/boom" });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("secret detail");
    expectEnvelope(res.body, "internal_error");
  });
});

describe("CORS", () => {
  it("never sends Access-Control-Allow-Origin", async () => {
    const { app } = await appWith();
    const headers = { origin: "https://evil.example" };
    const responses = [
      await app.inject({ method: "GET", url: "/health", headers }),
      await app.inject({ method: "GET", url: "/api/v1/nope", headers }),
      await app.inject({
        method: "OPTIONS",
        url: "/api/v1/anything",
        headers: { ...headers, "access-control-request-method": "POST" },
      }),
    ];
    for (const res of responses) {
      expect(Object.keys(res.headers).filter((h) => h.startsWith("access-control-"))).toEqual([]);
    }
  });
});

describe("rate limit", () => {
  it("the 301st request in a minute from one IP → 429 rate_limited", async () => {
    const { app } = await appWith();
    for (let i = 0; i < 300; i += 1) {
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
    }
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(429);
    expectEnvelope(res.body, "rate_limited");
    expect(res.headers["retry-after"]).toBeDefined();
  });

  it("counts requests to unknown routes", async () => {
    const { app } = await appWith();
    for (let i = 0; i < 300; i += 1) {
      expect((await app.inject({ method: "GET", url: "/api/v1/nope" })).statusCode).toBe(404);
    }
    const res = await app.inject({ method: "GET", url: "/api/v1/nope" });
    expect(res.statusCode).toBe(429);
    expectEnvelope(res.body, "rate_limited");
  });

  it("counts mutations that lack the CSRF header", async () => {
    const { app } = await appWith();
    app.post("/api/v1/_test/mutate", () => ({ ok: true }));
    for (let i = 0; i < 300; i += 1) {
      const res = await app.inject({ method: "POST", url: "/api/v1/_test/mutate" });
      expect(res.statusCode).toBe(403);
    }
    const res = await app.inject({ method: "POST", url: "/api/v1/_test/mutate" });
    expect(res.statusCode).toBe(429);
  });

  it("counts mutations that lack the CSRF header on an unknown route", async () => {
    const { app } = await appWith();
    for (let i = 0; i < 300; i += 1) {
      const res = await app.inject({ method: "POST", url: "/api/v1/nope" });
      expect(res.statusCode).toBe(403);
    }
    const res = await app.inject({ method: "POST", url: "/api/v1/nope" });
    expect(res.statusCode).toBe(429);
    expectEnvelope(res.body, "rate_limited");
  });

  it("counts a request once when an unknown-route mutation carries the header", async () => {
    const { app } = await appWith();
    for (let i = 0; i < 300; i += 1) {
      const res = await app.inject({ method: "POST", url: "/api/v1/nope", headers: CSRF });
      expect(res.statusCode).toBe(404);
    }
    expect(
      (await app.inject({ method: "POST", url: "/api/v1/nope", headers: CSRF })).statusCode,
    ).toBe(429);
  });

  it("keys on the client IP only when the peer is a trusted proxy", async () => {
    const { app } = await appWith();
    const spoof = { "x-forwarded-for": "203.0.113.9" };
    // The test peer is 127.0.0.1, which is not in the default trusted ranges: the header is ignored.
    for (let i = 0; i < 300; i += 1) {
      await app.inject({ method: "GET", url: "/health", headers: spoof });
    }
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-forwarded-for": "203.0.113.10" },
    });
    expect(res.statusCode).toBe(429);
  });

  it("uses X-Forwarded-For when the peer is in TRUSTED_PROXY_IPS", async () => {
    const { testEnv } = await import("../test/app.js");
    const { app } = await appWith({ env: testEnv({ TRUSTED_PROXY_IPS: "127.0.0.1" }) });
    for (let i = 0; i < 300; i += 1) {
      await app.inject({
        method: "GET",
        url: "/health",
        headers: { "x-forwarded-for": "203.0.113.9" },
      });
    }
    const other = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-forwarded-for": "203.0.113.10" },
    });
    expect(other.statusCode).toBe(200);
    const same = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-forwarded-for": "203.0.113.9" },
    });
    expect(same.statusCode).toBe(429);
  });
});

describe("logging", () => {
  function capture() {
    const lines: string[] = [];
    const logStream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    return { lines, logStream };
  }

  it("never logs headers, cookies, query strings, bodies or content fields", async () => {
    const { lines, logStream } = capture();
    const { app } = await appWith(
      { env: (await import("../test/app.js")).testEnv({ LOG_LEVEL: "info" }) },
      { logStream },
    );
    app.post("/api/v1/_test/log", (request) => {
      request.log.info(
        {
          req: {
            headers: { cookie: "ob_session=SESSIONVALUE", authorization: "Bearer BEARERVALUE" },
          },
          res: { headers: { "set-cookie": "ob_session=SETCOOKIEVALUE" } },
          message: { token: "TOKENVALUE", body_text: "BODYTEXTVALUE", subject: "SUBJECTVALUE" },
          item: { snippet: "SNIPPETVALUE" },
        },
        "probe",
      );
      return { ok: true };
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/_test/log?code=OAUTHCODEVALUE",
      headers: { ...CSRF, cookie: "ob_session=SESSIONVALUE", authorization: "Bearer BEARERVALUE" },
      payload: { text: "REQUESTBODYVALUE" },
    });
    const output = lines.join("");
    expect(output).toContain("probe");
    for (const secret of [
      "SESSIONVALUE",
      "BEARERVALUE",
      "SETCOOKIEVALUE",
      "TOKENVALUE",
      "BODYTEXTVALUE",
      "SUBJECTVALUE",
      "SNIPPETVALUE",
      "OAUTHCODEVALUE",
      "REQUESTBODYVALUE",
    ]) {
      expect(output).not.toContain(secret);
    }
  });

  it("the redact paths alone remove header secrets (no serializer in the way)", () => {
    // The app's req/res serializers already drop headers, so the app-level test above cannot tell
    // whether LOG_REDACT_PATHS still works. This logger has the same paths and no serializers.
    const { lines, logStream } = capture();
    const logger = pino({ redact: { paths: LOG_REDACT_PATHS, censor: "[redacted]" } }, logStream);
    logger.info(
      {
        req: { headers: { cookie: "SESSIONVALUE", authorization: "Bearer BEARERVALUE" } },
        res: { headers: { "set-cookie": "SETCOOKIEVALUE" } },
        message: { token: "TOKENVALUE", body_text: "BODYTEXTVALUE", subject: "SUBJECTVALUE" },
        item: { snippet: "SNIPPETVALUE" },
      },
      "probe",
    );
    const output = lines.join("");
    expect(output).toContain("probe");
    expect(output).toContain("[redacted]");
    for (const secret of [
      "SESSIONVALUE",
      "BEARERVALUE",
      "SETCOOKIEVALUE",
      "TOKENVALUE",
      "BODYTEXTVALUE",
      "SUBJECTVALUE",
      "SNIPPETVALUE",
    ]) {
      expect(output).not.toContain(secret);
    }
  });

  it("logs the trust-proxy aware client IP, not the socket address", async () => {
    const { lines, logStream } = capture();
    const { testEnv } = await import("../test/app.js");
    const { app } = await appWith(
      { env: testEnv({ LOG_LEVEL: "info", TRUSTED_PROXY_IPS: "127.0.0.1" }) },
      { logStream },
    );
    await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-forwarded-for": "203.0.113.9" },
    });
    const requestLine = lines
      .map((line) => JSON.parse(line) as { req?: { ip?: string; remoteAddress?: unknown } })
      .find((entry) => entry.req !== undefined);
    expect(requestLine?.req?.ip).toBe("203.0.113.9");
    expect(requestLine?.req).not.toHaveProperty("remoteAddress");
  });
});
