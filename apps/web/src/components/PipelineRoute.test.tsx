import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "../../test/render";
import { PipelineRoute } from "./PipelineRoute";

const byStatus = {
  applied: 12,
  screening: 3,
  assessment: 2,
  interviewing: 3,
  offer: 0,
  accepted: 0,
  rejected: 17,
  withdrawn: 1,
  abandoned: 3,
};

describe("PipelineRoute", () => {
  it("links each stop to /applications?status=<s>, draws a hollow stop for 0, and shows the Closed branch counts", () => {
    renderWithProviders(<PipelineRoute byStatus={byStatus} />);
    const stages = screen.getByRole("list", { name: "Active applications by stage" });
    const links = within(stages).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/applications?status=applied",
      "/applications?status=screening",
      "/applications?status=assessment",
      "/applications?status=interviewing",
      "/applications?status=offer",
    ]);
    expect(within(links[0]!).getByText("12")).toBeInTheDocument();
    expect(within(links[0]!).getByText("Applied")).toBeInTheDocument();

    const stops = Array.from(stages.querySelectorAll("[data-stop-status]"));
    expect(stops.map((s) => s.getAttribute("data-hollow"))).toEqual([
      "false",
      "false",
      "false",
      "false",
      "true",
    ]);

    const closed = screen.getByRole("group", { name: "Closed" });
    expect(within(closed).getByRole("link", { name: "Rejected 17" })).toHaveAttribute(
      "href",
      "/applications?status=rejected",
    );
    expect(within(closed).getByText("Withdrawn 1")).toBeInTheDocument();
    expect(within(closed).getByText("Abandoned 3")).toBeInTheDocument();
  });

  it("treats a missing status as 0", () => {
    renderWithProviders(<PipelineRoute byStatus={{ applied: 2 }} />);
    expect(screen.getByRole("link", { name: /^0\s*Offer$/ })).toBeInTheDocument();
  });

  it("slides the marker from the old stop to the new one in 400 ms ease-out", async () => {
    renderWithProviders(
      <PipelineRoute byStatus={byStatus} movement={{ from: "applied", to: "interviewing" }} />,
    );
    const marker = screen.getByTestId("route-marker");
    expect(marker).toHaveStyle({ transition: "left 400ms ease-out" });
    await waitFor(() => expect(marker.style.left).toBe("70%"));
    expect(marker).toHaveAttribute("data-stop", "interviewing");
  });

  it("jumps under reduced motion", () => {
    renderWithProviders(
      <PipelineRoute byStatus={byStatus} movement={{ from: "applied", to: "interviewing" }} />,
      { reducedMotion: true },
    );
    const marker = screen.getByTestId("route-marker");
    expect(marker.style.left).toBe("70%");
    expect(marker.style.transition).toBe("");
  });

  it("has no marker when the application is not on the line", () => {
    renderWithProviders(
      <PipelineRoute byStatus={byStatus} movement={{ from: "interviewing", to: "rejected" }} />,
    );
    expect(screen.queryByTestId("route-marker")).not.toBeInTheDocument();
  });
});
