import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "../../test/render";
import { AppShell } from "./AppShell";

function renderShell(width: number, route = "/today") {
  return renderWithProviders(
    <Routes>
      <Route element={<AppShell />}>
        <Route path="today" element={<h1>Today</h1>} />
        <Route path="interviews" element={<h1>Interviews</h1>} />
        <Route path="settings/:section" element={<h1>Settings</h1>} />
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
      "/settings/gmail",
    );
    expect(within(nav).getByText(window.location.host)).toBeInTheDocument();
    expect(screen.getByRole("main")).toContainElement(
      screen.getByRole("heading", { name: "Today" }),
    );
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
      "/settings/gmail",
    );
  });

  it("below sm a top app bar shows the page title", () => {
    renderShell(400, "/interviews");
    const banner = screen.getByRole("banner");
    expect(within(banner).getByText("Interviews")).toBeInTheDocument();
  });

  it("marks More as current on Interviews and Settings", () => {
    renderShell(400, "/settings/gmail");
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("button", { name: "More" })).toHaveClass("Mui-selected");
  });
});
