import type { Settings } from "@offerbound/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { makeSettings } from "../../../test/factories";
import { apiError, mockApi, type MockApi, type MockHandler } from "../../../test/mock-api";
import { renderWithProviders } from "../../../test/render";
import { setValue } from "../../../test/speed";
import { Automation } from "./Automation";

vi.setConfig({ testTimeout: 15_000 });

const SETTINGS: Settings = makeSettings({
  automation: { autoApplyMinConfidence: 0.8, senderIgnoreList: ["noreply@promo.example"] },
});

function setup(routes: Record<string, MockHandler> = {}) {
  const api: MockApi = mockApi({
    "GET /api/v1/settings": () => SETTINGS,
    "PUT /api/v1/settings": async (req) => (await req.clone().json()) as Settings,
    ...routes,
  });
  const rendered = renderWithProviders(<Automation />, { route: "/settings/automation" });
  return { api, ...rendered, user: userEvent.setup({ delay: null }) };
}

const putsTo = (api: MockApi) =>
  api.calls.filter((c) => c.method === "PUT" && new URL(c.url).pathname === "/api/v1/settings");

describe("Settings, Automation", () => {
  it("the slider runs from 0.50 to 0.99 and shows the value in words", async () => {
    setup();
    const slider = await screen.findByRole("slider", { name: "Auto-apply threshold" });
    expect(slider).toHaveAttribute("min", "0.5");
    expect(slider).toHaveAttribute("max", "0.99");
    expect(slider).toHaveAttribute("step", "0.01");
    expect(slider).toHaveValue("0.8");
    expect(
      screen.getByText(
        "Offerbound applies a change by itself when it is at least 80% sure. Anything less goes to Review.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("0.80")).toBeInTheDocument();

    fireEvent.change(slider, { target: { value: "0.5" } });
    expect(screen.getByText(/at least 50% sure/)).toBeInTheDocument();
    expect(screen.getByText("0.50")).toBeInTheDocument();
    fireEvent.change(slider, { target: { value: "0.99" } });
    expect(screen.getByText(/at least 99% sure/)).toBeInTheDocument();
    expect(slider).toHaveAttribute("aria-valuetext", "99% sure");
  });

  it("saves the threshold and the ignored senders through PUT /settings", async () => {
    const { api, user } = setup();
    const slider = await screen.findByRole("slider", { name: "Auto-apply threshold" });
    fireEvent.change(slider, { target: { value: "0.9" } });

    const list = screen.getByRole("list", { name: "Ignored senders" });
    expect(within(list).getByText("noreply@promo.example")).toBeInTheDocument();
    setValue(
      screen.getByRole("textbox", { name: "Add a sender or domain" }),
      "  Digest@News.Example ",
    );
    await user.click(screen.getByRole("button", { name: "Add sender" }));
    expect(within(list).getByText("digest@news.example")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Add a sender or domain" })).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Remove noreply@promo.example" }));
    expect(within(list).queryByText("noreply@promo.example")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(putsTo(api)).toHaveLength(1));
    expect(await putsTo(api)[0]?.json()).toEqual({
      ...SETTINGS,
      automation: { autoApplyMinConfidence: 0.9, senderIgnoreList: ["digest@news.example"] },
    });
    expect(await screen.findByText("Changes saved")).toBeInTheDocument();
  });

  it("adds a sender with Enter, and refuses a duplicate", async () => {
    const { user } = setup();
    const field = await screen.findByRole("textbox", { name: "Add a sender or domain" });
    await user.type(field, "NOREPLY@promo.example{Enter}");
    expect(field).toBeInvalid();
    expect(field).toHaveAccessibleDescription("That sender is already in the list.");
    await user.clear(field);
    await user.type(field, "jobs.example{Enter}");
    expect(
      within(screen.getByRole("list", { name: "Ignored senders" })).getByText("jobs.example"),
    ).toBeInTheDocument();
    await user.type(field, "two words{Enter}");
    expect(field).toHaveAccessibleDescription("Use an email address or a domain, without spaces.");
  });

  it("shows a field message from the server", async () => {
    const { user } = setup({
      "PUT /api/v1/settings": () =>
        apiError(400, "validation_failed", "Some settings are not valid.", {
          "automation.autoApplyMinConfidence": "Must be between 0.50 and 0.99",
        }),
    });
    await user.click(await screen.findByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Must be between 0.50 and 0.99")).toBeInTheDocument();
  });
});
