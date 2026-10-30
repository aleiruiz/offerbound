import { render } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { applicationOrigin, parentOf, resetOrigin, topLevelPage, useTrackOrigin } from "./origin";

let go: (to: string) => void = () => {};

function Tracker() {
  useTrackOrigin();
  const navigate = useNavigate();
  go = (to) => void navigate(to);
  return null;
}

function renderAt(route: string) {
  render(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route path="*" element={<Tracker />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("origin", () => {
  afterEach(() => resetOrigin());

  it("knows the destinations' own pages and nothing below them", () => {
    expect(topLevelPage("/")).toEqual({ to: "/today", label: "Today" });
    expect(topLevelPage("/leads")).toEqual({ to: "/leads", label: "Leads" });
    expect(topLevelPage("/applications/abc")).toBeUndefined();
    expect(topLevelPage("/settings/gmail")).toBeUndefined();
  });

  it("an application goes back to the Applications list when nothing was recorded", () => {
    expect(applicationOrigin()).toEqual({ to: "/applications", label: "Applications" });
  });

  it("an application goes back to the last top-level page, filters included", () => {
    renderAt("/today");
    expect(applicationOrigin()).toEqual({ to: "/today", label: "Today" });
    act(() => go("/applications?status=applied"));
    act(() => go("/applications/abc"));
    expect(applicationOrigin()).toEqual({
      to: "/applications?status=applied",
      label: "Applications",
    });
    act(() => go("/leads"));
    act(() => go("/applications/abc"));
    expect(parentOf("/applications/abc")).toEqual({ to: "/leads", label: "Leads" });
  });

  it("sub-pages lead to their destination, and destinations have no parent", () => {
    expect(parentOf("/leads/import")).toEqual({ to: "/leads", label: "Leads" });
    expect(parentOf("/settings/cv")).toEqual({ to: "/settings", label: "Settings" });
    expect(parentOf("/today")).toBeUndefined();
    expect(parentOf("/settings")).toBeUndefined();
  });
});
