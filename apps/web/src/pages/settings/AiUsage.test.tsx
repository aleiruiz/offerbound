import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { makeAiUsage } from "../../../test/factories";
import { apiError, mockApi, type MockApi, type MockHandler } from "../../../test/mock-api";
import { renderWithProviders } from "../../../test/render";
import { AiUsage } from "./AiUsage";

vi.setConfig({ testTimeout: 15_000 });

function setup(routes: Record<string, MockHandler> = {}) {
  const api: MockApi = mockApi({ "GET /api/v1/ai-usage": () => makeAiUsage(), ...routes });
  const rendered = renderWithProviders(<AiUsage />, { route: "/settings/ai-usage" });
  return { api, ...rendered, user: userEvent.setup({ delay: null }) };
}

describe("Settings, AI usage", () => {
  it("shows month-to-date cost, the table by purpose with 'unknown' counts and a 30-bar SVG chart", async () => {
    const { container } = setup();
    const section = await screen.findByRole("region", { name: "AI usage" });

    expect(await within(section).findByText("US$1.84")).toBeInTheDocument();
    expect(within(section).getByText("Month to date")).toBeInTheDocument();
    // Two calls have no price: the total leaves them out, and says so.
    expect(
      within(section).getByText("2 calls have no known price and are not counted in this total."),
    ).toBeInTheDocument();

    const table = within(section).getByRole("table", { name: "Cost by purpose" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(
      rows.map((row) =>
        within(row)
          .getAllByRole("cell")
          .map((c) => c.textContent),
      ),
    ).toEqual([
      ["Sorting email", "640", "US$0.31"],
      ["Reading job emails", "212", "US$0.59"],
      ["Ranking leads", "96", "US$0.24"],
      ["Searching for leads", "14", "US$0.70, 2 calls unknown"],
    ]);

    const chart = within(section).getByRole("img", { name: "Daily AI cost, last 30 days" });
    expect(chart.tagName.toLowerCase()).toBe("svg");
    expect(container.querySelectorAll("svg rect[data-bar]")).toHaveLength(30);
    // Every bar has the day and the cost for people who point at it.
    expect(container.querySelector("svg rect[data-bar] title")?.textContent).toBe("Oct 1: US$0.02");
  });

  it("writes 'unknown' where every call of a purpose has no price", async () => {
    setup({
      "GET /api/v1/ai-usage": () =>
        makeAiUsage({
          monthToDateMicros: 0,
          byPurpose: [{ purpose: "cv_profile", calls: 3, costMicros: 0, unknownCostCalls: 3 }],
        }),
    });
    const table = await screen.findByRole("table", { name: "Cost by purpose" });
    const cells = within(within(table).getAllByRole("row")[1] as HTMLElement).getAllByRole("cell");
    expect(cells.map((c) => c.textContent)).toEqual(["Reading your CV", "3", "Unknown"]);
  });

  it("says so when nothing has been used yet", async () => {
    setup({
      "GET /api/v1/ai-usage": () =>
        makeAiUsage({
          monthToDateMicros: 0,
          byPurpose: [],
          last30Days: makeAiUsage().last30Days.map((d) => ({ ...d, costMicros: 0 })),
        }),
    });
    expect(await screen.findByText("US$0.00")).toBeInTheDocument();
    expect(screen.getByText("No AI calls this month yet.")).toBeInTheDocument();
  });

  it("shows a loading failure with Try again", async () => {
    let fail = true;
    const { user } = setup({
      "GET /api/v1/ai-usage": () =>
        fail ? apiError(500, "internal_error", "Nope.") : makeAiUsage(),
    });
    expect(await screen.findByText(/Couldn't load AI usage/)).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("US$1.84")).toBeInTheDocument();
  });
});
