import { DEFAULT_SETTINGS } from "@offerbound/contracts";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { DEMO_ME, makeCvProfile, makeSettings } from "../../test/factories";
import { mockApi } from "../../test/mock-api";
import { renderWithProviders } from "../../test/render";
import { FinishSetupCard, SETUP_HIDDEN_KEY } from "./FinishSetupCard";

const OWN_BRIEF = makeSettings({
  search: { ...DEFAULT_SETTINGS.search, brief: "Senior backend roles, remote from home." },
});

function setup(cv: unknown, settings: unknown, me = undefined as typeof DEMO_ME | undefined) {
  mockApi({
    "GET /api/v1/cv": () => cv,
    "GET /api/v1/settings": () => settings,
  });
  return renderWithProviders(<FinishSetupCard />, { me });
}

describe("FinishSetupCard", () => {
  afterEach(() => window.localStorage.clear());

  it("lists the CV and the brief while both are missing, each linking to its section", async () => {
    setup(null, DEFAULT_SETTINGS);
    expect(await screen.findByRole("heading", { name: "Finish setting up" })).toBeInTheDocument();
    expect(screen.getByText(/2 setup steps are still open/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Upload CV" })).toHaveAttribute("href", "/settings/cv");
    expect(screen.getByRole("link", { name: "Write brief" })).toHaveAttribute(
      "href",
      "/settings/search",
    );
  });

  it("lists only what is missing", async () => {
    setup(makeCvProfile(), DEFAULT_SETTINGS);
    expect(await screen.findByRole("link", { name: "Write brief" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Upload CV" })).not.toBeInTheDocument();
  });

  it("is not shown once the CV and the owner's own brief are on file", async () => {
    const { queryClient } = setup(makeCvProfile(), OWN_BRIEF);
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(screen.queryByRole("heading", { name: "Finish setting up" })).not.toBeInTheDocument();
  });

  it("Hide keeps it away on this device", async () => {
    const user = userEvent.setup({ delay: null });
    const { unmount } = setup(null, DEFAULT_SETTINGS);
    await user.click(await screen.findByRole("button", { name: "Hide" }));
    expect(screen.queryByRole("heading", { name: "Finish setting up" })).not.toBeInTheDocument();
    expect(window.localStorage.getItem(SETUP_HIDDEN_KEY)).toBe("1");
    unmount();
    const { queryClient } = setup(null, DEFAULT_SETTINGS);
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(screen.queryByRole("heading", { name: "Finish setting up" })).not.toBeInTheDocument();
  });

  it("is never shown in the demo", async () => {
    const { queryClient } = setup(null, DEFAULT_SETTINGS, DEMO_ME);
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(screen.queryByRole("heading", { name: "Finish setting up" })).not.toBeInTheDocument();
  });
});
