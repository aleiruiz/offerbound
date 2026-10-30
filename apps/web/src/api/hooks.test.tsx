import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiError, mockApi } from "../../test/mock-api";
import { setUnauthorizedHandler } from "./client";
import { createQueryClient } from "./query-client";
import { useMe } from "./hooks";

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

afterEach(() => setUnauthorizedHandler(null));

describe("query client", () => {
  it("retries once and refetches on window focus", () => {
    const options = createQueryClient().getDefaultOptions().queries;
    expect(options?.refetchOnWindowFocus).toBe(true);
    const retry = options?.retry;
    expect(typeof retry === "function" ? retry(0, new Error("network")) : retry).toBe(true);
    expect(typeof retry === "function" ? retry(1, new Error("network")) : retry).toBe(false);
  });
});

describe("useMe", () => {
  it("returns the validated /me response", async () => {
    mockApi({
      "GET /api/v1/me": () => ({
        mode: "demo",
        email: null,
        onboardingCompleted: true,
        timezone: "America/Monterrey",
      }),
    });
    const { result } = renderHook(() => useMe(), { wrapper: wrapper(createQueryClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.mode).toBe("demo");
  });

  it("fails on a response that does not match the schema", async () => {
    mockApi({ "GET /api/v1/me": () => ({ mode: "other" }) });
    const { result } = renderHook(() => useMe(), { wrapper: wrapper(createQueryClient()) });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it("does not retry a 401", async () => {
    const api = mockApi({ "GET /api/v1/me": () => apiError(401, "unauthenticated", "Sign in.") });
    setUnauthorizedHandler(vi.fn());
    const { result } = renderHook(() => useMe(), { wrapper: wrapper(createQueryClient()) });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(api.calls).toHaveLength(1);
  });
});
