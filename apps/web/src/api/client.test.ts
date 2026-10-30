import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { apiError, mockApi } from "../../test/mock-api";
import { ApiClientError, apiFetch, setUnauthorizedHandler } from "./client";

afterEach(() => setUnauthorizedHandler(null));

describe("apiFetch", () => {
  it("apiFetch adds X-Offerbound-Request: 1 to POST but not to GET", async () => {
    const api = mockApi({
      "GET /api/v1/things": () => ({ ok: true }),
      "POST /api/v1/things": () => ({ ok: true }),
    });
    await apiFetch("/things");
    await apiFetch("/things", { method: "POST", body: { name: "x" } });
    const [get, post] = api.calls;
    expect(get?.headers.get("X-Offerbound-Request")).toBeNull();
    expect(post?.headers.get("X-Offerbound-Request")).toBe("1");
    expect(post?.headers.get("Content-Type")).toBe("application/json");
    expect(await post?.json()).toEqual({ name: "x" });
  });

  it("sends a multipart body with the CSRF header and leaves the content type to the browser", async () => {
    const api = mockApi({ "POST /api/v1/cv": () => ({ ok: true }) });
    const formData = new FormData();
    formData.append("file", new File(["hello"], "cv.pdf", { type: "application/pdf" }));
    await apiFetch("/cv", { method: "POST", formData });
    const post = api.calls[0];
    expect(post?.headers.get("X-Offerbound-Request")).toBe("1");
    // No JSON content type: the browser adds the multipart one, with its boundary.
    expect(post?.headers.get("Content-Type")).toBeNull();
    expect((api.upload(post as Request)?.get("file") as File).name).toBe("cv.pdf");
  });

  it("prefixes /api/v1 and sends credentials same-origin", async () => {
    const api = mockApi({ "GET /api/v1/me": () => ({ ok: true }) });
    await apiFetch("/me");
    expect(api.calls[0]?.url).toMatch(/\/api\/v1\/me$/);
    expect(api.fetch.mock.calls[0]?.[1]).toMatchObject({ credentials: "same-origin" });
  });

  it("apiFetch maps the error envelope to ApiClientError with code and fields", async () => {
    mockApi({
      "POST /api/v1/applications": () =>
        apiError(400, "validation_failed", "Check the highlighted fields.", {
          title: "Required",
        }),
    });
    const error = await apiFetch("/applications", { method: "POST", body: {} }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({
      status: 400,
      code: "validation_failed",
      message: "Check the highlighted fields.",
      fields: { title: "Required" },
    });
    expect((error as ApiClientError).body).toEqual({
      error: {
        code: "validation_failed",
        message: "Check the highlighted fields.",
        fields: { title: "Required" },
      },
    });
  });

  it("keeps extra keys of the error body, such as the current record of a version conflict", async () => {
    mockApi({
      "PATCH /api/v1/applications/a1": () =>
        new Response(
          JSON.stringify({
            error: { code: "version_conflict", message: "Changed elsewhere." },
            current: { id: "a1", version: 4 },
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        ),
    });
    const error = (await apiFetch("/applications/a1", {
      method: "PATCH",
      body: { version: 3 },
    }).catch((e: unknown) => e)) as ApiClientError;
    expect(error.code).toBe("version_conflict");
    expect(error.fields).toEqual({});
    expect(error.body).toMatchObject({ current: { id: "a1", version: 4 } });
  });

  it("maps a non-envelope failure to a generic ApiClientError", async () => {
    mockApi({ "GET /api/v1/x": () => new Response("<html>Bad gateway</html>", { status: 502 }) });
    const error = (await apiFetch("/x").catch((e: unknown) => e)) as ApiClientError;
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({ status: 502, code: "unexpected_response" });
  });

  it("maps an unknown error code to unexpected_response", async () => {
    mockApi({ "GET /api/v1/x": () => apiError(500, "brand_new_code", "Something odd.") });
    const error = (await apiFetch("/x").catch((e: unknown) => e)) as ApiClientError;
    expect(error).toMatchObject({ status: 500, code: "unexpected_response" });
  });

  it("on a 401 it calls the unauthorized handler and still throws", async () => {
    mockApi({ "GET /api/v1/me": () => apiError(401, "unauthenticated", "Sign in first.") });
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    await expect(apiFetch("/me")).rejects.toMatchObject({ status: 401, code: "unauthenticated" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("validates a successful body with the schema", async () => {
    mockApi({ "GET /api/v1/n": () => ({ n: 3 }), "GET /api/v1/bad": () => ({ n: "three" }) });
    const schema = z.object({ n: z.number() });
    await expect(apiFetch("/n", { schema })).resolves.toEqual({ n: 3 });
    await expect(apiFetch("/bad", { schema })).rejects.toMatchObject({
      code: "unexpected_response",
    });
  });

  it("returns undefined for 204", async () => {
    mockApi({ "POST /api/v1/auth/logout": () => undefined });
    await expect(apiFetch("/auth/logout", { method: "POST" })).resolves.toBeUndefined();
  });
});
