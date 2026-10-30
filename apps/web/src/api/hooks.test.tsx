import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeApplicationDetail, makeEvent } from "../../test/factories";
import { apiError, mockApi } from "../../test/mock-api";
import { setUnauthorizedHandler } from "./client";
import { createQueryClient } from "./query-client";
import { queryKeys, useMe, useMergeApplication, useNavCounts, useSyncStatus } from "./hooks";

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

describe("useSyncStatus and useNavCounts", () => {
  it("fail on a response that does not match the schema", async () => {
    mockApi({
      "GET /api/v1/gmail/status": () => ({ connection: "unknown" }),
      "GET /api/v1/nav-counts": () => ({ openReview: -1 }),
    });
    const client = createQueryClient();
    const status = renderHook(() => useSyncStatus(), { wrapper: wrapper(client) });
    const counts = renderHook(() => useNavCounts(), { wrapper: wrapper(client) });
    await waitFor(() => expect(status.result.current.isError).toBe(true));
    await waitFor(() => expect(counts.result.current.isError).toBe(true));
  });
});

describe("useMergeApplication", () => {
  it("answers with the target, keeps it in the cache and refreshes everything the merge touched", async () => {
    const target = makeApplicationDetail({ id: "a2", timeline: [makeEvent({ type: "merged" })] });
    mockApi({ "POST /api/v1/applications/a1/merge": () => target });
    const client = createQueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useMergeApplication(), { wrapper: wrapper(client) });
    result.current.mutate({ id: "a1", intoId: "a2" });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.getQueryData(queryKeys.application("a2"))).toEqual(target);
    for (const key of [
      queryKeys.applicationLists,
      queryKeys.today,
      queryKeys.navCounts,
      queryKeys.interviews,
      // a lead linked to the source goes back to shortlisted (TECHNICAL_SPEC §6.6)
      queryKeys.leadLists,
      queryKeys.leadCounts,
    ]) {
      expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: key }));
    }
  });
});
