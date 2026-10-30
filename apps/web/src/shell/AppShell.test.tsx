import type { NavCounts, SyncStatus } from "@offerbound/contracts";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../api/hooks";
import { DEMO_ME, OWNER_ME, makeNavCounts, makeSyncStatus } from "../../test/factories";
import { mockApi } from "../../test/mock-api";
import lockupLight from "../assets/brand/lockup.svg";
import markLight from "../assets/brand/mark.svg";
import { renderWithProviders } from "../../test/render";
import { AppShell } from "./AppShell";
import { resetOrigin } from "./origin";

const NO_COUNTS = makeNavCounts({
  openApplications: 0,
  newLeads: 0,
  upcomingInterviews: 0,
  openReview: 0,
});

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

interface ShellApi {
  counts?: () => NavCounts;
  status?: () => SyncStatus;
}

function renderShell(width: number, route = "/today", api: ShellApi = {}) {
  const mocked = mockApi({
    "GET /api/v1/nav-counts": api.counts ?? (() => NO_COUNTS),
    "GET /api/v1/gmail/status": api.status ?? (() => makeSyncStatus({ lastSyncAt: minutesAgo(2) })),
  });
  const rendered = renderShellUi(width, route);
  return Object.assign(rendered, { api: mocked });
}

function renderShellUi(width: number, route: string) {
  return renderWithProviders(
    <Routes>
      <Route element={<AppShell />}>
        <Route path="today" element={<h1>Today</h1>} />
        <Route path="interviews" element={<h1>Interviews</h1>} />
        <Route path="settings/:section" element={<h1>Settings</h1>} />
        <Route path="applications" element={<h1>Applications</h1>} />
        <Route path="applications/:id" element={<h1>Application</h1>} />
        <Route path="leads" element={<h1>Leads</h1>} />
      </Route>
    </Routes>,
    { route, width },
  );
}

describe("AppShell", () => {
  it("at md width the drawer lists Today, Applications, Leads, Interviews, Review, Settings", () => {
    renderShell(1000);
    const nav = screen.getByRole("navigation", { name: "Main" });
    const names = within(nav)
      .getAllByRole("link")
      .map((link) => link.textContent);
    expect(names).toEqual(["Today", "Applications", "Leads", "Interviews", "Review", "Settings"]);
    expect(within(nav).getByRole("link", { name: "Today" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(nav).getByRole("link", { name: "Settings" })).toHaveAttribute(
      "href",
      "/settings",
    );
    expect(within(nav).getByText(window.location.host)).toBeInTheDocument();
    expect(screen.getByRole("main")).toContainElement(
      screen.getByRole("heading", { name: "Today" }),
    );
  });

  it("shows the Offerbound lockup in the drawer header, in the theme's variant", () => {
    renderShell(1000);
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("img", { name: "Offerbound" })).toHaveAttribute(
      "src",
      lockupLight,
    );
  });

  it("shows the mark in the rail and in the phone top bar, both named Offerbound", () => {
    const rail = renderShell(700);
    expect(
      within(screen.getByRole("navigation", { name: "Main" })).getByRole("img", {
        name: "Offerbound",
      }),
    ).toHaveAttribute("src", markLight);
    rail.unmount();
    renderShell(400);
    expect(screen.getByRole("img", { name: "Offerbound" })).toHaveAttribute("src", markLight);
  });

  it("at sm width the rail shows all six destinations as icon links with accessible names", () => {
    renderShell(700);
    const nav = screen.getByRole("navigation", { name: "Main" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("aria-label"))).toEqual([
      "Today",
      "Applications",
      "Leads",
      "Interviews",
      "Review",
      "Settings",
    ]);
    expect(within(nav).queryByText("Applications")).not.toBeInTheDocument();
  });

  it("below sm the bottom navigation shows Today, Applications, Leads, Review, More", async () => {
    renderShell(400);
    const nav = screen.getByRole("navigation", { name: "Main" });
    for (const label of ["Today", "Applications", "Leads", "Review", "More"]) {
      expect(within(nav).getByText(label)).toBeInTheDocument();
    }
    expect(within(nav).queryByText("Interviews")).not.toBeInTheDocument();
    expect(within(nav).queryByText("Settings")).not.toBeInTheDocument();

    await userEvent.click(within(nav).getByRole("button", { name: "More" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Interviews" })).toHaveAttribute(
      "href",
      "/interviews",
    );
    expect(within(menu).getByRole("menuitem", { name: "Settings" })).toHaveAttribute(
      "href",
      "/settings",
    );
  });

  it("below sm a top app bar shows the page title", () => {
    renderShell(400, "/interviews");
    const banner = screen.getByRole("banner");
    expect(within(banner).getByText("Interviews")).toBeInTheDocument();
  });

  describe("below sm the top bar leads back from a sub-page", () => {
    afterEach(() => resetOrigin());

    it("has no back button on a destination", () => {
      renderShell(400, "/interviews");
      expect(
        within(screen.getByRole("banner")).queryByRole("link", { name: /^Back to/ }),
      ).toBeNull();
    });

    it("leads from a settings section to the section list", () => {
      renderShell(400, "/settings/gmail");
      expect(
        within(screen.getByRole("banner")).getByRole("link", { name: "Back to Settings" }),
      ).toHaveAttribute("href", "/settings");
    });

    it("leads from an application opened by link to the Applications list", () => {
      renderShell(400, "/applications/app-1");
      expect(
        within(screen.getByRole("banner")).getByRole("link", { name: "Back to Applications" }),
      ).toHaveAttribute("href", "/applications");
    });

    it("has no back button at md width", () => {
      renderShell(1000, "/settings/gmail");
      expect(screen.queryByRole("link", { name: /^Back to/ })).toBeNull();
    });
  });

  it("marks More as current on Interviews and Settings", () => {
    renderShell(400, "/settings/gmail");
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("button", { name: "More" })).toHaveClass("Mui-selected");
  });

  it("g then i goes to Interviews and ? lists the shortcuts", async () => {
    const user = userEvent.setup({ delay: null });
    renderShell(1000);
    await user.keyboard("?");
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.keyboard("gi");
    expect(await screen.findByRole("heading", { name: "Interviews" })).toBeInTheDocument();
  });

  // One test per layout: each renders its own shell and opens a dialog, so together they were the
  // slowest test in the file and sat close to vitest's 5 s default under load.
  describe("Keyboard shortcuts control", () => {
    it("is visible in the drawer", async () => {
      const user = userEvent.setup({ delay: null });
      renderShell(1000);
      await user.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
      expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
    });

    it("is visible in the rail", async () => {
      const user = userEvent.setup({ delay: null });
      renderShell(700);
      await user.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
      expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
    });

    it("is in the More menu on phones", async () => {
      const user = userEvent.setup({ delay: null });
      renderShell(400);
      await user.click(screen.getByRole("button", { name: "More" }));
      await user.click(await screen.findByRole("menuitem", { name: "Keyboard shortcuts" }));
      expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
    });
  });

  it("at md width the drawer footer holds the sync status above Keyboard shortcuts", async () => {
    renderShell(1000);
    const nav = screen.getByRole("navigation", { name: "Main" });
    const status = await within(nav).findByText("Gmail synced 2 min ago");
    const shortcuts = within(nav).getByRole("button", { name: "Keyboard shortcuts" });
    expect(
      status.compareDocumentPosition(shortcuts) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(nav).getByRole("button", { name: "Sync now" })).toBeInTheDocument();
  });

  it("at sm width the rail has Sync now, and below sm the top bar has it", async () => {
    const rail = renderShell(700);
    expect(await screen.findByRole("button", { name: "Sync now" })).toBeInTheDocument();
    rail.unmount();

    renderShell(400);
    const banner = screen.getByRole("banner");
    expect(await within(banner).findByText("Gmail synced 2 min ago")).toBeInTheDocument();
    expect(within(banner).getByRole("button", { name: "Sync now" })).toBeInTheDocument();
  });
});

describe("AppShell reconnect banner", () => {
  const needsReauth = () => makeSyncStatus({ connection: "needs_reauth" });

  it("needs_reauth or missing_scope shows the Reconnect banner on every page; Reconnect Gmail links to /api/v1/auth/google/start", async () => {
    for (const [route, width] of [
      ["/today", 1000],
      ["/interviews", 700],
      ["/settings/gmail", 400],
    ] as const) {
      const { unmount } = renderShell(width, route, { status: needsReauth });
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Gmail needs reconnecting.");
      expect(within(alert).getByRole("link", { name: "Reconnect Gmail" })).toHaveAttribute(
        "href",
        "/api/v1/auth/google/start",
      );
      expect(screen.getByRole("main")).toContainElement(alert);
      unmount();
    }

    renderShell(1000, "/today", { status: () => makeSyncStatus({ connection: "missing_scope" }) });
    expect(await screen.findByRole("alert")).toHaveTextContent("Gmail needs reconnecting.");
  });

  it("shows no banner while Gmail is connected", async () => {
    renderShell(1000);
    await screen.findByText("Gmail synced 2 min ago");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("AppShell nav badges", () => {
  afterEach(() => vi.useRealTimers());

  it("drawer badges come from /nav-counts and Review uses the amber badge", async () => {
    renderShell(1000, "/today", { counts: () => makeNavCounts() });
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(await within(nav).findByRole("link", { name: "Applications 20" })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "Leads 24 new" })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "Interviews 3" })).toBeInTheDocument();
    const review = within(nav).getByRole("link", { name: "Review 4" });
    expect(within(review).getByText("4")).toHaveStyle({
      backgroundColor: "#8f5400",
    });
    expect(within(nav).getByRole("link", { name: "Settings" })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "Today" })).toBeInTheDocument();
  });

  it("shows no badge for a count of zero", async () => {
    const { queryClient } = renderShell(1000);
    await waitFor(() =>
      expect(queryClient.getQueryState(queryKeys.navCounts)?.status).toBe("success"),
    );
    // Let React render the loaded counts before asserting that nothing was drawn for them.
    await act(async () => {
      await Promise.resolve();
    });
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).queryByText("0")).not.toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "Review" })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "Leads" })).toBeInTheDocument();
  });

  it("the rail and the bottom navigation show the Review badge", async () => {
    const rail = renderShell(700, "/today", { counts: () => makeNavCounts() });
    expect(await screen.findByRole("link", { name: "Review, 4 open" })).toBeInTheDocument();
    rail.unmount();

    renderShell(400, "/today", { counts: () => makeNavCounts() });
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(await within(nav).findByText("4")).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "Review, 4 open" })).toBeInTheDocument();
  });

  it("nav badges come from /nav-counts every 60 s", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-30T12:00:00Z"));
    let counts = makeNavCounts();
    const { api } = renderShell(1000, "/today", { counts: () => counts });
    const flush = async (ms: number) => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    };
    const fetches = () => api.calls.filter((c) => c.url.endsWith("/nav-counts")).length;
    await flush(0);
    expect(fetches()).toBe(1);
    expect(screen.getByRole("link", { name: "Review 4" })).toBeInTheDocument();

    counts = makeNavCounts({ openReview: 5 });
    await flush(59_000);
    expect(fetches()).toBe(1);
    await flush(1_000);
    expect(fetches()).toBe(2);
    await flush(10);
    expect(screen.getByRole("link", { name: "Review 5" })).toBeInTheDocument();
  });
});

describe("AppShell in the public demo", () => {
  function renderDemoShell(width: number, me = DEMO_ME) {
    mockApi({
      "GET /api/v1/nav-counts": () => NO_COUNTS,
      "GET /api/v1/gmail/status": () => makeSyncStatus(),
    });
    return renderWithProviders(
      <Routes>
        <Route element={<AppShell />}>
          <Route path="today" element={<h1>Today</h1>} />
        </Route>
      </Routes>,
      { route: "/today", width, me },
    );
  }

  it.each([1000, 700, 390])("shows the demo banner above the page at %ipx", (width) => {
    renderDemoShell(width);
    const banner = screen.getByRole("region", { name: "Demo" });
    expect(banner).toHaveTextContent("Demo with made-up data. Everything resets every hour.");
    const main = screen.getByRole("main");
    expect(banner.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows no banner to the owner", () => {
    renderDemoShell(1000, OWNER_ME);
    expect(screen.queryByRole("region", { name: "Demo" })).not.toBeInTheDocument();
  });
});
