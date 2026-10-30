import type { Settings } from "@offerbound/contracts";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { makeSearchRun, makeSettings } from "../../../test/factories";
import {
  apiError,
  jsonResponse,
  mockApi,
  type MockApi,
  type MockHandler,
} from "../../../test/mock-api";
import { renderWithProviders } from "../../../test/render";
import { heavyIt, setValue } from "../../../test/speed";
import { Search } from "./Search";

vi.setConfig({ testTimeout: 15_000 });

const ME = {
  mode: "private",
  email: "owner@example.test",
  onboardingCompleted: true,
  timezone: "America/Monterrey",
};

const BRIEF = "Find senior full-stack roles that are open now, remote from Mexico first.";

const SETTINGS: Settings = makeSettings({
  search: {
    brief: BRIEF,
    tracks: [
      { key: "A", label: "Remote from MX", priority: 1 },
      { key: "B", label: "Relocation", priority: 2 },
    ],
    excludedSeniorities: ["junior", "staff_plus", "manager"],
    leadTarget: { min: 20, max: 30 },
    runTime: "07:00",
    enabled: true,
  },
});

function setup(routes: Record<string, MockHandler> = {}) {
  const api: MockApi = mockApi({
    "GET /api/v1/me": () => ME,
    "GET /api/v1/settings": () => SETTINGS,
    "GET /api/v1/search/runs": () => [],
    ...routes,
  });
  const rendered = renderWithProviders(<Search />, { route: "/settings/search" });
  return { api, ...rendered, user: userEvent.setup({ delay: null }) };
}

const callsTo = (api: MockApi, method: string, path: string) =>
  api.calls.filter((c) => c.method === method && new URL(c.url).pathname === path);

describe("Settings, Job search", () => {
  it("shows the brief with a 12,000 character count, tracks, excluded levels and the run time", async () => {
    setup();
    const section = await screen.findByRole("region", { name: "Job search" });
    expect(within(section).getByRole("textbox", { name: "Search brief" })).toHaveValue(BRIEF);
    expect(within(section).getByText(`${BRIEF.length} of 12,000 characters`)).toBeInTheDocument();
    expect(within(section).getByRole("switch", { name: "Run every day" })).toBeChecked();
    expect(within(section).getByLabelText("At")).toHaveValue("07:00");
    const target = within(section).getByRole("group", { name: "New leads per day" });
    expect(within(target).getByRole("spinbutton", { name: "At least" })).toHaveValue(20);
    expect(within(target).getByRole("spinbutton", { name: "At most" })).toHaveValue(30);
    expect(within(section).getByText(/Monterrey time\./)).toBeInTheDocument();

    const keys = within(section).getAllByRole("textbox", { name: "Track key" });
    expect(keys.map((k) => (k as HTMLInputElement).value)).toEqual(["A", "B"]);
    expect(
      within(section)
        .getAllByRole("textbox", { name: "Track name" })
        .map((n) => (n as HTMLInputElement).value),
    ).toEqual(["Remote from MX", "Relocation"]);
    expect(within(section).getAllByLabelText("Track priority")[1]).toHaveValue("2");

    const levels = within(section).getByRole("group", { name: "Never show these levels" });
    const pressed = within(levels)
      .getAllByRole("button")
      .map((chip) => [chip.textContent, chip.getAttribute("aria-pressed")]);
    expect(pressed).toEqual([
      ["Junior", "true"],
      ["Mid", "false"],
      ["Senior", "false"],
      ["Staff and above", "true"],
      ["Hands-on lead", "false"],
      ["Managers who don't code", "true"],
    ]);
  });

  heavyIt("Save changes puts the full Settings with the edited search part", async () => {
    const { api, user } = setup({
      "PUT /api/v1/settings": async (req) => (await req.clone().json()) as Settings,
    });
    const field = await screen.findByRole("textbox", { name: "Search brief" });
    setValue(field, "New brief");
    expect(screen.getByText("9 of 12,000 characters")).toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: "Run every day" }));
    setValue(screen.getByLabelText("At"), "08:30");
    setValue(screen.getByRole("spinbutton", { name: "At least" }), "25");
    setValue(screen.getByRole("spinbutton", { name: "At most" }), "35");
    await user.click(screen.getByRole("button", { name: "Mid" }));
    await user.click(screen.getByRole("button", { name: "Junior" }));
    await user.selectOptions(screen.getAllByLabelText("Track priority")[1] as HTMLElement, "3");
    setValue(screen.getAllByRole("textbox", { name: "Track name" })[0] as HTMLElement, "Remote");
    await user.click(screen.getByRole("button", { name: "Add track" }));
    const keys = screen.getAllByRole("textbox", { name: "Track key" });
    expect(keys).toHaveLength(3);
    setValue(keys[2] as HTMLElement, "C");
    setValue(
      screen.getAllByRole("textbox", { name: "Track name" })[2] as HTMLElement,
      "Hands-on lead",
    );
    await user.click(screen.getByRole("button", { name: "Remove track B" }));

    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(callsTo(api, "PUT", "/api/v1/settings")).toHaveLength(1));
    const put = callsTo(api, "PUT", "/api/v1/settings")[0];
    expect(put?.headers.get("X-Offerbound-Request")).toBe("1");
    expect(await put?.json()).toEqual({
      ...SETTINGS,
      search: {
        brief: "New brief",
        tracks: [
          { key: "A", label: "Remote", priority: 1 },
          { key: "C", label: "Hands-on lead", priority: 3 },
        ],
        excludedSeniorities: ["mid", "staff_plus", "manager"],
        leadTarget: { min: 25, max: 35 },
        runTime: "08:30",
        enabled: false,
      },
    });
    expect(await screen.findByText("Changes saved")).toBeInTheDocument();
  });

  it("a 400 from PUT /settings shows the field message under the field", async () => {
    const { user } = setup({
      "PUT /api/v1/settings": () =>
        apiError(400, "validation_failed", "Some settings are not valid.", {
          "search.brief": "The brief is too long for the model.",
          "search.leadTarget.max": "Must be at least the minimum",
          "search.runTime": "Use HH:mm, for example 07:00",
          "search.tracks.1.key": "Track keys must be unique",
        }),
    });
    await user.click(await screen.findByRole("button", { name: "Save changes" }));

    const brief = await screen.findByRole("textbox", { name: "Search brief" });
    await waitFor(() => expect(brief).toBeInvalid());
    expect(brief).toHaveAccessibleDescription(/The brief is too long for the model\./);
    expect(screen.getByRole("spinbutton", { name: "At most" })).toHaveAccessibleDescription(
      "Must be at least the minimum",
    );
    expect(screen.getByLabelText("At")).toHaveAccessibleDescription("Use HH:mm, for example 07:00");
    expect(screen.getAllByRole("textbox", { name: "Track key" })[1]).toHaveAccessibleDescription(
      "Track keys must be unique",
    );
    expect(screen.queryByText("Changes saved")).not.toBeInTheDocument();
  });

  it("says a failed save failed, and keeps what was typed", async () => {
    const { user } = setup({
      "PUT /api/v1/settings": () => apiError(502, "upstream_error", "The database didn't answer."),
    });
    setValue(await screen.findByRole("textbox", { name: "Search brief" }), "Kept text");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't save your settings. The database didn't answer.",
    );
    expect(screen.getByRole("textbox", { name: "Search brief" })).toHaveValue("Kept text");
  });

  it("blocks a brief over 12,000 characters and a lead target whose maximum is below its minimum", async () => {
    const { api, user } = setup();
    const brief = await screen.findByRole("textbox", { name: "Search brief" });
    setValue(brief, "a".repeat(12_001));
    expect(screen.getByText(/12,001 of 12,000 characters/)).toBeInTheDocument();
    expect(brief).toBeInvalid();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();

    setValue(brief, "ok");
    setValue(screen.getByRole("spinbutton", { name: "At most" }), "10");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(screen.getByRole("spinbutton", { name: "At most" })).toHaveAccessibleDescription(
      "Must be at least the minimum",
    );
    expect(callsTo(api, "PUT", "/api/v1/settings")).toHaveLength(0);
  });

  it("Run search now posts /search/run and says it started", async () => {
    const { api, user } = setup({
      "POST /api/v1/search/run": () =>
        jsonResponse(makeSearchRun({ id: "sr9", status: "running", finishedAt: null }), 202),
    });
    await user.click(await screen.findByRole("button", { name: "Run search now" }));
    await waitFor(() => expect(callsTo(api, "POST", "/api/v1/search/run")).toHaveLength(1));
    expect(await screen.findByText(/Search started/)).toBeInTheDocument();
  });

  it("says when a search is already running", async () => {
    const { user } = setup({
      "POST /api/v1/search/run": () =>
        apiError(409, "already_running", "A search is already running."),
    });
    await user.click(await screen.findByRole("button", { name: "Run search now" }));
    expect(await screen.findByText("A search is already running.")).toBeInTheDocument();
  });

  it("shows a loading failure with Try again", async () => {
    let fail = true;
    const { user } = setup({
      "GET /api/v1/settings": () =>
        fail ? apiError(500, "internal_error", "Something went wrong.") : SETTINGS,
    });
    expect(await screen.findByText(/Couldn't load your settings/)).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("textbox", { name: "Search brief" })).toBeInTheDocument();
  });
});

describe("Settings, Recent runs", () => {
  it("lists the last 14 runs with their errors", async () => {
    const runs = Array.from({ length: 14 }, (_, i) =>
      makeSearchRun({
        id: `sr${i}`,
        // Day 14 down to day 1 of November, 07:00 in Monterrey.
        startedAt: new Date(Date.UTC(2026, 10, 14 - i, 13, 0)).toISOString(),
        accepted: 10 + i,
      }),
    );
    runs[2] = makeSearchRun({
      id: "failed",
      status: "failed",
      startedAt: runs[2]?.startedAt ?? "",
      error: "OpenAI timed out in round 2. 6 leads from round 1 were kept.",
      costMicros: 390_000,
      accepted: 6,
    });
    runs[3] = makeSearchRun({
      id: "partial",
      status: "partial",
      startedAt: runs[3]?.startedAt ?? "",
      error: "One search round failed.",
      trigger: "manual",
    });
    runs[4] = makeSearchRun({
      id: "now",
      status: "running",
      startedAt: runs[4]?.startedAt ?? "",
      finishedAt: null,
      costMicros: null,
    });
    // The API gives no order: the list sorts newest first.
    setup({ "GET /api/v1/search/runs": () => [...runs].reverse() });

    const section = await screen.findByRole("region", { name: "Recent runs" });
    expect(within(section).getByText("Last 14 runs")).toBeInTheDocument();
    const table = await within(section).findByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(14);
    expect(within(rows[0] as HTMLElement).getByText("Nov 14, 07:00")).toBeInTheDocument();
    expect(within(rows[13] as HTMLElement).getByText("Nov 1, 07:00")).toBeInTheDocument();

    const headers = within(table)
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(headers).toEqual([
      "Started",
      "Result",
      "New leads",
      "Suppressed",
      "Duplicates",
      "Closed postings",
      "Web searches",
      "Cost",
    ]);

    const failed = rows[2] as HTMLElement;
    expect(within(failed).getByText("Failed")).toBeInTheDocument();
    expect(
      within(failed).getByText("OpenAI timed out in round 2. 6 leads from round 1 were kept."),
    ).toBeInTheDocument();
    expect(within(failed).getByText("US$0.39")).toBeInTheDocument();

    const partial = rows[3] as HTMLElement;
    expect(within(partial).getByText("Partly done")).toBeInTheDocument();
    expect(within(partial).getByText("One search round failed.")).toBeInTheDocument();
    expect(within(partial).getByText("Run by you")).toBeInTheDocument();

    const running = rows[4] as HTMLElement;
    expect(within(running).getByText("Running")).toBeInTheDocument();
    expect(within(running).getByText("Unknown")).toBeInTheDocument();

    const done = rows[0] as HTMLElement;
    expect(within(done).getByText("Done")).toBeInTheDocument();
    expect(within(done).getByText("US$0.61")).toBeInTheDocument();
    expect(within(done).getByText("Scheduled")).toBeInTheDocument();
    expect(
      within(done)
        .getAllByRole("cell")
        .slice(2)
        .map((c) => c.textContent),
    ).toEqual(["10", "9", "3", "3", "58", "US$0.61"]);
  });

  it("says when no search has run", async () => {
    setup();
    expect(await screen.findByText("No search has run yet.")).toBeInTheDocument();
  });

  it("says when the runs cannot be read", async () => {
    setup({ "GET /api/v1/search/runs": () => apiError(500, "internal_error", "Nope.") });
    expect(await screen.findByText(/Couldn't load the recent runs/)).toBeInTheDocument();
  });
});
