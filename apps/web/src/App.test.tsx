import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeNavCounts, makeSyncStatus } from "../test/factories";
import { apiError, mockApi } from "../test/mock-api";
import { renderWithProviders } from "../test/render";
import { App } from "./App";

const me = {
  mode: "private",
  email: "owner@example.test",
  onboardingCompleted: true,
  timezone: "America/Monterrey",
};

function mockSignedIn() {
  return mockApi({
    "GET /api/v1/me": () => me,
    "GET /api/v1/gmail/status": () => makeSyncStatus(),
    "GET /api/v1/nav-counts": () => makeNavCounts(),
  });
}

describe("routing and session", () => {
  it("an unauthenticated visit to /today goes to /login", async () => {
    mockApi({ "GET /api/v1/me": () => apiError(401, "unauthenticated", "Sign in first.") });
    renderWithProviders(<App />, { route: "/today" });
    expect(
      await screen.findByRole("heading", { level: 1, name: "Welcome back" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Main" })).not.toBeInTheDocument();
  });

  it("a signed-in visit to / shows Today inside the shell", async () => {
    mockSignedIn();
    renderWithProviders(<App />, { route: "/" });
    expect(await screen.findByRole("heading", { level: 1, name: "Today" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument();
  });

  it.each([
    ["/applications", "Applications"],
    ["/applications/a1", "Application"],
    ["/leads", "Leads"],
    ["/interviews", "Interviews"],
    ["/review", "Review"],
    ["/settings/gmail", "Settings"],
    ["/onboarding", "Set up Offerbound"],
  ])("%s renders its page title as the h1", async (route, title) => {
    mockSignedIn();
    renderWithProviders(<App />, { route });
    expect(await screen.findByRole("heading", { level: 1, name: title })).toBeInTheDocument();
  });

  it("an owner who has not finished onboarding is sent to /onboarding from any page", async () => {
    mockApi({
      "GET /api/v1/me": () => ({ ...me, onboardingCompleted: false }),
      "GET /api/v1/gmail/status": () => makeSyncStatus({ started: false, lastSyncAt: null }),
    });
    renderWithProviders(<App />, { route: "/applications" });
    expect(
      await screen.findByRole("heading", { level: 1, name: "Set up Offerbound" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Main" })).not.toBeInTheDocument();
  });

  it("the public demo is never sent to onboarding", async () => {
    mockApi({
      "GET /api/v1/me": () => ({ ...me, mode: "demo", email: null, onboardingCompleted: false }),
      "GET /api/v1/gmail/status": () => makeSyncStatus(),
      "GET /api/v1/nav-counts": () => makeNavCounts(),
    });
    renderWithProviders(<App />, { route: "/today" });
    expect(await screen.findByRole("heading", { level: 1, name: "Today" })).toBeInTheDocument();
  });

  it("shows an error with Try again when /me fails with a server error", async () => {
    mockApi({ "GET /api/v1/me": () => apiError(503, "not_ready", "Not ready.") });
    renderWithProviders(<App />, { route: "/today" });
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn.t load/i);
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});
