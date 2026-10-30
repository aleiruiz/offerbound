import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../api/hooks";
import { makeSyncStatus } from "../../test/factories";
import { apiError, mockApi } from "../../test/mock-api";
import { renderWithProviders } from "../../test/render";
import { SyncStatus } from "./SyncStatus";

const NOW = new Date("2026-10-30T12:00:00Z");

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

// Testing Library's userEvent waits on real timers, so clicks use fireEvent under fake timers.
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SyncStatus", () => {
  it("the nav footer shows 'Gmail synced 2 min ago' and Sync now posts /gmail/sync", async () => {
    let status = makeSyncStatus();
    const api = mockApi({
      "GET /api/v1/gmail/status": () => status,
      "POST /api/v1/gmail/sync": () => {
        status = makeSyncStatus({ lastSyncAt: "2026-10-30T12:00:00Z" });
        return new Response(null, { status: 202 });
      },
    });
    renderWithProviders(<SyncStatus layout="footer" />);
    await flush();

    const live = screen.getByRole("status");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveTextContent("Gmail synced 2 min ago");

    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await flush();

    const post = api.calls.find((c) => c.method === "POST");
    expect(post?.url).toContain("/api/v1/gmail/sync");
    expect(post?.headers.get("X-Offerbound-Request")).toBe("1");
    // The status is fetched again after the request.
    expect(screen.getByRole("status")).toHaveTextContent("Gmail synced just now");
  });

  it("sync status polls every 30 s", async () => {
    const api = mockApi({ "GET /api/v1/gmail/status": () => makeSyncStatus() });
    renderWithProviders(<SyncStatus layout="footer" />);
    await flush();
    const count = () => api.calls.filter((c) => c.url.endsWith("/gmail/status")).length;
    expect(count()).toBe(1);
    await advance(29_000);
    expect(count()).toBe(1);
    await advance(1_000);
    expect(count()).toBe(2);
    await advance(30_000);
    expect(count()).toBe(3);
  });

  it("says when the first sync is running, when Gmail is not connected and when it needs reconnecting", async () => {
    let status = makeSyncStatus({ backfill: { state: "running", listed: 400, processed: 120 } });
    mockApi({ "GET /api/v1/gmail/status": () => status });
    const { unmount } = renderWithProviders(<SyncStatus layout="footer" />);
    await flush();
    expect(screen.getByRole("status")).toHaveTextContent("Gmail first sync: 120 of 400");
    unmount();

    status = makeSyncStatus({ connection: "not_connected", started: false, lastSyncAt: null });
    const second = renderWithProviders(<SyncStatus layout="footer" />);
    await flush();
    expect(screen.getByRole("status")).toHaveTextContent("Gmail not connected");
    expect(screen.queryByRole("button", { name: "Sync now" })).not.toBeInTheDocument();
    second.unmount();

    status = makeSyncStatus({ connection: "needs_reauth" });
    renderWithProviders(<SyncStatus layout="footer" />);
    await flush();
    expect(screen.getByRole("status")).toHaveTextContent("Gmail needs reconnecting");
    expect(screen.getByRole("button", { name: "Sync now" })).toBeDisabled();
  });

  it("tells the owner when Sync now fails", async () => {
    mockApi({
      "GET /api/v1/gmail/status": () => makeSyncStatus(),
      "POST /api/v1/gmail/sync": () => apiError(502, "upstream_error", "Gmail did not answer."),
    });
    renderWithProviders(<SyncStatus layout="footer" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await flush();
    expect(screen.getByRole("status")).toHaveTextContent("Couldn't start a sync. Try again.");
  });

  it("a 409 because a sync is already running shows the running state, not a failure", async () => {
    mockApi({
      "GET /api/v1/gmail/status": () => makeSyncStatus(),
      "POST /api/v1/gmail/sync": () =>
        apiError(409, "already_running", "A sync is already running."),
    });
    renderWithProviders(<SyncStatus layout="footer" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await flush();
    expect(screen.getByRole("status")).toHaveTextContent("Gmail is syncing now");
    expect(screen.getByRole("status")).not.toHaveTextContent("Couldn't start");
  });

  it("a failed Sync now does not hide that the first sync is running", async () => {
    mockApi({
      "GET /api/v1/gmail/status": () =>
        makeSyncStatus({ backfill: { state: "running", listed: 400, processed: 120 } }),
      "POST /api/v1/gmail/sync": () => apiError(502, "upstream_error", "Gmail did not answer."),
    });
    renderWithProviders(<SyncStatus layout="footer" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await flush();
    expect(screen.getByRole("status")).toHaveTextContent("Gmail first sync: 120 of 400");
  });

  it("a failed Sync now message goes away when the status changes, and loses to needs reconnecting", async () => {
    mockApi({
      "GET /api/v1/gmail/status": () => makeSyncStatus(),
      "POST /api/v1/gmail/sync": () => apiError(502, "upstream_error", "Gmail did not answer."),
    });
    const { queryClient } = renderWithProviders(<SyncStatus layout="footer" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await flush();
    expect(screen.getByRole("status")).toHaveTextContent("Couldn't start a sync. Try again.");

    queryClient.setQueryData(queryKeys.syncStatus, makeSyncStatus({ connection: "needs_reauth" }));
    await flush();
    expect(screen.getByRole("status")).toHaveTextContent("Gmail needs reconnecting");

    queryClient.setQueryData(queryKeys.syncStatus, makeSyncStatus());
    await flush();
    expect(screen.getByRole("status")).not.toHaveTextContent("Couldn't start");
  });

  it("the rail and top bar layouts keep an accessible Sync now control and the same status text", async () => {
    mockApi({ "GET /api/v1/gmail/status": () => makeSyncStatus() });
    const rail = renderWithProviders(<SyncStatus layout="rail" />);
    await flush();
    expect(screen.getByRole("status")).toHaveTextContent("Gmail synced 2 min ago");
    expect(screen.getByRole("button", { name: "Sync now" })).toBeInTheDocument();
    rail.unmount();

    renderWithProviders(<SyncStatus layout="bar" />);
    await flush();
    expect(screen.getByRole("status")).toHaveTextContent("Gmail synced 2 min ago");
    expect(screen.getByRole("button", { name: "Sync now" })).toBeInTheDocument();
  });
});
