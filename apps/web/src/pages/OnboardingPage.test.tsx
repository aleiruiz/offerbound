import type { CvProfile, ImportSummary, Settings, SheetPreview } from "@offerbound/contracts";
import { DEFAULT_SETTINGS } from "@offerbound/contracts";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeSyncStatus } from "../../test/factories";
import {
  apiError,
  jsonResponse,
  mockApi,
  type MockApi,
  type MockHandler,
} from "../../test/mock-api";
import lockupLight from "../assets/brand/lockup.svg";
import { renderWithProviders } from "../../test/render";
import { heavyIt, setValue } from "../../test/speed";
import { queryKeys } from "../api/hooks";
import { ONBOARDING_STORAGE_KEY } from "../lib/onboardingProgress";
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

const RUNNING = makeSyncStatus({
  started: true,
  lastSyncAt: null,
  backfill: { state: "running", listed: 400, processed: 120 },
});
const NOT_STARTED = makeSyncStatus({ connection: "active", started: false, lastSyncAt: null });

async function setup(routes: Routes = {}, { settled = true } = {}) {
  const api: MockApi = mockApi({
    // The sync is already running, so the page opens on the CV step (step 2); tests of the first
    // step say otherwise with NOT_STARTED.
    "GET /api/v1/gmail/status": () => RUNNING,
    "GET /api/v1/settings": () => DEFAULT_SETTINGS,
    "GET /api/v1/cv": () => null,
    ...routes,
  });
  const rendered = renderWithProviders(
    <Routes>
      <Route path="/onboarding" element={<OnboardingPage />} />
      <Route path="/today" element={<h1>Today</h1>} />
    </Routes>,
    { route: "/onboarding" },
  );
  // The page shows a skeleton until the CV, settings and sync status answers are in.
  if (settled) {
    await waitFor(() =>
      expect(screen.queryByLabelText("Loading your setup")).not.toBeInTheDocument(),
    );
  }
  // The operating system's picker can hand over any file despite `accept`, so tests bypass it too.
  return { api, ...rendered, user: userEvent.setup({ applyAccept: false, delay: null }) };
}

function file(name: string, type: string, bytes = 8): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

const callsTo = (api: MockApi, method: string, path: string) =>
  api.calls.filter((c) => c.method === method && new URL(c.url).pathname === path);

/** A drop carrying these files, the way a browser reports a drag from the desktop. */
const dropping = (...files: File[]) => ({ dataTransfer: { files, types: ["Files"] } });

/** Lets queued promise callbacks run, so "nothing was sent" is checked after a request would have been. */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function skipTo(user: ReturnType<typeof userEvent.setup>, steps: number) {
  for (let i = 0; i < steps; i += 1) {
    await user.click(await screen.findByRole("button", { name: "Skip this step" }));
  }
}

describe("OnboardingPage", () => {
  // Heavy under jsdom (MUI re-renders on every step); see heavyIt.
  heavyIt(
    "shows four steps — Start syncing Gmail, Upload your CV, Import your spreadsheet, Write your search brief — and only the first can't be skipped",
    async () => {
      await setup({ "GET /api/v1/gmail/status": () => NOT_STARTED });
      expect(
        screen.getByRole("heading", { level: 1, name: "Set up Offerbound" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("img", { name: "Offerbound" })).toHaveAttribute("src", lockupLight);
      const steps = screen.getByLabelText("Setup steps");
      const names = [
        "Start syncing Gmail",
        "Upload your CV",
        "Import your spreadsheet",
        "Write your search brief",
      ];
      const labels = within(steps)
        .getAllByText(/^(Start syncing|Upload|Import|Write)/)
        .map((node) => node.textContent);
      expect(labels).toEqual(names);
      expect(
        within(steps).getByText("Start syncing Gmail").closest("[aria-current]"),
      ).toHaveAttribute("aria-current", "step");

      // The first step has no Back and no Skip; the others can be skipped.
      expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Skip this step" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Start syncing" })).toBeEnabled();
      expect(within(steps).getAllByText("Optional")).toHaveLength(3);
    },
  );

  it("marks steps 2 to 4 Optional in the stepper until they are skipped, and never the first", async () => {
    const { user } = await setup();
    const steps = screen.getByLabelText("Setup steps");
    expect(within(steps).getAllByText("Optional")).toHaveLength(3);
    for (const name of ["Upload your CV", "Import your spreadsheet", "Write your search brief"]) {
      expect(within(steps).getByText(name).closest("[class*=MuiStepLabel-root]")).toHaveTextContent(
        "Optional",
      );
    }
    expect(
      within(steps).getByText("Start syncing Gmail").closest("[class*=MuiStepLabel-root]"),
    ).not.toHaveTextContent("Optional");

    await skipTo(user, 1);
    expect(within(steps).getAllByText("Optional")).toHaveLength(2);
    expect(within(steps).getAllByText("Skipped")).toHaveLength(1);
  });

  describe("the CV step", () => {
    it("uploads to POST /cv and shows the profile summary", async () => {
      const { api, user } = await setup({
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
      const steps = screen.getByLabelText("Setup steps");
      expect(within(steps).queryByText("Skipped")).toBeNull();
      // A completed step shows no caption at all; the two steps still to do keep "Optional".
      expect(
        within(steps).getByText("Upload your CV").closest("[class*=MuiStepLabel-root]"),
      ).not.toHaveTextContent(/Optional|Skipped/);
      expect(within(steps).getAllByText("Optional")).toHaveLength(2);
    });

    it("accepts a file dropped on the drop zone, using the first of several", async () => {
      const { api } = await setup({ "POST /api/v1/cv": () => jsonResponse(PROFILE, 201) });
      const zone = screen.getByRole("group", { name: "CV drop zone" });
      expect(within(zone).getByRole("button", { name: "Choose CV file" })).toBeInTheDocument();

      fireEvent.drop(
        zone,
        dropping(file("cv.pdf", "application/pdf"), file("other.pdf", "application/pdf")),
      );
      expect(await screen.findByRole("region", { name: "Your CV profile" })).toBeInTheDocument();
      const posts = callsTo(api, "POST", "/api/v1/cv");
      expect(posts).toHaveLength(1);
      expect((api.upload(posts[0] as Request)?.get("file") as File).name).toBe("cv.pdf");
    });

    it("gives a dropped file the same checks as a chosen one", async () => {
      const { api } = await setup();
      const zone = screen.getByRole("group", { name: "CV drop zone" });
      fireEvent.drop(zone, dropping(file("notes.txt", "text/plain")));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Offerbound reads PDF and DOCX files. Choose one of those.",
      );
      fireEvent.drop(zone, dropping(file("big.pdf", "application/pdf", 5 * 1024 * 1024 + 1)));
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("larger than 5 MB"));
      expect(callsTo(api, "POST", "/api/v1/cv")).toHaveLength(0);
    });

    it("shows a drag-over state while a file is dragged over the zone", async () => {
      await setup();
      const zone = screen.getByRole("group", { name: "CV drop zone" });
      expect(zone).not.toHaveAttribute("data-drag-over");
      expect(within(zone).getByText("or drop a file here")).toBeInTheDocument();

      fireEvent.dragEnter(zone, dropping());
      expect(zone).toHaveAttribute("data-drag-over", "true");
      expect(within(zone).getByText("Drop the file to add it")).toBeInTheDocument();

      fireEvent.dragLeave(zone);
      expect(zone).not.toHaveAttribute("data-drag-over");

      // Dragging something that isn't a file (selected text, say) doesn't light the zone up.
      fireEvent.dragEnter(zone, { dataTransfer: { files: [], types: ["text/plain"] } });
      expect(zone).not.toHaveAttribute("data-drag-over");
    });

    it("shows the file, a progress bar and what to expect while the CV is read, and ignores drops meanwhile", async () => {
      const answer = deferred<Response>();
      const { api, user } = await setup({ "POST /api/v1/cv": () => answer.promise });
      await user.upload(
        screen.getByLabelText("Choose CV file"),
        file("my-long-cv-file-name.pdf", "application/pdf"),
      );

      const zone = screen.getByRole("group", { name: "CV drop zone" });
      const status = await within(zone).findByRole("status");
      expect(status).toHaveAttribute("aria-live", "polite");
      expect(within(status).getByText("my-long-cv-file-name.pdf")).toBeInTheDocument();
      expect(within(status).getByRole("progressbar", { name: "Reading your CV" })).toBeVisible();
      // The name is shown once, ellipsized; the sentence doesn't repeat it, since a long name has
      // no break points and would push the page wider than a phone.
      expect(status).toHaveTextContent(
        "Reading your CV and building your profile. This usually takes under a minute; keep this page open.",
      );
      expect(within(status).getAllByText(/my-long-cv-file-name\.pdf/)).toHaveLength(1);
      expect(within(status).getByText("my-long-cv-file-name.pdf")).toHaveStyle({
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        overflow: "hidden",
      });
      // No greyed-out chooser and no drop hint while the upload runs.
      expect(within(zone).queryByRole("button", { name: /CV/ })).not.toBeInTheDocument();
      expect(within(zone).queryByText("or drop a file here")).not.toBeInTheDocument();
      fireEvent.drop(zone, dropping(file("second.pdf", "application/pdf")));
      await settle();
      expect(callsTo(api, "POST", "/api/v1/cv")).toHaveLength(1);
      expect(status).not.toHaveTextContent("second.pdf");

      answer.resolve(jsonResponse(PROFILE, 201));
      expect(await screen.findByRole("region", { name: "Your CV profile" })).toBeInTheDocument();
      expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Replace CV" })).toBeInTheDocument();
    });

    it("moves focus to the status region when the chooser that had it goes away", async () => {
      const answer = deferred<Response>();
      await setup({ "POST /api/v1/cv": () => answer.promise });
      const chooser = screen.getByLabelText("Choose CV file");
      // A browser leaves focus on the input after its picker closes.
      chooser.focus();
      fireEvent.change(chooser, { target: { files: [file("cv.pdf", "application/pdf")] } });
      const zone = screen.getByRole("group", { name: "CV drop zone" });
      await waitFor(() => expect(within(zone).getByRole("status")).toHaveFocus());
      answer.resolve(jsonResponse(PROFILE, 201));
      await screen.findByRole("region", { name: "Your CV profile" });
      expect(within(zone).getByRole("status")).toHaveFocus();
    });

    it("says 'We couldn't read text from that file' on 422 cv_no_text", async () => {
      const { user } = await setup({
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
      const { api, user } = await setup();
      await user.upload(
        screen.getByLabelText("Choose CV file"),
        file("big.pdf", "application/pdf", 5 * 1024 * 1024 + 1),
      );
      expect(await screen.findByRole("alert")).toHaveTextContent("larger than 5 MB");
      expect(callsTo(api, "POST", "/api/v1/cv")).toHaveLength(0);
    });

    it("rejects a file that is not a PDF or DOCX in the page, even when the picker allowed it", async () => {
      const { api, user } = await setup();
      await user.upload(screen.getByLabelText("Choose CV file"), file("notes.txt", "text/plain"));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Offerbound reads PDF and DOCX files. Choose one of those.",
      );
      expect(callsTo(api, "POST", "/api/v1/cv")).toHaveLength(0);
      expect(screen.getByRole("button", { name: "Skip this step" })).toBeInTheDocument();
    });

    it("accepts a DOCX by extension even when the browser reports no type", async () => {
      const { user } = await setup({ "POST /api/v1/cv": () => jsonResponse(PROFILE, 201) });
      await user.upload(screen.getByLabelText("Choose CV file"), file("cv.docx", ""));
      expect(await screen.findByRole("region", { name: "Your CV profile" })).toBeInTheDocument();
    });

    it("keeps showing the last good profile when a later upload fails", async () => {
      let answer: MockHandler = () => jsonResponse(PROFILE, 201);
      const { user } = await setup({ "POST /api/v1/cv": (req) => answer(req) });
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
      const { user } = await setup({
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

    it("keeps the 'profile isn't ready' warning when a later upload is rejected or fails", async () => {
      let answer: MockHandler = () => jsonResponse({ profileStatus: "failed", profile: null }, 202);
      const { user } = await setup({ "POST /api/v1/cv": (req) => answer(req) });
      await user.upload(screen.getByLabelText("Choose CV file"), file("cv.pdf", "application/pdf"));
      expect(await screen.findByText(/its profile isn't ready/)).toBeInTheDocument();

      // Turned away by the page, then failed by the server: the CV on file still has no profile.
      await user.upload(screen.getByLabelText("Replace CV"), file("notes.txt", "text/plain"));
      expect(await screen.findByText(/Offerbound reads PDF and DOCX files/)).toBeInTheDocument();
      expect(screen.getByText(/its profile isn't ready/)).toBeInTheDocument();

      answer = () => apiError(422, "cv_no_text", "No text was found in this file.");
      await user.upload(screen.getByLabelText("Replace CV"), file("scan.pdf", "application/pdf"));
      expect(await screen.findByText(/We couldn't read text from that file/)).toBeInTheDocument();
      expect(screen.getByText(/its profile isn't ready/)).toBeInTheDocument();
    });

    it("keeps going when the CV is saved but its profile failed", async () => {
      const { user } = await setup({
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
      const rendered = await setup({
        "POST /api/v1/import/sheet/preview": () => PREVIEW,
        ...routes,
      });
      await skipTo(rendered.user, 1);
      return rendered;
    }

    it("says the step is optional, and what to expect, before any file is chosen", async () => {
      const { api, user } = await toImport();
      const section = screen.getByRole("region", { name: "Import your spreadsheet" });
      expect(within(section).getByText("Optional")).toBeInTheDocument();
      expect(
        within(section).getByText(
          "If you don't track your applications in a spreadsheet, skip this step. Gmail sync builds your list from your emails.",
        ),
      ).toBeInTheDocument();

      const expectations = within(section).getByRole("button", { name: "What to expect" });
      expect(expectations).toHaveAttribute("aria-expanded", "true");
      const list = within(section).getByRole("list");
      const items = within(list).getAllByRole("listitem");
      expect(items).toHaveLength(5);
      expect(items[0]).toHaveTextContent(
        "What it reads: the Applications tab exported as CSV. Offerbound finds the header row by itself; it needs Company, Role and Status. It also uses Country, City or modality, Date applied, Salary, Sponsorship or relocation, Job link and Notes when they are there.",
      );
      expect(items[1]).toHaveTextContent(
        "How statuses become records: To research becomes a new lead. Applied, Interview and Rejected become applications. Cancelled becomes a dismissed lead. Any other status is reported and skipped.",
      );
      expect(items[2]).toHaveTextContent(
        "What you see first: a preview with counts, rows with errors and duplicates in the file. Nothing is saved until you press Import.",
      );
      expect(items[3]).toHaveTextContent(
        "Duplicates: rows that match records you already have are skipped, and the same file can't be imported twice.",
      );
      expect(items[4]).toHaveTextContent("Your spreadsheet: it isn't changed.");

      // The section can be folded away on a small screen; the skip line and the button stay.
      await user.click(expectations);
      expect(expectations).toHaveAttribute("aria-expanded", "false");
      expect(
        within(section).getByText(/If you don't track your applications in a spreadsheet/),
      ).toBeVisible();
      expect(within(section).getByRole("button", { name: "Skip this step" })).toBeVisible();
      expect(api.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
    });

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
      // Gmail sync comes first, so rows it already found are skipped rather than duplicated.
      expect(screen.getByText(/Rows already found in Gmail are skipped/)).toBeVisible();
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
      expect(await screen.findByText("This file was already imported")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Skip this step" })).toBeInTheDocument();
    });

    it("accepts a CSV dropped on the drop zone, using the first of several", async () => {
      const { api } = await toImport();
      const zone = screen.getByRole("group", { name: "CSV drop zone" });
      expect(within(zone).getByRole("button", { name: "Choose CSV file" })).toBeInTheDocument();
      fireEvent.drop(
        zone,
        dropping(file("Applications.csv", "text/csv"), file("second.csv", "text/csv")),
      );
      expect(await screen.findByText("Applications.csv")).toBeInTheDocument();
      const posts = callsTo(api, "POST", "/api/v1/import/sheet/preview");
      expect(posts).toHaveLength(1);
      expect((api.upload(posts[0] as Request)?.get("file") as File).name).toBe("Applications.csv");
    });

    it("gives a dropped file the same checks as a chosen one", async () => {
      const { api } = await toImport();
      const zone = screen.getByRole("group", { name: "CSV drop zone" });
      fireEvent.drop(zone, dropping(file("notes.txt", "text/plain")));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Offerbound imports CSV files. In Google Sheets, choose File, Download, Comma-separated values, then add that file.",
      );
      fireEvent.drop(zone, dropping(file("big.csv", "text/csv", 2 * 1024 * 1024 + 1)));
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("larger than 2 MB"));
      expect(callsTo(api, "POST", "/api/v1/import/sheet/preview")).toHaveLength(0);
    });

    it("ignores drops while the preview is read and after the import", async () => {
      const answer = deferred<Response>();
      const { api, user } = await toImport({
        "POST /api/v1/import/sheet/preview": () => answer.promise,
        "POST /api/v1/import/sheet/commit": () => jsonResponse(SUMMARY, 201),
      });
      await user.upload(
        screen.getByLabelText("Choose CSV file"),
        file("Applications.csv", "text/csv"),
      );
      const zone = screen.getByRole("group", { name: "CSV drop zone" });
      fireEvent.drop(zone, dropping(file("second.csv", "text/csv")));
      await settle();
      expect(callsTo(api, "POST", "/api/v1/import/sheet/preview")).toHaveLength(1);

      answer.resolve(jsonResponse(PREVIEW));
      await user.click(await screen.findByRole("button", { name: "Import 101 rows" }));
      await screen.findByText(/Imported 35 applications/);
      fireEvent.drop(zone, dropping(file("third.csv", "text/csv")));
      await settle();
      expect(callsTo(api, "POST", "/api/v1/import/sheet/preview")).toHaveLength(1);
      expect(screen.getByText("Applications.csv")).toBeInTheDocument();
    });

    it("shows a generic message on a server error from the preview", async () => {
      const { user } = await toImport({
        "POST /api/v1/import/sheet/preview": () =>
          apiError(500, "internal_error", "Something went wrong."),
      });
      await user.upload(
        screen.getByLabelText("Choose CSV file"),
        file("Applications.csv", "text/csv"),
      );
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Couldn't import the file. Try again.",
      );
      expect(screen.queryByText(/isn't available yet/)).not.toBeInTheDocument();
    });

    it("shows the generic message for a commit server error or an unreadable answer", async () => {
      let answer: MockHandler = () => apiError(500, "internal_error", "Something went wrong.");
      const { api, user } = await toImport({
        "POST /api/v1/import/sheet/commit": (req) => answer(req),
      });
      await user.upload(
        screen.getByLabelText("Choose CSV file"),
        file("Applications.csv", "text/csv"),
      );
      await user.click(await screen.findByRole("button", { name: "Import 101 rows" }));
      expect(await screen.findByText("Couldn't import the file. Try again.")).toBeVisible();
      expect(screen.queryByText("Something went wrong.")).not.toBeInTheDocument();
      expect(screen.queryByText(/isn't available yet/)).not.toBeInTheDocument();

      answer = () => new Response("<html>Bad gateway</html>", { status: 502 });
      await user.click(screen.getByRole("button", { name: "Import 101 rows" }));
      await waitFor(() =>
        expect(callsTo(api, "POST", "/api/v1/import/sheet/commit")).toHaveLength(2),
      );
      expect(await screen.findByText("Couldn't import the file. Try again.")).toBeVisible();
      expect(screen.queryByText("The server answered with status 502.")).not.toBeInTheDocument();
    });

    it("does not call a preview that is not found 'expired': only the commit can say that", async () => {
      const { user } = await toImport({
        "POST /api/v1/import/sheet/preview": () => apiError(404, "not_found", "Not found."),
      });
      await user.upload(
        screen.getByLabelText("Choose CSV file"),
        file("Applications.csv", "text/csv"),
      );
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Couldn't import the file. Try again.",
      );
      expect(screen.queryByText(/expired/)).not.toBeInTheDocument();
      expect(screen.queryByText(/isn't available yet/)).not.toBeInTheDocument();

      // The way on stays open: Skip is visible and moves to the next step.
      await user.click(screen.getByRole("button", { name: "Skip this step" }));
      expect(
        screen.getByRole("heading", { level: 2, name: "Write your search brief" }),
      ).toBeVisible();
      expect(within(screen.getByLabelText("Setup steps")).getAllByText("Skipped")).toHaveLength(2);
    });

    it("says the same when the preview answers without the usual error body, or never arrives", async () => {
      const { user } = await toImport({
        "POST /api/v1/import/sheet/preview": () =>
          new Response("<html>Bad gateway</html>", { status: 502 }),
      });
      await user.upload(
        screen.getByLabelText("Choose CSV file"),
        file("Applications.csv", "text/csv"),
      );
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Couldn't import the file. Try again.",
      );
      expect(screen.getByRole("button", { name: "Skip this step" })).toBeVisible();
    });

    it("says the same when the request never reaches the server", async () => {
      const { user } = await toImport({
        "POST /api/v1/import/sheet/preview": () => Promise.reject(new TypeError("Failed to fetch")),
      });
      await user.upload(
        screen.getByLabelText("Choose CSV file"),
        file("Applications.csv", "text/csv"),
      );
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Couldn't import the file. Try again.",
      );
    });

    it("shows the server's message when the preview finds no header row", async () => {
      const { user } = await toImport({
        "POST /api/v1/import/sheet/preview": () =>
          apiError(
            400,
            "validation_failed",
            "Offerbound couldn't find a header row with Company, Role and Status.",
            { file: "no_header_row" },
          ),
      });
      await user.upload(screen.getByLabelText("Choose CSV file"), file("notes.csv", "text/csv"));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Offerbound couldn't find a header row with Company, Role and Status.",
      );
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
    });

    it("says a file the server finds too large is over 2 MB, and a repeated file was already imported", async () => {
      let answer: MockHandler = () => apiError(413, "too_large", "Too large.");
      const { user } = await toImport({
        "POST /api/v1/import/sheet/preview": (req) => answer(req),
      });
      await user.upload(
        screen.getByLabelText("Choose CSV file"),
        file("Applications.csv", "text/csv"),
      );
      expect(await screen.findByRole("alert")).toHaveTextContent("File is over 2 MB");

      answer = () => apiError(409, "duplicate_import", "Imported before.");
      await user.upload(
        screen.getByLabelText("Choose CSV file"),
        file("Applications.csv", "text/csv"),
      );
      expect(await screen.findByText("This file was already imported")).toBeVisible();
      expect(screen.queryByText("File is over 2 MB")).not.toBeInTheDocument();
    });

    it("says the preview expired only when the commit can't find it, and Skip still works", async () => {
      const { user } = await toImport({
        "POST /api/v1/import/sheet/commit": () => apiError(404, "not_found", "Not found."),
      });
      await user.upload(
        screen.getByLabelText("Choose CSV file"),
        file("Applications.csv", "text/csv"),
      );
      await user.click(await screen.findByRole("button", { name: "Import 101 rows" }));
      expect(await screen.findByText("This preview expired. Add the file again.")).toBeVisible();
      await user.click(screen.getByRole("button", { name: "Skip this step" }));
      expect(
        screen.getByRole("heading", { level: 2, name: "Write your search brief" }),
      ).toBeVisible();
    });

    it("shows the preview's own message when the file fails validation", async () => {
      const { user } = await toImport({
        "POST /api/v1/import/sheet/preview": () =>
          apiError(400, "validation_failed", "No Company, Role and Status columns were found."),
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
    // Heavy under jsdom (MUI re-renders on every step); see heavyIt.
    heavyIt(
      "saves through PUT /settings with the edited brief and the rest of the settings unchanged",
      async () => {
        const settings: Settings = {
          ...DEFAULT_SETTINGS,
          search: { ...DEFAULT_SETTINGS.search, brief: "Old brief", enabled: true },
        };
        const { api, user } = await setup({
          "GET /api/v1/settings": () => settings,
          "PUT /api/v1/settings": async (req) => (await req.clone().json()) as Settings,
          "POST /api/v1/onboarding/complete": () => ME,
        });
        await skipTo(user, 2);

        const field = await screen.findByRole("textbox", { name: "Search brief" });
        expect(field).toHaveValue("Old brief");
        setValue(field, "Senior roles, remote from Mexico.");
        expect(screen.getByText("33 of 12,000 characters")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Save and continue" }));

        await waitFor(() => expect(callsTo(api, "PUT", "/api/v1/settings")).toHaveLength(1));
        const put = callsTo(api, "PUT", "/api/v1/settings")[0];
        expect(put?.headers.get("X-Offerbound-Request")).toBe("1");
        expect(await put?.json()).toEqual({
          ...settings,
          search: { ...settings.search, brief: "Senior roles, remote from Mexico." },
        });
        // Saving the brief finishes setup: this is the last step.
        expect(await screen.findByRole("heading", { level: 1, name: "Today" })).toBeInTheDocument();
        expect(callsTo(api, "POST", "/api/v1/onboarding/complete")).toHaveLength(1);
      },
    );

    // Heavy under jsdom (MUI re-renders on every step); see heavyIt.
    heavyIt(
      "when finishing fails after a save, Continue is offered again with no Skip, and retrying finishes",
      async () => {
        let attempts = 0;
        const { api, user } = await setup({
          "PUT /api/v1/settings": async (req) => (await req.clone().json()) as Settings,
          "POST /api/v1/onboarding/complete": () =>
            (attempts += 1) === 1 ? apiError(500, "internal", "Boom.") : ME,
        });
        await skipTo(user, 2);
        setValue(await screen.findByRole("textbox", { name: "Search brief" }), "Remote roles");
        await user.click(screen.getByRole("button", { name: "Save and continue" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't finish setup.");

        expect(screen.getByRole("textbox", { name: "Search brief" })).toHaveValue("Remote roles");
        expect(screen.queryByRole("button", { name: "Skip this step" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Save and continue" })).not.toBeInTheDocument();

        // Editing again offers to save the change, and still no Skip.
        setValue(screen.getByRole("textbox", { name: "Search brief" }), "Remote roles in Mexico");
        expect(screen.getByRole("button", { name: "Save and continue" })).toBeEnabled();
        expect(screen.queryByRole("button", { name: "Skip this step" })).not.toBeInTheDocument();
        setValue(screen.getByRole("textbox", { name: "Search brief" }), "Remote roles");
        await user.click(screen.getByRole("button", { name: "Continue" }));
        expect(await screen.findByRole("heading", { level: 1, name: "Today" })).toBeInTheDocument();
        expect(callsTo(api, "POST", "/api/v1/onboarding/complete")).toHaveLength(2);
        expect(callsTo(api, "PUT", "/api/v1/settings")).toHaveLength(1);
      },
    );

    it("Skip this step finishes setup without saving anything", async () => {
      const { api, user } = await setup({ "POST /api/v1/onboarding/complete": () => ME });
      await skipTo(user, 3);
      expect(await screen.findByRole("heading", { level: 1, name: "Today" })).toBeInTheDocument();
      expect(callsTo(api, "POST", "/api/v1/onboarding/complete")).toHaveLength(1);
      expect(callsTo(api, "PUT", "/api/v1/settings")).toHaveLength(0);
    });

    it("starts with an empty field instead of the shipped example text", async () => {
      const { user } = await setup();
      await skipTo(user, 2);
      const field = await screen.findByRole("textbox", { name: "Search brief" });
      expect(field).toHaveValue("");
      expect(screen.getByRole("button", { name: "Save and continue" })).toBeDisabled();
    });

    it("blocks a brief over 12,000 characters", async () => {
      const { user } = await setup();
      await skipTo(user, 2);
      const field = await screen.findByRole("textbox", { name: "Search brief" });
      setValue(field, "a".repeat(12_001));
      expect(
        screen.getByText(/12,001 of 12,000 characters\. Shorten it to save\./),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Save and continue" })).toBeDisabled();
    });

    it("shows a failed save and keeps the text", async () => {
      const { user } = await setup({
        "PUT /api/v1/settings": () =>
          apiError(502, "upstream_error", "The database didn't answer."),
      });
      await skipTo(user, 2);
      setValue(await screen.findByRole("textbox", { name: "Search brief" }), "Remote roles");
      await user.click(screen.getByRole("button", { name: "Save and continue" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't save your brief.");
      expect(screen.getByRole("textbox", { name: "Search brief" })).toHaveValue("Remote roles");
    });
  });

  describe("the Gmail step (step 1)", () => {
    // Heavy under jsdom (MUI re-renders on every step); see heavyIt.
    heavyIt(
      "Start syncing posts /gmail/start, shows first-sync progress, and Continue goes to the CV while the sync keeps running",
      async () => {
        let status = NOT_STARTED;
        const { api, user } = await setup({
          "GET /api/v1/gmail/status": () => status,
          "POST /api/v1/gmail/start": () => {
            status = RUNNING;
            return jsonResponse(status, 202);
          },
        });
        expect(screen.getByRole("list", { name: "What Offerbound reads" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Start syncing" }));

        expect(await screen.findByText(/120 of 400 checked\./)).toBeInTheDocument();
        expect(screen.getByRole("progressbar", { name: "First sync" })).toHaveAttribute(
          "aria-valuenow",
          "30",
        );
        const start = callsTo(api, "POST", "/api/v1/gmail/start")[0];
        expect(start?.headers.get("X-Offerbound-Request")).toBe("1");
        // Starting the sync does not end setup, even once the sync is done.
        expect(callsTo(api, "POST", "/api/v1/onboarding/complete")).toHaveLength(0);

        await user.click(screen.getByRole("button", { name: "Continue" }));
        expect(screen.getByRole("heading", { level: 2, name: "Upload your CV" })).toBeVisible();
        const steps = screen.getByLabelText("Setup steps");
        expect(
          within(steps).getByText("Start syncing Gmail").closest("[class*=MuiStepLabel-root]"),
        ).not.toHaveTextContent(/Optional|Skipped/);
        expect(callsTo(api, "POST", "/api/v1/onboarding/complete")).toHaveLength(0);
      },
    );

    it("does not finish setup when the first sync is done; the owner still goes on to the CV", async () => {
      const { api } = await setup({
        "GET /api/v1/gmail/status": () => makeSyncStatus({ started: true }),
        "POST /api/v1/onboarding/complete": () => ME,
      });
      await settle();
      expect(screen.getByRole("heading", { level: 2, name: "Upload your CV" })).toBeVisible();
      expect(callsTo(api, "POST", "/api/v1/onboarding/complete")).toHaveLength(0);
    });

    it("shows the progress of a sync that already started, with Continue, when the owner goes back", async () => {
      const { user } = await setup();
      await user.click(screen.getByRole("button", { name: "Back" }));
      expect(screen.getByRole("heading", { level: 2, name: "Start syncing Gmail" })).toBeVisible();
      expect(screen.getByText(/120 of 400 checked\./)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Start syncing" })).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Continue" }));
      expect(screen.getByRole("heading", { level: 2, name: "Upload your CV" })).toBeVisible();
    });

    it("offers Connect Gmail instead of Start syncing when Google stopped Gmail access", async () => {
      const { api } = await setup({
        "GET /api/v1/gmail/status": () =>
          makeSyncStatus({ connection: "missing_scope", started: false, lastSyncAt: null }),
      });
      expect(await screen.findByRole("link", { name: "Connect Gmail" })).toHaveAttribute(
        "href",
        "/api/v1/auth/google/start",
      );
      expect(screen.getByRole("button", { name: "Start syncing" })).toBeDisabled();
      expect(callsTo(api, "POST", "/api/v1/gmail/start")).toHaveLength(0);
    });

    it("says so when starting fails, and lets the owner try again", async () => {
      const { user } = await setup({
        "GET /api/v1/gmail/status": () => NOT_STARTED,
        "POST /api/v1/gmail/start": () => apiError(502, "upstream_error", "Google did not answer."),
      });
      await user.click(screen.getByRole("button", { name: "Start syncing" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't start syncing.");
      expect(screen.getByRole("button", { name: "Start syncing" })).toBeEnabled();
    });

    it("shows when the first sync stopped, and still lets the owner continue", async () => {
      await setup({
        "GET /api/v1/gmail/status": () =>
          makeSyncStatus({
            started: true,
            backfill: { state: "failed", listed: 400, processed: 120 },
          }),
      });
      const user = userEvent.setup({ delay: null });
      await user.click(await screen.findByRole("button", { name: "Back" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("The first sync stopped");
      expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
    });
  });

  describe("resuming", () => {
    const stored = (value: unknown) =>
      window.localStorage.setItem(
        ONBOARDING_STORAGE_KEY,
        typeof value === "string" ? value : JSON.stringify(value),
      );
    const record = () => window.localStorage.getItem(ONBOARDING_STORAGE_KEY);
    const heading = (name: string) => screen.getByRole("heading", { level: 2, name });
    const labelOf = (name: string) =>
      within(screen.getByLabelText("Setup steps"))
        .getByText(name)
        .closest("[class*=MuiStepLabel-root]");
    // MUI puts Mui-completed on the label text of a step that is completed.
    const isCompleted = (name: string) =>
      /Mui-completed/.test(within(screen.getByLabelText("Setup steps")).getByText(name).className);
    const withBrief = (brief: string): Settings => ({
      ...DEFAULT_SETTINGS,
      search: { ...DEFAULT_SETTINGS.search, brief },
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("opens on the first step that is neither completed nor skipped, with the earlier ones marked as before", async () => {
      stored({ completed: [1], skipped: [2] });
      const { user } = await setup();
      expect(heading("Write your search brief")).toBeVisible();
      expect(labelOf("Start syncing Gmail")).not.toHaveTextContent(/Optional|Skipped/);
      expect(labelOf("Upload your CV")).not.toHaveTextContent(/Optional|Skipped/);
      expect(labelOf("Import your spreadsheet")).toHaveTextContent("Skipped");
      expect(labelOf("Write your search brief")).toHaveTextContent("Optional");

      // The earlier steps are mounted, so Back works.
      await user.click(screen.getByRole("button", { name: "Back" }));
      expect(heading("Import your spreadsheet")).toBeVisible();
    });

    it("counts the sync as done once it started, and opens on the CV", async () => {
      await setup();
      expect(heading("Upload your CV")).toBeVisible();
      expect(labelOf("Start syncing Gmail")).not.toHaveTextContent(/Optional|Skipped/);
      expect(labelOf("Upload your CV")).toHaveTextContent("Optional");
    });

    it("opens on the first step when the sync has not started and nothing is kept", async () => {
      await setup({ "GET /api/v1/gmail/status": () => NOT_STARTED });
      expect(heading("Start syncing Gmail")).toBeVisible();
      expect(screen.getByRole("button", { name: "Start syncing" })).toBeEnabled();
    });

    it("counts the CV as done when the server has a profile, and the brief when it has an owner brief", async () => {
      await setup({
        "GET /api/v1/cv": () => PROFILE,
        "GET /api/v1/settings": () => withBrief("Remote senior roles"),
      });
      // The import has no server answer, so it is the first unfinished step after the sync.
      expect(heading("Import your spreadsheet")).toBeVisible();
      expect(labelOf("Upload your CV")).not.toHaveTextContent(/Optional|Skipped/);
      expect(labelOf("Write your search brief")).not.toHaveTextContent(/Optional|Skipped/);
      expect(labelOf("Import your spreadsheet")).toHaveTextContent("Optional");
    });

    it("does not count a blank brief or the repo-shipped one as done", async () => {
      await setup({ "GET /api/v1/settings": () => withBrief("   \n ") });
      expect(labelOf("Write your search brief")).toHaveTextContent("Optional");
    });

    it("lets the server win over the record: a skipped CV that exists on the server shows as done", async () => {
      stored({ completed: [], skipped: [1] });
      await setup({ "GET /api/v1/cv": () => PROFILE });
      expect(heading("Import your spreadsheet")).toBeVisible();
      expect(labelOf("Upload your CV")).not.toHaveTextContent(/Optional|Skipped/);
    });

    it("takes the sync step from the sync status alone: a record claiming it done does not skip it", async () => {
      stored({ completed: [0, 1, 2, 3], skipped: [] });
      await setup({ "GET /api/v1/gmail/status": () => NOT_STARTED });
      expect(heading("Start syncing Gmail")).toBeVisible();
      expect(screen.getByRole("button", { name: "Start syncing" })).toBeEnabled();
      expect(isCompleted("Start syncing Gmail")).toBe(false);
      // The rest of the record still stands.
      expect(labelOf("Upload your CV")).not.toHaveTextContent(/Optional|Skipped/);
    });

    it("does not let a record skip the sync step when the sync status failed to load", async () => {
      stored({ completed: [0, 1], skipped: [2] });
      await setup({ "GET /api/v1/gmail/status": () => apiError(500, "internal", "Boom.") });
      expect(heading("Start syncing Gmail")).toBeVisible();
      expect(screen.queryByRole("button", { name: "Skip this step" })).not.toBeInTheDocument();
    });

    it("ignores a record that skips the sync step", async () => {
      stored({ completed: [], skipped: [0] });
      await setup({ "GET /api/v1/gmail/status": () => NOT_STARTED });
      expect(heading("Start syncing Gmail")).toBeVisible();
      expect(labelOf("Start syncing Gmail")).not.toHaveTextContent("Skipped");
    });

    it("treats a step listed as both completed and skipped as completed", async () => {
      stored({ completed: [1], skipped: [1, 2] });
      await setup();
      expect(heading("Write your search brief")).toBeVisible();
      expect(labelOf("Upload your CV")).not.toHaveTextContent(/Optional|Skipped/);
      expect(isCompleted("Upload your CV")).toBe(true);
      expect(labelOf("Import your spreadsheet")).toHaveTextContent("Skipped");
      expect(isCompleted("Import your spreadsheet")).toBe(false);
    });

    it("never reads the record of the previous step order (v1)", async () => {
      window.localStorage.setItem(
        "offerbound.onboarding.v1",
        JSON.stringify({ completed: [0, 1, 2], skipped: [] }),
      );
      await setup();
      expect(heading("Upload your CV")).toBeVisible();
      expect(labelOf("Import your spreadsheet")).toHaveTextContent("Optional");
    });

    it("ignores and drops a record that is not valid, and opens on the first unfinished step", async () => {
      for (const garbage of [
        "not json{",
        '"text"',
        "null",
        { completed: "0", skipped: [] },
        { completed: [0] },
        { completed: [9], skipped: [] },
        { completed: [-1], skipped: [1.5] },
      ]) {
        window.localStorage.clear();
        stored(garbage);
        const { unmount } = await setup({ "GET /api/v1/gmail/status": () => NOT_STARTED });
        expect(heading("Start syncing Gmail")).toBeVisible();
        expect(record()).toBeNull();
        unmount();
      }
    });

    it("works when storage throws on every read and write", async () => {
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("blocked");
      });
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("blocked");
      });
      vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
        throw new Error("blocked");
      });
      const { user } = await setup();
      expect(heading("Upload your CV")).toBeVisible();
      await user.click(screen.getByRole("button", { name: "Skip this step" }));
      expect(heading("Import your spreadsheet")).toBeVisible();
    });

    it("shows a placeholder, not step 1, until the CV, settings and sync answers are in", async () => {
      const cv = deferred<Response>();
      await setup({ "GET /api/v1/cv": () => cv.promise }, { settled: false });
      expect(screen.getByLabelText("Loading your setup")).toBeInTheDocument();
      await settle();
      expect(screen.queryByRole("heading", { level: 2 })).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Setup steps")).not.toBeInTheDocument();

      cv.resolve(jsonResponse(PROFILE));
      expect(
        await screen.findByRole("heading", { level: 2, name: "Import your spreadsheet" }),
      ).toBeVisible();
      expect(screen.queryByLabelText("Loading your setup")).not.toBeInTheDocument();
    });

    it("opens without the failed answer instead of waiting for it", async () => {
      await setup({ "GET /api/v1/cv": () => apiError(500, "internal", "Boom.") });
      expect(heading("Upload your CV")).toBeVisible();
    });

    it("writes the record when a step is completed or skipped", async () => {
      const { user } = await setup({ "POST /api/v1/cv": () => jsonResponse(PROFILE, 201) });
      expect(record()).toBeNull();

      await user.upload(screen.getByLabelText("Choose CV file"), file("cv.pdf", "application/pdf"));
      await user.click(await screen.findByRole("button", { name: "Continue" }));
      // The sync was already started when the page opened: the server tells that, not the record.
      expect(JSON.parse(record() ?? "null")).toEqual({ completed: [1], skipped: [] });

      await user.click(screen.getByRole("button", { name: "Skip this step" }));
      expect(JSON.parse(record() ?? "null")).toEqual({ completed: [1], skipped: [2] });
    });

    it("writes the sync step as completed when Continue is pressed after starting it here", async () => {
      let status = NOT_STARTED;
      const { user } = await setup({
        "GET /api/v1/gmail/status": () => status,
        "POST /api/v1/gmail/start": () => {
          status = RUNNING;
          return jsonResponse(status, 202);
        },
      });
      await user.click(screen.getByRole("button", { name: "Start syncing" }));
      await user.click(await screen.findByRole("button", { name: "Continue" }));
      expect(JSON.parse(record() ?? "null")).toEqual({ completed: [0], skipped: [] });
    });

    it("clears the record when onboarding completes", async () => {
      stored({ completed: [1], skipped: [2] });
      const { api, user } = await setup({ "POST /api/v1/onboarding/complete": () => ME });
      expect(heading("Write your search brief")).toBeVisible();
      expect(record()).not.toBeNull();
      await user.click(screen.getByRole("button", { name: "Skip this step" }));
      expect(await screen.findByRole("heading", { level: 1, name: "Today" })).toBeInTheDocument();
      expect(callsTo(api, "POST", "/api/v1/onboarding/complete")).toHaveLength(1);
      expect(record()).toBeNull();
    });

    it("keeps the record when finishing fails", async () => {
      stored({ completed: [1], skipped: [2] });
      const { user } = await setup({
        "POST /api/v1/onboarding/complete": () => apiError(500, "internal", "Boom."),
      });
      await user.click(screen.getByRole("button", { name: "Skip this step" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't finish setup.");
      expect(record()).not.toBeNull();
    });

    it("does not override a step the owner chose when the sync status changes later", async () => {
      let status = RUNNING;
      const { user, queryClient } = await setup({ "GET /api/v1/gmail/status": () => status });
      expect(heading("Upload your CV")).toBeVisible();
      await user.click(screen.getByRole("button", { name: "Skip this step" }));
      expect(heading("Import your spreadsheet")).toBeVisible();

      status = makeSyncStatus({ started: true });
      await queryClient.invalidateQueries({ queryKey: queryKeys.syncStatus });
      await settle();
      expect(heading("Import your spreadsheet")).toBeVisible();
    });
  });
});
