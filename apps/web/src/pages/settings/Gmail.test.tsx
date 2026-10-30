import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { makeSyncStatus } from "../../../test/factories";
import { apiError, mockApi, type MockApi, type MockHandler } from "../../../test/mock-api";
import { renderWithProviders } from "../../../test/render";
import { GOOGLE_START_PATH } from "../../api/paths";
import { Gmail } from "./Gmail";

vi.setConfig({ testTimeout: 15_000 });

const ME = {
  mode: "private",
  email: "owner@example.test",
  onboardingCompleted: true,
  timezone: "America/Monterrey",
};

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

function setup(routes: Record<string, MockHandler> = {}) {
  const api: MockApi = mockApi({
    "GET /api/v1/me": () => ME,
    "GET /api/v1/gmail/status": () => makeSyncStatus({ lastSyncAt: minutesAgo(2) }),
    ...routes,
  });
  const rendered = renderWithProviders(
    <Routes>
      <Route path="/settings/gmail" element={<Gmail />} />
      <Route path="/review" element={<h1>Review page</h1>} />
    </Routes>,
    { route: "/settings/gmail" },
  );
  return { api, ...rendered, user: userEvent.setup({ delay: null }) };
}

const callsTo = (api: MockApi, method: string, path: string) =>
  api.calls.filter((c) => c.method === method && new URL(c.url).pathname === path);

describe("Settings, Gmail", () => {
  it("shows the connection, the account, the last check and the five counts", async () => {
    setup({
      "GET /api/v1/gmail/status": () =>
        makeSyncStatus({
          lastSyncAt: minutesAgo(2),
          queue: { discovered: 3, jobRelated: 2, extracted: 1, needsReview: 4, failed: 5 },
        }),
    });
    const section = await screen.findByRole("region", { name: "Gmail" });
    expect(within(section).getByText("Connected")).toBeInTheDocument();
    expect(
      await within(section).findByText("owner@example.test, read-only access"),
    ).toBeInTheDocument();
    expect(
      within(section).getByText(
        "Last checked 2 minutes ago. New email is checked every 5 minutes.",
      ),
    ).toBeInTheDocument();

    const counts = within(section).getByRole("list", { name: "Email waiting at each stage" });
    const items = within(counts).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "3New, not checked yet",
      "2Job emails being read",
      "1Ready to update records",
      "4Waiting for your review",
      "5Couldn't be read",
    ]);
    const review = within(counts).getByRole("link", { name: /Waiting for your review/ });
    expect(review).toHaveAttribute("href", "/review");
  });

  it("shows first-sync progress while the first read of the mailbox runs", async () => {
    setup({
      "GET /api/v1/gmail/status": () =>
        makeSyncStatus({
          lastSyncAt: null,
          backfill: { state: "running", listed: 2148, processed: 1074 },
        }),
    });
    const bar = await screen.findByRole("progressbar", { name: "First sync progress" });
    expect(bar).toHaveAttribute("aria-valuenow", "50");
    expect(screen.getByText("1,074 of 2,148 checked")).toBeInTheDocument();
    expect(
      screen.getByText("Not checked yet. New email is checked every 5 minutes."),
    ).toBeVisible();
  });

  it("says a stopped first sync stopped", async () => {
    setup({
      "GET /api/v1/gmail/status": () =>
        makeSyncStatus({ backfill: { state: "failed", listed: 100, processed: 40 } }),
    });
    expect(
      await screen.findByText(/The first sync stopped before it finished/),
    ).toBeInTheDocument();
  });

  it("Sync now posts /gmail/sync", async () => {
    const { api, user } = setup({
      "POST /api/v1/gmail/sync": () => new Response(null, { status: 202 }),
    });
    await user.click(await screen.findByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(callsTo(api, "POST", "/api/v1/gmail/sync")).toHaveLength(1));
    expect(callsTo(api, "POST", "/api/v1/gmail/sync")[0]?.headers.get("X-Offerbound-Request")).toBe(
      "1",
    );
  });

  it("Disconnect Gmail asks for confirmation, then posts /gmail/disconnect", async () => {
    let connected = true;
    const { api, user } = setup({
      "GET /api/v1/gmail/status": () =>
        connected
          ? makeSyncStatus({ lastSyncAt: minutesAgo(2) })
          : makeSyncStatus({ connection: "disconnected", started: false, lastSyncAt: null }),
      "POST /api/v1/gmail/disconnect": () => {
        connected = false;
        return undefined;
      },
    });
    await user.click(await screen.findByRole("button", { name: "Disconnect Gmail" }));

    const dialog = await screen.findByRole("dialog", { name: "Disconnect Gmail?" });
    expect(within(dialog).getByText(/revokes Offerbound's access at Google/)).toBeInTheDocument();
    expect(callsTo(api, "POST", "/api/v1/gmail/disconnect")).toHaveLength(0);

    // Cancel changes nothing.
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(callsTo(api, "POST", "/api/v1/gmail/disconnect")).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Disconnect Gmail" }));
    const again = await screen.findByRole("dialog", { name: "Disconnect Gmail?" });
    await user.click(within(again).getByRole("button", { name: "Disconnect Gmail" }));
    await waitFor(() => expect(callsTo(api, "POST", "/api/v1/gmail/disconnect")).toHaveLength(1));
    expect(
      callsTo(api, "POST", "/api/v1/gmail/disconnect")[0]?.headers.get("X-Offerbound-Request"),
    ).toBe("1");

    // The status is read again: Gmail is disconnected and can be connected anew.
    expect(await screen.findByText("Disconnected")).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "Connect Gmail" })).toHaveAttribute(
      "href",
      GOOGLE_START_PATH,
    );
    expect(screen.queryByRole("button", { name: "Disconnect Gmail" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sync now" })).not.toBeInTheDocument();
  });

  it("keeps the dialog open and says so when disconnecting fails", async () => {
    const { user } = setup({
      "POST /api/v1/gmail/disconnect": () =>
        apiError(502, "upstream_error", "Google didn't answer."),
    });
    await user.click(await screen.findByRole("button", { name: "Disconnect Gmail" }));
    const dialog = await screen.findByRole("dialog", { name: "Disconnect Gmail?" });
    await user.click(within(dialog).getByRole("button", { name: "Disconnect Gmail" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Couldn't disconnect Gmail. Google didn't answer.",
    );
  });

  it("offers Reconnect Gmail when Google stopped the access", async () => {
    setup({
      "GET /api/v1/gmail/status": () => makeSyncStatus({ connection: "needs_reauth" }),
    });
    expect(await screen.findByText("Needs reconnecting")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Reconnect Gmail" })).toHaveAttribute(
      "href",
      GOOGLE_START_PATH,
    );
    expect(screen.queryByRole("button", { name: "Sync now" })).not.toBeInTheDocument();
  });

  it("explains in plain words what Offerbound reads, with a link to Automation", async () => {
    setup();
    const reads = await screen.findByRole("region", { name: "What Offerbound reads" });
    expect(within(reads).getAllByRole("listitem")).toHaveLength(5);
    expect(
      within(reads).getByText(/are read in full and sent to OpenAI to update your records/),
    ).toBeInTheDocument();
    expect(within(reads).getByRole("link", { name: "Automation" })).toHaveAttribute(
      "href",
      "/settings/automation",
    );
  });

  it("says when the status cannot be read, and tries again", async () => {
    let fail = true;
    const { user } = setup({
      "GET /api/v1/gmail/status": () =>
        fail ? apiError(500, "internal_error", "Something went wrong.") : makeSyncStatus(),
    });
    expect(await screen.findByText(/Couldn't load the Gmail status/)).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Connected")).toBeInTheDocument();
  });
});
