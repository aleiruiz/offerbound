import type { CvProfile, ImportSummary, Settings, SheetPreview } from "@offerbound/contracts";
import { DEFAULT_SETTINGS } from "@offerbound/contracts";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import { makeSyncStatus } from "../../test/factories";
import {
  apiError,
  jsonResponse,
  mockApi,
  type MockApi,
  type MockHandler,
} from "../../test/mock-api";
import { renderWithProviders } from "../../test/render";
import { queryKeys } from "../api/hooks";
import { OnboardingPage } from "./OnboardingPage";

const PROFILE: CvProfile = {
  headline: "Full-stack engineer with eight years in payments",
  yearsExperience: 8,
  coreSkills: ["TypeScript", "React", "PostgreSQL"],
  secondarySkills: ["Go"],
  domains: ["Payments"],
  recentRoles: [{ title: "Senior Engineer", company: "Tidewater Labs", years: "2021-2026" }],
  leadership: null,
  languages: ["English", "Spanish"],
  location: "Monterrey, Mexico",
  workAuthorization: null,
};

const PREVIEW: SheetPreview = {
  previewId: "preview-1",
  expiresAt: "2026-10-30T13:00:00Z",
  totalRows: 102,
  mappings: [
    { sheetStatus: "to_research", target: "lead_new", rows: 40 },
    { sheetStatus: "cancelled", target: "lead_dismissed", rows: 26 },
    { sheetStatus: "applied", target: "application_applied", rows: 15 },
    { sheetStatus: "interview", target: "application_interviewing", rows: 2 },
    { sheetStatus: "rejected", target: "application_rejected", rows: 18 },
  ],
  errors: [{ line: 58, message: 'The status "Paused" is not one Offerbound knows.' }],
  duplicatesInFile: [],
  existingMatches: 0,
};

const SUMMARY: ImportSummary = {
  applicationsCreated: 35,
  leadsCreated: 40,
  leadsDismissed: 26,
  skippedExisting: 0,
  skippedDuplicateRows: 0,
  errorRows: 1,
};

const ME = {
  mode: "private",
  email: "owner@example.test",
  onboardingCompleted: true,
  timezone: "America/Monterrey",
};

type Routes = Record<string, MockHandler>;

function setup(routes: Routes = {}) {
  const api: MockApi = mockApi({
    "GET /api/v1/gmail/status": () =>
      makeSyncStatus({ connection: "active", started: false, lastSyncAt: null }),
    "GET /api/v1/settings": () => DEFAULT_SETTINGS,
    ...routes,
  });
  const rendered = renderWithProviders(
    <Routes>
      <Route path="/onboarding" element={<OnboardingPage />} />
      <Route path="/today" element={<h1>Today</h1>} />
    </Routes>,
    { route: "/onboarding" },
  );
  // The operating system's picker can hand over any file despite `accept`, so tests bypass it too.
  return { api, ...rendered, user: userEvent.setup({ applyAccept: false }) };
}

function file(name: string, type: string, bytes = 8): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

const callsTo = (api: MockApi, method: string, path: string) =>
  api.calls.filter((c) => c.method === method && new URL(c.url).pathname === path);

async function skipTo(user: ReturnType<typeof userEvent.setup>, steps: number) {
  for (let i = 0; i < steps; i += 1) {
    await user.click(await screen.findByRole("button", { name: "Skip this step" }));
  }
}

describe("OnboardingPage", () => {
  it("shows four steps — Upload your CV, Import your spreadsheet, Write your search brief, Start syncing Gmail — and only the last can't be skipped", async () => {
    const { user } = setup();
    expect(
      screen.getByRole("heading", { level: 1, name: "Set up Offerbound" }),
    ).toBeInTheDocument();
    const steps = screen.getByLabelText("Setup steps");
    for (const name of [
      "Upload your CV",
      "Import your spreadsheet",
      "Write your search brief",
      "Start syncing Gmail",
    ]) {
      expect(within(steps).getByText(name)).toBeInTheDocument();
    }
    expect(within(steps).getByText("Upload your CV").closest("[aria-current]")).toHaveAttribute(
      "aria-current",
      "step",
    );

    // Steps 1 to 3 can be skipped, and the Back button is there from step 2 on.
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
    await skipTo(user, 3);
    expect(screen.getByRole("heading", { level: 2, name: "Start syncing Gmail" })).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Skip this step" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start syncing" })).toBeEnabled();
    expect(within(steps).getAllByText("Skipped")).toHaveLength(3);

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(
      screen.getByRole("heading", { level: 2, name: "Write your search brief" }),
    ).toBeVisible();
  });

  describe("the CV step", () => {
    it("uploads to POST /cv and shows the profile summary", async () => {
      const { api, user } = setup({
        "POST /api/v1/cv": () => jsonResponse(PROFILE, 201),
      });
      await user.upload(screen.getByLabelText("Choose CV file"), file("cv.pdf", "application/pdf"));

      const profile = await screen.findByRole("region", { name: "Your CV profile" });
      expect(within(profile).getByText(PROFILE.headline)).toBeInTheDocument();
      expect(
        within(profile).getByText("8 years of experience · Monterrey, Mexico · English, Spanish"),
      ).toBeInTheDocument();
      expect(within(profile).getByText("TypeScript")).toBeInTheDocument();
      expect(within(profile).getByText(/Senior Engineer/)).toBeInTheDocument();

      const post = callsTo(api, "POST", "/api/v1/cv")[0];
      expect(post?.headers.get("X-Offerbound-Request")).toBe("1");
      expect((api.upload(post as Request)?.get("file") as File).name).toBe("cv.pdf");

      expect(screen.queryByRole("button", { name: "Skip this step" })).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Continue" }));
      expect(
        screen.getByRole("heading", { level: 2, name: "Import your spreadsheet" }),
      ).toBeVisible();
      expect(within(screen.getByLabelText("Setup steps")).queryByText("Skipped")).toBeNull();
    });

    it("says 'We couldn't read text from that file' on 422 cv_no_text", async () => {
      const { user } = setup({
        "POST /api/v1/cv": () => apiError(422, "cv_no_text", "No text was found in this file."),
      });
      await user.upload(
        screen.getByLabelText("Choose CV file"),
        file("scan.pdf", "application/pdf"),
      );
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "We couldn't read text from that file.",
      );
      expect(screen.queryByRole("region", { name: "Your CV profile" })).not.toBeInTheDocument();
      // The owner can still skip, or choose another file.
      expect(screen.getByRole("button", { name: "Skip this step" })).toBeInTheDocument();
    });

    it("rejects a file over 5 MB without sending it", async () => {
      const { api, user } = setup();
      await user.upload(
        screen.getByLabelText("Choose CV file"),
        file("big.pdf", "application/pdf", 5 * 1024 * 1024 + 1),
      );
      expect(await screen.findByRole("alert")).toHaveTextContent("larger than 5 MB");
      expect(callsTo(api, "POST", "/api/v1/cv")).toHaveLength(0);
    });

    it("rejects a file that is not a PDF or DOCX in the page, even when the picker allowed it", async () => {
      const { api, user } = setup();
      await user.upload(screen.getByLabelText("Choose CV file"), file("notes.txt", "text/plain"));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Offerbound reads PDF and DOCX files. Choose one of those.",
      );
      expect(callsTo(api, "POST", "/api/v1/cv")).toHaveLength(0);
      expect(screen.getByRole("button", { name: "Skip this step" })).toBeInTheDocument();
    });

    it("accepts a DOCX by extension even when the browser reports no type", async () => {
      const { user } = setup({ "POST /api/v1/cv": () => jsonResponse(PROFILE, 201) });
      await user.upload(screen.getByLabelText("Choose CV file"), file("cv.docx", ""));
      expect(await screen.findByRole("region", { name: "Your CV profile" })).toBeInTheDocument();
    });

    it("keeps showing the last good profile when a later upload fails", async () => {
      let answer: MockHandler = () => jsonResponse(PROFILE, 201);
      const { user } = setup({ "POST /api/v1/cv": (req) => answer(req) });
      await user.upload(screen.getByLabelText("Choose CV file"), file("cv.pdf", "application/pdf"));
      expect(await screen.findByText(PROFILE.headline)).toBeInTheDocument();

      answer = () => apiError(422, "cv_no_text", "No text was found in this file.");
      await user.upload(screen.getByLabelText("Replace CV"), file("scan.pdf", "application/pdf"));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "We couldn't read text from that file.",
      );
      expect(screen.getByText(PROFILE.headline)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Skip this step" })).not.toBeInTheDocument();
    });

    it("a 202 re-upload replaces the profile with the warning, since the new CV is the one on file", async () => {
      let status = 201;
      const { user } = setup({
        "POST /api/v1/cv": () =>
          status === 201
            ? jsonResponse(PROFILE, 201)
            : jsonResponse({ profileStatus: "failed", profile: null }, 202),
      });
      await user.upload(screen.getByLabelText("Choose CV file"), file("cv.pdf", "application/pdf"));
      expect(await screen.findByText(PROFILE.headline)).toBeInTheDocument();
      status = 202;
      await user.upload(screen.getByLabelText("Replace CV"), file("cv2.pdf", "application/pdf"));
      expect(await screen.findByRole("alert")).toHaveTextContent("its profile isn't ready");
      expect(screen.queryByText(PROFILE.headline)).not.toBeInTheDocument();
    });

    it("keeps going when the CV is saved but its profile failed", async () => {
      const { user } = setup({
        "POST /api/v1/cv": () => jsonResponse({ profileStatus: "failed", profile: null }, 202),
      });
      await user.upload(screen.getByLabelText("Choose CV file"), file("cv.pdf", "application/pdf"));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Your CV was saved, but its profile isn't ready.",
      );
      expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
    });
  });

  describe("the import step", () => {
    async function toImport(routes: Routes = {}) {
      const rendered = setup({
        "POST /api/v1/import/sheet/preview": () => PREVIEW,
        ...routes,
      });
      await skipTo(rendered.user, 1);
      return rendered;
    }

    it("shows the mapping preview and skipped rows, and 'Import N rows' commits", async () => {
      const { api, user } = await toImport({
        "POST /api/v1/import/sheet/commit": () => jsonResponse(SUMMARY, 201),
      });
      await user.upload(
        screen.getByLabelText("Choose CSV file"),
        file("Applications.csv", "text/csv"),
      );

      expect(await screen.findByText("Applications.csv")).toBeInTheDocument();
      expect(screen.getByText("102 rows found under the title rows")).toBeInTheDocument();
      const table = screen.getByRole("table");
      expect(
        within(table).getByRole("columnheader", { name: "Status in your sheet" }),
      ).toBeInTheDocument();
      expect(
        within(table).getByRole("row", {
          name: /To research.*New leads, checked and ranked after import.*40/,
        }),
      ).toBeInTheDocument();
      expect(
        within(table).getByRole("row", {
          name: /Interview.*Applications with status Interviewing.*2/,
        }),
      ).toBeInTheDocument();
      const skipped = screen.getByRole("alert");
      expect(skipped).toHaveTextContent("1 row will be skipped.");
      expect(skipped).toHaveTextContent('Row 58: The status "Paused" is not one Offerbound knows.');

      const upload = callsTo(api, "POST", "/api/v1/import/sheet/preview")[0];
      expect((api.upload(upload as Request)?.get("file") as File).name).toBe("Applications.csv");

      await user.click(screen.getByRole("button", { name: "Import 101 rows" }));
      await screen.findByText(/Imported 35 applications, 40 new leads and 26 dismissed leads\./);
      expect(screen.getByText(/1 row skipped\./)).toBeInTheDocument();
      const commit = callsTo(api, "POST", "/api/v1/import/sheet/commit")[0];
      expect(await commit?.json()).toEqual({ previewId: "preview-1" });

      await user.click(screen.getByRole("button", { name: "Continue" }));
      expect(
        screen.getByRole("heading", { level: 2, name: "Write your search brief" }),
      ).toBeVisible();
    });

    it("tells the owner when the file was already imported", async () => {
      const { user } = await toImport({
        "POST /api/v1/import/sheet/commit": () =>
          apiError(409, "duplicate_import", "This file was imported before."),
      });
      await user.upload(
        screen.getByLabelText("Choose CSV file"),
        file("Applications.csv", "text/csv"),
      );
      await user.click(await screen.findByRole("button", { name: "Import 101 rows" }));
      expect(await screen.findByText(/This file was already imported\./)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Skip this step" })).toBeInTheDocument();
    });

    it("shows the preview's error when the file can't be read", async () => {
      const { user } = await toImport({
        "POST /api/v1/import/sheet/preview": () =>
          apiError(422, "unsupported_file", "No Company, Role and Status columns were found."),
      });
      await user.upload(screen.getByLabelText("Choose CSV file"), file("other.csv", "text/csv"));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "No Company, Role and Status columns were found.",
      );
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
    });
    it("rejects a file that is not a CSV in the page, and keeps the preview already shown", async () => {
      const rendered = await toImport();
      const { user } = rendered;
      await user.upload(
        screen.getByLabelText("Choose CSV file"),
        file("Applications.csv", "text/csv"),
      );
      await screen.findByText("Applications.csv");
      const before = callsTo(rendered.api, "POST", "/api/v1/import/sheet/preview").length;

      await user.upload(screen.getByLabelText("Replace file"), file("sheet.xlsx", ""));
      expect(await screen.findByText(/Offerbound imports CSV files\./)).toBeInTheDocument();
      expect(callsTo(rendered.api, "POST", "/api/v1/import/sheet/preview")).toHaveLength(before);
      expect(screen.getByText("Applications.csv")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Import 101 rows" })).toBeInTheDocument();
    });
  });

  describe("the brief step", () => {
    it("saves through PUT /settings with the edited brief and the rest of the settings unchanged", async () => {
      const settings: Settings = {
        ...DEFAULT_SETTINGS,
        search: { ...DEFAULT_SETTINGS.search, brief: "Old brief", enabled: true },
      };
      const { api, user } = setup({
        "GET /api/v1/settings": () => settings,
        "PUT /api/v1/settings": async (req) => (await req.clone().json()) as Settings,
      });
      await skipTo(user, 2);

      const field = await screen.findByRole("textbox", { name: "Search brief" });
      expect(field).toHaveValue("Old brief");
      await user.clear(field);
      await user.type(field, "Senior roles, remote from Mexico.");
      expect(screen.getByText("33 of 12,000 characters")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Save and continue" }));

      await waitFor(() => expect(callsTo(api, "PUT", "/api/v1/settings")).toHaveLength(1));
      const put = callsTo(api, "PUT", "/api/v1/settings")[0];
      expect(put?.headers.get("X-Offerbound-Request")).toBe("1");
      expect(await put?.json()).toEqual({
        ...settings,
        search: { ...settings.search, brief: "Senior roles, remote from Mexico." },
      });
      expect(
        await screen.findByRole("heading", { level: 2, name: "Start syncing Gmail" }),
      ).toBeVisible();
    });

    it("after a successful save, coming back shows Continue and no Skip, whether or not the text was typed", async () => {
      const { user } = setup({
        "PUT /api/v1/settings": async (req) => (await req.clone().json()) as Settings,
      });
      await skipTo(user, 2);
      await user.type(await screen.findByRole("textbox", { name: "Search brief" }), "Remote roles");
      await user.click(screen.getByRole("button", { name: "Save and continue" }));
      await screen.findByRole("heading", { level: 2, name: "Start syncing Gmail" });

      await user.click(screen.getByRole("button", { name: "Back" }));
      expect(screen.getByRole("textbox", { name: "Search brief" })).toHaveValue("Remote roles");
      expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
      expect(screen.queryByRole("button", { name: "Skip this step" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Save and continue" })).not.toBeInTheDocument();

      // Editing again offers to save the change, and still no Skip.
      await user.type(screen.getByRole("textbox", { name: "Search brief" }), " in Mexico");
      expect(screen.getByRole("button", { name: "Save and continue" })).toBeEnabled();
      expect(screen.queryByRole("button", { name: "Skip this step" })).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Save and continue" }));
      expect(
        await screen.findByRole("heading", { level: 2, name: "Start syncing Gmail" }),
      ).toBeVisible();
    });

    it("starts with an empty field instead of the shipped example text", async () => {
      const { user } = setup();
      await skipTo(user, 2);
      const field = await screen.findByRole("textbox", { name: "Search brief" });
      expect(field).toHaveValue("");
      expect(screen.getByRole("button", { name: "Save and continue" })).toBeDisabled();
    });

    it("blocks a brief over 12,000 characters", async () => {
      const { user } = setup();
      await skipTo(user, 2);
      const field = await screen.findByRole("textbox", { name: "Search brief" });
      await user.click(field);
      await user.paste("a".repeat(12_001));
      expect(
        screen.getByText(/12,001 of 12,000 characters\. Shorten it to save\./),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Save and continue" })).toBeDisabled();
    });

    it("shows a failed save and keeps the text", async () => {
      const { user } = setup({
        "PUT /api/v1/settings": () =>
          apiError(502, "upstream_error", "The database didn't answer."),
      });
      await skipTo(user, 2);
      await user.type(await screen.findByRole("textbox", { name: "Search brief" }), "Remote roles");
      await user.click(screen.getByRole("button", { name: "Save and continue" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't save your brief.");
      expect(screen.getByRole("textbox", { name: "Search brief" })).toHaveValue("Remote roles");
    });
  });

  describe("the Gmail step", () => {
    it("Start syncing posts /gmail/start, shows first-sync progress, then completes onboarding and goes to /today", async () => {
      let status = makeSyncStatus({ started: false, lastSyncAt: null });
      const { api, user, queryClient } = setup({
        "GET /api/v1/gmail/status": () => status,
        "POST /api/v1/gmail/start": () => {
          status = makeSyncStatus({
            started: true,
            lastSyncAt: null,
            backfill: { state: "running", listed: 400, processed: 120 },
          });
          return jsonResponse(status, 202);
        },
        "POST /api/v1/onboarding/complete": () => ME,
      });
      await skipTo(user, 3);
      expect(screen.getByRole("list", { name: "What Offerbound reads" })).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Start syncing" }));

      const progress = await screen.findByText(/120 of 400 checked\./);
      expect(progress).toBeInTheDocument();
      expect(screen.getByRole("progressbar", { name: "First sync" })).toHaveAttribute(
        "aria-valuenow",
        "30",
      );
      const start = callsTo(api, "POST", "/api/v1/gmail/start")[0];
      expect(start?.headers.get("X-Offerbound-Request")).toBe("1");
      expect(callsTo(api, "POST", "/api/v1/onboarding/complete")).toHaveLength(0);

      // The next status check says the first sync is done.
      status = makeSyncStatus({
        started: true,
        backfill: { state: "done", listed: 400, processed: 400 },
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.syncStatus });

      expect(await screen.findByRole("heading", { level: 1, name: "Today" })).toBeInTheDocument();
      expect(callsTo(api, "POST", "/api/v1/onboarding/complete")).toHaveLength(1);
      expect(queryClient.getQueryData(queryKeys.me)).toEqual(ME);
    });

    it("Go to Today finishes setup while the first sync is still running", async () => {
      const { api, user } = setup({
        "GET /api/v1/gmail/status": () =>
          makeSyncStatus({
            started: true,
            lastSyncAt: null,
            backfill: { state: "running", listed: 400, processed: 120 },
          }),
        "POST /api/v1/onboarding/complete": () => ME,
      });
      // A first sync that was already started opens on the step that shows it.
      expect(await screen.findByText(/120 of 400 checked\./)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Start syncing" })).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Go to Today" }));
      expect(await screen.findByRole("heading", { level: 1, name: "Today" })).toBeInTheDocument();
      expect(callsTo(api, "POST", "/api/v1/onboarding/complete")).toHaveLength(1);
    });

    it("offers Connect Gmail instead of Start syncing when Google stopped Gmail access", async () => {
      const { api, user } = setup({
        "GET /api/v1/gmail/status": () =>
          makeSyncStatus({ connection: "missing_scope", started: false, lastSyncAt: null }),
      });
      await skipTo(user, 3);
      expect(await screen.findByRole("link", { name: "Connect Gmail" })).toHaveAttribute(
        "href",
        "/api/v1/auth/google/start",
      );
      expect(screen.getByRole("button", { name: "Start syncing" })).toBeDisabled();
      expect(callsTo(api, "POST", "/api/v1/gmail/start")).toHaveLength(0);
    });

    it("says so when starting fails, and lets the owner try again", async () => {
      const { user } = setup({
        "POST /api/v1/gmail/start": () => apiError(502, "upstream_error", "Google did not answer."),
      });
      await skipTo(user, 3);
      await user.click(screen.getByRole("button", { name: "Start syncing" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't start syncing.");
      expect(screen.getByRole("button", { name: "Start syncing" })).toBeEnabled();
    });

    it("shows when the first sync stopped", async () => {
      setup({
        "GET /api/v1/gmail/status": () =>
          makeSyncStatus({
            started: true,
            backfill: { state: "failed", listed: 400, processed: 120 },
          }),
      });
      expect(await screen.findByRole("alert")).toHaveTextContent("The first sync stopped");
      expect(screen.getByRole("button", { name: "Go to Today" })).toBeInTheDocument();
    });
  });
});
