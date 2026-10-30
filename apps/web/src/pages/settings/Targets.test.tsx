import type { ReactElement } from "react";
import type { Settings } from "@offerbound/contracts";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { makeSettings } from "../../../test/factories";
import { apiError, mockApi, type MockApi, type MockHandler } from "../../../test/mock-api";
import { renderWithProviders } from "../../../test/render";
import { setValue } from "../../../test/speed";
import { Targets } from "./Targets";
import { Timers } from "./Timers";

vi.setConfig({ testTimeout: 15_000 });

const SETTINGS: Settings = makeSettings();

function setup(element: ReactElement, routes: Record<string, MockHandler> = {}) {
  const api: MockApi = mockApi({
    "GET /api/v1/settings": () => SETTINGS,
    "PUT /api/v1/settings": async (req) => (await req.clone().json()) as Settings,
    ...routes,
  });
  const rendered = renderWithProviders(element, { route: "/settings" });
  return { api, ...rendered, user: userEvent.setup({ delay: null }) };
}

const putsTo = (api: MockApi) =>
  api.calls.filter((c) => c.method === "PUT" && new URL(c.url).pathname === "/api/v1/settings");

describe("Settings, Daily targets", () => {
  it("shows each target and saves the edited ones through PUT /settings", async () => {
    const { api, user } = setup(<Targets />);
    const leads = await screen.findByRole("group", { name: "New leads" });
    expect(within(leads).getByRole("spinbutton", { name: "At least" })).toHaveValue(20);
    expect(within(leads).getByRole("spinbutton", { name: "At most" })).toHaveValue(30);
    const outreach = screen.getByRole("group", { name: "Outreach messages" });
    expect(within(outreach).getByRole("spinbutton", { name: "At least" })).toHaveValue(5);
    expect(within(outreach).queryByRole("spinbutton", { name: "At most" })).not.toBeInTheDocument();
    const prep = screen.getByRole("group", { name: "Prep minutes" });
    expect(within(prep).getByRole("spinbutton", { name: "At least" })).toHaveValue(90);
    expect(screen.getByRole("group", { name: "Applications" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Follow-ups" })).toBeInTheDocument();

    setValue(within(leads).getByRole("spinbutton", { name: "At most" }), "40");
    setValue(within(outreach).getByRole("spinbutton", { name: "At least" }), "8");
    setValue(within(prep).getByRole("spinbutton", { name: "At least" }), "120");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(putsTo(api)).toHaveLength(1));
    expect(putsTo(api)[0]?.headers.get("X-Offerbound-Request")).toBe("1");
    expect(await putsTo(api)[0]?.json()).toEqual({
      ...SETTINGS,
      dailyTargets: {
        ...SETTINGS.dailyTargets,
        leads: { min: 20, max: 40 },
        outreach: { min: 8 },
        prepMinutes: { min: 120 },
      },
    });
    expect(await screen.findByText("Changes saved")).toBeInTheDocument();
  });

  it("asks for a maximum that is not below the minimum, and a number in every field", async () => {
    const { api, user } = setup(<Targets />);
    const apps = await screen.findByRole("group", { name: "Applications" });
    setValue(within(apps).getByRole("spinbutton", { name: "At most" }), "3");
    const followUps = screen.getByRole("group", { name: "Follow-ups" });
    setValue(within(followUps).getByRole("spinbutton", { name: "At least" }), "");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(within(apps).getByRole("spinbutton", { name: "At most" })).toHaveAccessibleDescription(
      "Must be at least the minimum",
    );
    expect(
      within(followUps).getByRole("spinbutton", { name: "At least" }),
    ).toHaveAccessibleDescription("Enter a whole number");
    expect(putsTo(api)).toHaveLength(0);
  });

  it("shows a server field message under the field", async () => {
    const { user } = setup(<Targets />, {
      "PUT /api/v1/settings": () =>
        apiError(400, "validation_failed", "Some settings are not valid.", {
          "dailyTargets.applications.max": "Must be at least the minimum",
        }),
    });
    await user.click(await screen.findByRole("button", { name: "Save changes" }));
    const apps = await screen.findByRole("group", { name: "Applications" });
    await waitFor(() =>
      expect(within(apps).getByRole("spinbutton", { name: "At most" })).toHaveAccessibleDescription(
        "Must be at least the minimum",
      ),
    );
  });
});

describe("Settings, Timers", () => {
  it("shows the two timers and the rule, and saves through PUT /settings", async () => {
    const { api, user } = setup(<Timers />);
    const followUp = await screen.findByRole("spinbutton", { name: "Follow-up days" });
    const abandon = screen.getByRole("spinbutton", { name: "Abandon days" });
    expect(followUp).toHaveValue(7);
    expect(abandon).toHaveValue(14);
    expect(
      screen.getByText(/Abandon days must be greater than follow-up days\./),
    ).toBeInTheDocument();

    setValue(followUp, "5");
    setValue(abandon, "21");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(putsTo(api)).toHaveLength(1));
    expect(await putsTo(api)[0]?.json()).toEqual({
      ...SETTINGS,
      timers: { followUpDays: 5, abandonDays: 21 },
    });
    expect(await screen.findByText("Changes saved")).toBeInTheDocument();
  });

  it("abandon days not above follow-up days shows the field error and sends nothing", async () => {
    const { api, user } = setup(<Timers />);
    setValue(await screen.findByRole("spinbutton", { name: "Abandon days" }), "7");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    const abandon = screen.getByRole("spinbutton", { name: "Abandon days" });
    expect(abandon).toBeInvalid();
    expect(abandon).toHaveAccessibleDescription("Must be greater than the follow-up days");
    expect(putsTo(api)).toHaveLength(0);
  });

  it("shows the server's field error for the same rule", async () => {
    const { user } = setup(<Timers />, {
      "PUT /api/v1/settings": () =>
        apiError(400, "validation_failed", "Some settings are not valid.", {
          "timers.abandonDays": "Must be greater than the follow-up days",
          "timers.followUpDays": "Too large",
        }),
    });
    await user.click(await screen.findByRole("button", { name: "Save changes" }));
    const abandon = await screen.findByRole("spinbutton", { name: "Abandon days" });
    await waitFor(() =>
      expect(abandon).toHaveAccessibleDescription("Must be greater than the follow-up days"),
    );
    expect(screen.getByRole("spinbutton", { name: "Follow-up days" })).toHaveAccessibleDescription(
      "Too large",
    );
  });

  it("keeps the numbers inside 1 to 60 and 2 to 90", async () => {
    const { api, user } = setup(<Timers />);
    setValue(await screen.findByRole("spinbutton", { name: "Follow-up days" }), "61");
    setValue(screen.getByRole("spinbutton", { name: "Abandon days" }), "91");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(screen.getByRole("spinbutton", { name: "Follow-up days" })).toHaveAccessibleDescription(
      "Use a number from 1 to 60",
    );
    expect(screen.getByRole("spinbutton", { name: "Abandon days" })).toHaveAccessibleDescription(
      "Use a number from 2 to 90",
    );
    expect(putsTo(api)).toHaveLength(0);
  });
});
