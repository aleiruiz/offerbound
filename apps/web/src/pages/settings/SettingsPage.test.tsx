import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";
import {
  DEMO_ME,
  makeAiUsage,
  makeCvProfile,
  makeSettings,
  makeSyncStatus,
} from "../../../test/factories";
import { apiError, mockApi, type MockApi, type MockHandler } from "../../../test/mock-api";
import { renderWithProviders } from "../../../test/render";
import { heavyIt } from "../../../test/speed";
import { ColorModeProvider, THEME_STORAGE_KEY, useColorMode } from "../../ColorModeProvider";
import { SettingsPage } from "./SettingsPage";

vi.setConfig({ testTimeout: 15_000 });

const ME = {
  mode: "private",
  email: "owner@example.test",
  onboardingCompleted: true,
  timezone: "America/Monterrey",
};

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname}</p>;
}

function Mode() {
  return <p data-testid="mode">{useColorMode().mode}</p>;
}

function setup(route = "/settings/gmail", routes: Record<string, MockHandler> = {}) {
  const api: MockApi = mockApi({
    "GET /api/v1/me": () => ME,
    "GET /api/v1/gmail/status": () => makeSyncStatus(),
    "GET /api/v1/settings": () => makeSettings(),
    "GET /api/v1/search/runs": () => [],
    "GET /api/v1/cv": () => makeCvProfile(),
    "GET /api/v1/ai-usage": () => makeAiUsage(),
    ...routes,
  });
  const rendered = renderWithProviders(
    <ColorModeProvider>
      <Where />
      <Mode />
      <Routes>
        <Route path="/settings/:section" element={<SettingsPage />} />
        <Route path="/login" element={<h1>Sign in page</h1>} />
      </Routes>
    </ColorModeProvider>,
    { route },
  );
  return { api, ...rendered, user: userEvent.setup({ delay: null }) };
}

const SECTIONS: [string, string, string][] = [
  ["Gmail", "gmail", "Gmail"],
  ["Job search", "search", "Job search"],
  ["CV", "cv", "CV"],
  ["Daily targets", "targets", "Daily targets"],
  ["Timers", "timers", "Timers"],
  ["Automation", "automation", "Automation"],
  ["Import", "import", "Import"],
  ["AI usage", "ai-usage", "AI usage"],
  ["Data", "data", "Data"],
];

describe("SettingsPage", () => {
  // Visits every section, each with its own requests; see heavyIt.
  heavyIt("the section list drives /settings/:section", async () => {
    const { user } = setup();
    expect(await screen.findByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(SECTIONS.map(([label]) => label));
    for (const [label, path] of SECTIONS) {
      expect(within(nav).getByRole("link", { name: label })).toHaveAttribute(
        "href",
        `/settings/${path}`,
      );
    }
    expect(within(nav).getByRole("link", { name: "Gmail" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    for (const [label, path, heading] of SECTIONS.slice(1)) {
      await user.click(within(nav).getByRole("link", { name: label }));
      expect(screen.getByTestId("where")).toHaveTextContent(`/settings/${path}`);
      expect(await screen.findByRole("heading", { level: 2, name: heading })).toBeInTheDocument();
      expect(within(nav).getByRole("link", { name: label })).toHaveAttribute(
        "aria-current",
        "page",
      );
      expect(
        within(nav)
          .getAllByRole("link")
          .filter((l) => l.hasAttribute("aria-current")),
      ).toHaveLength(1);
    }
  });

  it("an unknown section goes to Gmail", async () => {
    setup("/settings/nope");
    expect(await screen.findByRole("heading", { level: 2, name: "Gmail" })).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/settings/gmail");
  });

  it("the Theme select switches between system, light and dark and remembers the choice per browser", async () => {
    const { user, unmount } = setup();
    const select = await screen.findByRole("combobox", { name: "Theme" });
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["System", "Light", "Dark"]);
    expect(select).toHaveValue("system");
    expect(screen.getByTestId("mode")).toHaveTextContent("light");

    await user.selectOptions(select, "dark");
    expect(screen.getByTestId("mode")).toHaveTextContent("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    // A new visit in the same browser starts from the remembered choice.
    unmount();
    const second = setup();
    const again = await screen.findByRole("combobox", { name: "Theme" });
    expect(again).toHaveValue("dark");
    expect(screen.getByTestId("mode")).toHaveTextContent("dark");

    await second.user.selectOptions(again, "light");
    expect(screen.getByTestId("mode")).toHaveTextContent("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    await second.user.selectOptions(again, "system");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(screen.getByTestId("mode")).toHaveTextContent("light");
  });

  it("the Theme select still works when storage is blocked", async () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    try {
      const { user } = setup();
      const select = await screen.findByRole("combobox", { name: "Theme" });
      await user.selectOptions(select, "dark");
      expect(screen.getByTestId("mode")).toHaveTextContent("dark");
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });

  it("the demo has no Sign out: it has no sign-in", async () => {
    mockApi({
      "GET /api/v1/me": () => DEMO_ME,
      "GET /api/v1/gmail/status": () => makeSyncStatus(),
    });
    renderWithProviders(
      <ColorModeProvider>
        <Routes>
          <Route path="/settings/:section" element={<SettingsPage />} />
        </Routes>
      </ColorModeProvider>,
      { route: "/settings/gmail", me: DEMO_ME },
    );
    await screen.findByRole("heading", { level: 1, name: "Settings" });
    expect(screen.getByRole("combobox", { name: "Theme" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
  });

  it("Sign out posts /auth/logout and goes to /login", async () => {
    const { api, user } = setup("/settings/gmail", {
      "POST /api/v1/auth/logout": () => undefined,
    });
    await user.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Sign in page" })).toBeInTheDocument();
    const logout = api.calls.filter((c) => c.method === "POST");
    expect(logout).toHaveLength(1);
    expect(new URL(logout[0]?.url ?? "").pathname).toBe("/api/v1/auth/logout");
    expect(logout[0]?.headers.get("X-Offerbound-Request")).toBe("1");
  });

  it("stays on the page and says so when signing out fails", async () => {
    const { user } = setup("/settings/gmail", {
      "POST /api/v1/auth/logout": () => apiError(500, "internal_error", "Nope."),
    });
    await user.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't sign out. Try again.");
    await waitFor(() => expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled());
    expect(screen.queryByRole("heading", { name: "Sign in page" })).not.toBeInTheDocument();
  });
});
