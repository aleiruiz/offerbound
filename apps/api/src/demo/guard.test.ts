import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { ApiError } from "../http/errors.js";
import { DEMO_RULES, demoReadOnlyGuard, demoRuleKey } from "./guard.js";

const guard = demoReadOnlyGuard();

async function run(method: string, url: string, body?: unknown): Promise<unknown> {
  const request = { method, routeOptions: { url }, body } as unknown as FastifyRequest;
  try {
    await guard.call({} as never, request, {} as FastifyReply);
    return "passed";
  } catch (error) {
    if (error instanceof ApiError) return `${error.status} ${error.code}`;
    throw error;
  }
}

describe("demoRuleKey", () => {
  it("drops the API prefix and keeps the route pattern", () => {
    expect(demoRuleKey("post", "/api/v1/leads/:id/reconsider")).toBe("POST /leads/:id/reconsider");
  });
});

describe("demoReadOnlyGuard", () => {
  it("lets every read through", async () => {
    expect(await run("GET", "/api/v1/applications/:id")).toBe("passed");
    expect(await run("GET", "/api/v1/cv")).toBe("passed");
  });

  it("blocks a mutating route that has no rule", async () => {
    expect(await run("POST", "/api/v1/something-new", {})).toBe("403 demo_read_only");
    expect(await run("DELETE", "/api/v1/applications/:id")).toBe("403 demo_read_only");
    expect(Object.keys(DEMO_RULES)).not.toContain("POST /something-new");
  });

  it("lets a PATCH through only while every key is one that carries no text", async () => {
    const url = "/api/v1/applications/:id";
    expect(await run("PATCH", url, { version: 2, status: "offer" })).toBe("passed");
    expect(await run("PATCH", url, { version: 2, status: "offer", notes: "hi" })).toBe(
      "403 demo_read_only",
    );
    expect(await run("PATCH", url, { version: 2, notes: null })).toBe("403 demo_read_only");
    expect(await run("PATCH", url, "not an object")).toBe("403 demo_read_only");
    expect(await run("PATCH", url, undefined)).toBe("403 demo_read_only");
  });

  it("allows a lead to be dismissed without a reason, not with one", async () => {
    const url = "/api/v1/leads/:id";
    expect(await run("PATCH", url, { version: 1, status: "dismissed" })).toBe("passed");
    expect(await run("PATCH", url, { version: 1, status: "dismissed", dismissedReason: "" })).toBe(
      "passed",
    );
    expect(await run("PATCH", url, { version: 1, status: "dismissed", dismissedReason: "x" })).toBe(
      "403 demo_read_only",
    );
    expect(await run("PATCH", url, { version: 1, notes: "x" })).toBe("403 demo_read_only");
  });

  it("lets review decisions through except the ones with text", async () => {
    const url = "/api/v1/review-items/:id/resolve";
    expect(await run("POST", url, { action: "attach", applicationId: "x" })).toBe("passed");
    expect(await run("POST", url, { action: "dismiss" })).toBe("passed");
    // Re-reading the mailbox is a review action like any other (the mailbox is the fake one).
    expect(await run("POST", url, { action: "retry" })).toBe("passed");
    expect(await run("POST", url, { action: "reprocess" })).toBe("passed");
    for (const body of [{ action: "edit_apply" }, { action: "apply", edits: {} }]) {
      expect(await run("POST", url, body)).toBe("403 demo_read_only");
    }
  });

  it("lets merges and reprocessing through: they carry no text", async () => {
    expect(await run("POST", "/api/v1/companies/:id/merge", { intoId: "x" })).toBe("passed");
    expect(await run("POST", "/api/v1/applications/:id/merge", { intoId: "x" })).toBe("passed");
    expect(await run("POST", "/api/v1/messages/:id/reprocess", {})).toBe("passed");
  });
});
