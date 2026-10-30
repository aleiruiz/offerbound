import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { makeCvProfile } from "../../../test/factories";
import {
  apiError,
  jsonResponse,
  mockApi,
  type MockApi,
  type MockHandler,
} from "../../../test/mock-api";
import { renderWithProviders } from "../../../test/render";
import { Cv } from "./Cv";

vi.setConfig({ testTimeout: 15_000 });

const PROFILE = makeCvProfile();
const NEW_PROFILE = makeCvProfile({ headline: "Staff-track engineer, 10 years, platform focus" });

function setup(routes: Record<string, MockHandler> = {}) {
  const api: MockApi = mockApi({
    "GET /api/v1/cv": () => PROFILE,
    ...routes,
  });
  const rendered = renderWithProviders(<Cv />, { route: "/settings/cv" });
  return { api, ...rendered, user: userEvent.setup({ applyAccept: false, delay: null }) };
}

const callsTo = (api: MockApi, method: string, path: string) =>
  api.calls.filter((c) => c.method === method && new URL(c.url).pathname === path);

const pdf = (name = "resume.pdf") =>
  new File([new Uint8Array(8)], name, { type: "application/pdf" });

describe("Settings, CV", () => {
  it("shows the profile with Replace CV and Re-rank new leads", async () => {
    setup();
    const section = await screen.findByRole("region", { name: "CV" });
    expect(await within(section).findByText(PROFILE.headline)).toBeInTheDocument();
    expect(
      within(section).getByText("8 years of experience · Monterrey, Mexico · English, Spanish"),
    ).toBeInTheDocument();
    const core = within(section).getByRole("list", { name: "Core skills" });
    expect(
      within(core)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["React", "TypeScript", "Node.js"]);
    const secondary = within(section).getByRole("list", { name: "Secondary skills" });
    expect(
      within(secondary)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Python", "Azure"]);
    expect(
      within(section).getByText(/Only the text and this profile are stored/),
    ).toBeInTheDocument();
    expect(within(section).getByLabelText("Replace CV")).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: "Re-rank new leads" })).toBeEnabled();
    expect(
      within(section).queryByRole("button", { name: "Retry profile" }),
    ).not.toBeInTheDocument();
  });

  it("Replace CV uploads to POST /cv and shows the new profile without re-ranking", async () => {
    const { api, user } = setup({
      "POST /api/v1/cv": () => jsonResponse(NEW_PROFILE, 201),
    });
    await user.upload(await screen.findByLabelText("Replace CV"), pdf());
    expect(await screen.findByText(NEW_PROFILE.headline)).toBeInTheDocument();
    expect(callsTo(api, "POST", "/api/v1/cv")).toHaveLength(1);
    expect(callsTo(api, "POST", "/api/v1/leads/rerank")).toHaveLength(0);
    // AC-11.4: replacing the CV does not re-rank; the owner is told how to.
    expect(
      screen.getByText(
        /Leads you already have keep their scores until you press Re-rank new leads/,
      ),
    ).toBeInTheDocument();
  });

  it("Re-rank new leads posts /leads/rerank", async () => {
    const { api, user } = setup({
      "POST /api/v1/leads/rerank": () => new Response(null, { status: 202 }),
    });
    await user.click(await screen.findByRole("button", { name: "Re-rank new leads" }));
    await waitFor(() => expect(callsTo(api, "POST", "/api/v1/leads/rerank")).toHaveLength(1));
    const request = callsTo(api, "POST", "/api/v1/leads/rerank")[0];
    expect(request?.headers.get("X-Offerbound-Request")).toBe("1");
    expect(await request?.json()).toEqual({ scope: "new" });
    expect(await screen.findByText(/Ranking your new leads again/)).toBeInTheDocument();
  });

  it("offers Retry profile after an upload whose profile failed, and builds it", async () => {
    let retryWorks = false;
    const { api, user } = setup({
      "POST /api/v1/cv": () => jsonResponse({ profileStatus: "failed", profile: null }, 202),
      "POST /api/v1/cv/retry-profile": () =>
        retryWorks ? NEW_PROFILE : apiError(502, "upstream_error", "OpenAI didn't answer."),
    });
    await user.upload(await screen.findByLabelText("Replace CV"), pdf());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Your CV was saved, but its profile isn't ready.");
    // The old profile no longer applies.
    expect(screen.queryByText(PROFILE.headline)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Re-rank new leads" })).not.toBeInTheDocument();

    // A failed retry says so and keeps the button.
    await user.click(screen.getByRole("button", { name: "Retry profile" }));
    expect(
      await screen.findByText(/Couldn't build the profile\. OpenAI didn't answer\./),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry profile" })).toBeEnabled();

    retryWorks = true;
    await user.click(screen.getByRole("button", { name: "Retry profile" }));
    expect(await screen.findByText(NEW_PROFILE.headline)).toBeInTheDocument();
    expect(callsTo(api, "POST", "/api/v1/cv/retry-profile")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Retry profile" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Re-rank new leads" })).toBeInTheDocument();
  });

  it("with no profile and no upload this session, offers to add the CV again", async () => {
    setup({ "GET /api/v1/cv": () => null });
    const section = await screen.findByRole("region", { name: "CV" });
    expect(await within(section).findByText("No CV profile yet")).toBeInTheDocument();
    expect(within(section).getByLabelText("Choose CV file")).toBeInTheDocument();
    expect(
      within(section).queryByRole("button", { name: "Retry profile" }),
    ).not.toBeInTheDocument();
    expect(
      within(section).queryByRole("button", { name: "Re-rank new leads" }),
    ).not.toBeInTheDocument();
  });

  it("turns away a file that is not a PDF or DOCX, or is over 5 MB, without sending it", async () => {
    const { api, user } = setup();
    const input = await screen.findByLabelText("Replace CV");
    await user.upload(input, new File(["x"], "notes.txt", { type: "text/plain" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Offerbound reads PDF and DOCX files. Choose one of those.",
    );
    await user.upload(
      input,
      new File([new Uint8Array(5 * 1024 * 1024 + 1)], "big.pdf", { type: "application/pdf" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("That file is larger than 5 MB");
    expect(callsTo(api, "POST", "/api/v1/cv")).toHaveLength(0);
    // The profile that was there stays.
    expect(screen.getByText(PROFILE.headline)).toBeInTheDocument();
  });

  it("shows the server's reason when the CV has no text, and keeps the profile", async () => {
    const { user } = setup({
      "POST /api/v1/cv": () => apiError(422, "cv_no_text", "No text."),
    });
    await user.upload(await screen.findByLabelText("Replace CV"), pdf());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We couldn't read text from that file",
    );
    expect(screen.getByText(PROFILE.headline)).toBeInTheDocument();
  });

  it("says when the CV cannot be loaded, and tries again", async () => {
    let fail = true;
    const { user } = setup({
      "GET /api/v1/cv": () => (fail ? apiError(500, "internal_error", "Nope.") : PROFILE),
    });
    expect(await screen.findByText(/Couldn't load your CV/)).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(PROFILE.headline)).toBeInTheDocument();
  });
});
