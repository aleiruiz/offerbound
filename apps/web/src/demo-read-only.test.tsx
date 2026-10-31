import type { InterviewWithApplication, Page, ReviewItem } from "@offerbound/contracts";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import {
  DEMO_ME,
  OWNER_ME,
  makeApplication,
  makeApplicationDetail,
  makeCvProfile,
  makeInterview,
  makeNavCounts,
  makeReviewItem,
  makeSettings,
  makeSyncStatus,
  makeToday,
} from "../test/factories";
import { apiError, mockApi, type MockHandler } from "../test/mock-api";
import { renderWithProviders } from "../test/render";
import { queryKeys } from "./api/hooks";
import { DEMO_READ_ONLY_MESSAGE, DEMO_REASON, type DemoReason } from "./lib/demo";
import { ApplicationDetailPage } from "./pages/ApplicationDetailPage";
import { ApplicationsPage } from "./pages/ApplicationsPage";
import { ImportReportPage } from "./pages/ImportReportPage";
import { InterviewsPage } from "./pages/InterviewsPage";
import { LeadsPage } from "./pages/LeadsPage";
import { ReviewPage } from "./pages/ReviewPage";
import { Automation } from "./pages/settings/Automation";
import { Cv } from "./pages/settings/Cv";
import { Data } from "./pages/settings/Data";
import { Import } from "./pages/settings/Import";
import { Search } from "./pages/settings/Search";
import { Targets } from "./pages/settings/Targets";
import { Timers } from "./pages/settings/Timers";
import { Gmail } from "./pages/settings/Gmail";
import { SyncStatus } from "./shell/SyncStatus";
import { ReconnectBanner } from "./shell/ReconnectBanner";
import { UndoSnackbar } from "./components/UndoSnackbar";
import { setDemoReadOnlyHandler, apiFetch } from "./api/client";
import { App } from "./App";

// AC-16.6: in the demo the free-text controls are disabled, each with a tooltip saying why;
// status changes, shortlist, dismiss, undo and review actions keep working.

vi.setConfig({ testTimeout: 20_000 });

const page = <T,>(items: T[]): Page<T> => ({ items, nextCursor: null });

const KESTREL_APP = makeApplication({
  id: "a1",
  company: { id: "c1", name: "Kestrel Pay" },
  title: "Senior Frontend Engineer",
  status: "interviewing",
});
const KESTREL_INTERVIEW: InterviewWithApplication = makeInterview({
  id: "i1",
  applicationId: "a1",
  application: KESTREL_APP,
  startsAt: "2099-10-30T16:00:00Z",
  endsAt: "2099-10-30T17:00:00Z",
});

const COMMON: Record<string, MockHandler> = {
  "GET /api/v1/today": () => makeToday(),
  "GET /api/v1/nav-counts": () => makeNavCounts(),
  "GET /api/v1/settings": () => makeSettings(),
  "GET /api/v1/search/runs": () => [],
  "GET /api/v1/cv": () => makeCvProfile(),
  "GET /api/v1/applications": () => page([KESTREL_APP]),
  "GET /api/v1/applications/a1": () =>
    makeApplicationDetail({ id: "a1", version: 2, notes: "Ask about on-call.", interviews: [] }),
  "GET /api/v1/interviews": () => page([KESTREL_INTERVIEW]),
  "GET /api/v1/leads": () => page([]),
  "GET /api/v1/gmail/status": () => makeSyncStatus({ connection: "active" }),
};

function show(ui: React.ReactElement, { demo = true, route = "/" } = {}) {
  mockApi(COMMON);
  return renderWithProviders(
    <>
      {ui}
      <UndoSnackbar />
    </>,
    { me: demo ? DEMO_ME : OWNER_ME, route },
  );
}

/** The wrapper a demo-locked control hangs its tooltip on. */
const reasonFor = (reason: DemoReason) => screen.getByLabelText(DEMO_REASON[reason]);

describe("the public demo's read-only controls", () => {
  it("free-text controls are disabled with a tooltip explaining why", async () => {
    const user = userEvent.setup({ delay: null });
    show(<ApplicationsPage />, { route: "/applications" });
    const add = await screen.findByRole("button", { name: "Add application" });
    expect(add).toBeDisabled();
    await user.hover(reasonFor("add"));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(DEMO_REASON.add);
  });

  describe("Applications", () => {
    it("Add application is disabled", async () => {
      show(<ApplicationsPage />, { route: "/applications" });
      expect(await screen.findByRole("button", { name: "Add application" })).toBeDisabled();
      reasonFor("add");
    });

    it("is enabled for the owner", async () => {
      show(<ApplicationsPage />, { route: "/applications", demo: false });
      expect(await screen.findByRole("button", { name: "Add application" })).toBeEnabled();
    });
  });

  describe("an application", () => {
    const open = () =>
      show(
        <Routes>
          <Route path="/applications/:id" element={<ApplicationDetailPage />} />
        </Routes>,
        { route: "/applications/a1" },
      );

    it("Edit details and the notes field are disabled, and the status still changes", async () => {
      open();
      expect(await screen.findByRole("button", { name: "Edit details" })).toBeDisabled();
      expect(screen.getByRole("textbox", { name: "Notes" })).toBeDisabled();
      expect(screen.getByLabelText(DEMO_REASON.edit)).toBeInTheDocument();
      expect(screen.getByLabelText(DEMO_REASON.notes)).toBeInTheDocument();
      // Status changes work in the demo (AC-16.6).
      expect(screen.getByRole("combobox", { name: "Status" })).not.toHaveAttribute(
        "aria-disabled",
        "true",
      );
    });

    it("Merge into… and Withdraw keep working: neither carries free text", async () => {
      const user = userEvent.setup({ delay: null });
      open();
      await user.click(await screen.findByRole("button", { name: "More actions" }));
      const menu = await screen.findByRole("menu");
      for (const name of ["Merge into…", "Withdraw"]) {
        expect(within(menu).getByRole("menuitem", { name })).not.toHaveAttribute(
          "aria-disabled",
          "true",
        );
      }
    });

    it("never saves notes by itself", async () => {
      const api = mockApi({
        ...COMMON,
        "PATCH /api/v1/applications/a1": () => {
          throw new Error("a demo visitor must not send notes");
        },
      });
      renderWithProviders(
        <Routes>
          <Route path="/applications/:id" element={<ApplicationDetailPage />} />
        </Routes>,
        { me: DEMO_ME, route: "/applications/a1" },
      );
      await screen.findByRole("textbox", { name: "Notes" });
      expect(api.calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
    });
  });

  describe("Interviews", () => {
    it("Add interview and Prep notes are disabled", async () => {
      show(<InterviewsPage />, { route: "/interviews" });
      expect(await screen.findByRole("button", { name: "Add interview" })).toBeDisabled();
      expect(await screen.findByRole("button", { name: "Prep notes" })).toBeDisabled();
      expect(screen.getByLabelText(DEMO_REASON.add)).toBeInTheDocument();
      expect(screen.getByLabelText(DEMO_REASON.notes)).toBeInTheDocument();
    });

    it("Prep notes sits in the row's menu on a phone, disabled", async () => {
      const user = userEvent.setup({ delay: null });
      mockApi(COMMON);
      renderWithProviders(<InterviewsPage />, { me: DEMO_ME, route: "/interviews", width: 390 });
      await user.click(await screen.findByRole("button", { name: "More actions" }));
      expect(await screen.findByRole("menuitem", { name: "Prep notes" })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
    });
  });

  describe("Leads and reports", () => {
    it("Paste a report is disabled on Leads", async () => {
      show(<LeadsPage />, { route: "/leads" });
      const button = await screen.findByRole("button", { name: "Paste a report" });
      expect(button).toBeDisabled();
      expect(screen.queryByRole("link", { name: "Paste a report" })).not.toBeInTheDocument();
      reasonFor("import");
    });

    it("Paste a report stays a link for the owner", async () => {
      show(<LeadsPage />, { route: "/leads", demo: false });
      expect(await screen.findByRole("link", { name: "Paste a report" })).toBeInTheDocument();
    });

    it("the report page itself cannot be written to", () => {
      show(<ImportReportPage />, { route: "/leads/import" });
      expect(screen.getByRole("textbox", { name: "Report" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Read the report" })).toBeDisabled();
      expect(screen.getAllByLabelText(DEMO_REASON.import)).toHaveLength(2);
    });
  });

  describe("Review", () => {
    const duplicate: ReviewItem = makeReviewItem({
      id: "r-dup",
      kind: "possible_duplicate_company",
      message: null,
      confidence: null,
      candidates: [],
      proposal: {
        description: "Is Fjordline the same company as Fjordline Travel?",
        operations: [],
      },
    });
    const low: ReviewItem = makeReviewItem({
      id: "r-low",
      kind: "low_confidence",
      message: null,
      confidence: 0.6,
      candidates: [],
      proposal: { description: "Is this a rejection from Quarry AI?", operations: [] },
    });
    const openReview = () => {
      mockApi({ ...COMMON, "GET /api/v1/review-items": () => page([duplicate, low]) });
      return renderWithProviders(
        <Routes>
          <Route path="/review" element={<ReviewPage />} />
        </Routes>,
        { me: DEMO_ME, route: "/review" },
      );
    };

    it("Edit and apply is disabled; every other review action works", async () => {
      openReview();
      expect(await screen.findByRole("button", { name: "Edit and apply" })).toBeDisabled();
      reasonFor("edit");
      expect(screen.getByRole("button", { name: "Merge companies" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Keep separate" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Same group, different companies" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Apply change" })).toBeEnabled();
      expect(screen.getAllByRole("button", { name: "Dismiss" })[0]).toBeEnabled();
    });

    it("Edit and apply is enabled for the owner", async () => {
      mockApi({ ...COMMON, "GET /api/v1/review-items": () => page([low]) });
      renderWithProviders(
        <Routes>
          <Route path="/review" element={<ReviewPage />} />
        </Routes>,
        { me: OWNER_ME, route: "/review" },
      );
      expect(await screen.findByRole("button", { name: "Edit and apply" })).toBeEnabled();
    });
  });

  describe("Settings", () => {
    it.each([
      ["Job search", Search],
      ["Targets", Targets],
      ["Timers", Timers],
      ["Automation", Automation],
    ] as const)("%s: Save changes is disabled", async (_name, Section) => {
      show(<Section />);
      expect(await screen.findByRole("button", { name: "Save changes" })).toBeDisabled();
      reasonFor("settings");
    });

    it("Job search: the brief is disabled", async () => {
      show(<Search />);
      expect(await screen.findByRole("textbox", { name: "Search brief" })).toBeDisabled();
      expect(screen.getByLabelText(DEMO_REASON.text)).toBeInTheDocument();
    });

    it("Job search: Run search now still works", async () => {
      show(<Search />);
      expect(await screen.findByRole("button", { name: "Run search now" })).toBeEnabled();
    });

    it("CV: choosing a file is disabled, re-ranking is not", async () => {
      show(<Cv />);
      const section = await screen.findByRole("region", { name: "CV" });
      await within(section).findByRole("button", { name: "Re-rank new leads" });
      expect(within(section).getByLabelText("Replace CV")).toBeDisabled();
      expect(within(section).getByLabelText(DEMO_REASON.upload)).toBeInTheDocument();
      expect(within(section).getByRole("button", { name: "Re-rank new leads" })).toBeEnabled();
    });

    it("Import: the CSV chooser and Paste a report are disabled", () => {
      show(<Import />);
      expect(screen.getByLabelText("Choose CSV file")).toBeDisabled();
      expect(screen.getByRole("button", { name: "Paste a report" })).toBeDisabled();
      expect(screen.queryByRole("link", { name: "Paste a report" })).not.toBeInTheDocument();
      expect(screen.getAllByLabelText(DEMO_REASON.import).length).toBeGreaterThanOrEqual(2);
    });

    it("Data: the confirmation field and the delete button are disabled", () => {
      show(<Data />);
      expect(screen.getByRole("textbox", { name: "Type DELETE to confirm" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Delete stored email content" })).toBeDisabled();
      expect(screen.getAllByLabelText(DEMO_REASON.delete).length).toBeGreaterThanOrEqual(1);
    });

    it("for the owner, none of these is locked", () => {
      show(<Data />, { demo: false });
      expect(screen.getByRole("textbox", { name: "Type DELETE to confirm" })).toBeEnabled();
      expect(screen.queryByLabelText(DEMO_REASON.delete)).not.toBeInTheDocument();
    });
  });
});

describe("Gmail and the CV profile in the demo", () => {
  const status = (connection: "active" | "needs_reauth" | "not_connected") => ({
    ...COMMON,
    "GET /api/v1/gmail/status": () => makeSyncStatus({ connection }),
  });

  it("Settings, Gmail: Sync now and Disconnect Gmail are disabled with a tooltip", async () => {
    mockApi(status("active"));
    renderWithProviders(<Gmail />, { me: DEMO_ME });
    expect(await screen.findByRole("button", { name: "Sync now" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Disconnect Gmail" })).toBeDisabled();
    expect(screen.getAllByLabelText(DEMO_REASON.gmail)).toHaveLength(2);
  });

  it("Settings, Gmail: Connect Gmail is a disabled button, not a link to the sign-in route", async () => {
    mockApi(status("not_connected"));
    renderWithProviders(<Gmail />, { me: DEMO_ME });
    expect(await screen.findByRole("button", { name: "Connect Gmail" })).toBeDisabled();
    expect(screen.queryByRole("link", { name: "Connect Gmail" })).not.toBeInTheDocument();
  });

  it("Settings, Gmail: unchanged for the owner", async () => {
    mockApi(status("active"));
    renderWithProviders(<Gmail />, { me: OWNER_ME });
    expect(await screen.findByRole("button", { name: "Sync now" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Disconnect Gmail" })).toBeEnabled();
  });

  it.each([1280, 700, 390])("the sync status's Sync now is disabled at %ipx", async (width) => {
    mockApi(status("active"));
    renderWithProviders(
      <SyncStatus layout={width >= 1000 ? "footer" : width >= 600 ? "rail" : "bar"} />,
      {
        me: DEMO_ME,
        width,
      },
    );
    expect(await screen.findByRole("button", { name: "Sync now" })).toBeDisabled();
  });

  it("CV: Retry profile is disabled", async () => {
    mockApi({ ...COMMON, "GET /api/v1/cv": () => null });
    const { queryClient } = renderWithProviders(<Cv />, { me: DEMO_ME });
    await screen.findByRole("region", { name: "CV" });
    act(() => {
      queryClient.setQueryData(queryKeys.cvProfileFailed, true);
    });
    expect(await screen.findByRole("button", { name: "Retry profile" })).toBeDisabled();
    expect(screen.getByLabelText(DEMO_REASON.profile)).toBeInTheDocument();
  });

  it("the reconnect banner's button is disabled", async () => {
    mockApi(status("needs_reauth"));
    renderWithProviders(<ReconnectBanner />, { me: DEMO_ME });
    expect(await screen.findByRole("button", { name: "Reconnect Gmail" })).toBeDisabled();
    expect(screen.queryByRole("link", { name: "Reconnect Gmail" })).not.toBeInTheDocument();
  });
});

describe("a 403 demo_read_only that slips through", () => {
  it("shows one plain message instead of the control's own failure message", async () => {
    // The page's own handler would say "Couldn't save the change. Try again."; the demo's reason wins.
    const user = userEvent.setup({ delay: null });
    mockApi({
      ...COMMON,
      "GET /api/v1/me": () => DEMO_ME,
      "GET /api/v1/gmail/status": () => ({
        connection: "not_connected",
        started: false,
        lastSyncAt: null,
        lastError: null,
        backfill: { state: "not_started", listed: 0, processed: 0 },
        queue: { discovered: 0, jobRelated: 0, extracted: 0, needsReview: 0, failed: 0 },
      }),
      "PATCH /api/v1/applications/a1": () =>
        apiError(403, "demo_read_only", "The demo is read-only for that."),
    });
    renderWithProviders(<App />, { route: "/applications/a1" });
    const status = await screen.findByRole("combobox", { name: "Status" });
    await user.click(status);
    await user.click(await screen.findByRole("option", { name: "Offer" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(DEMO_READ_ONLY_MESSAGE),
    );
    expect(screen.queryByText("Couldn't save the change. Try again.")).not.toBeInTheDocument();
  });

  it("is reported by the client to the registered handler, and only that code", async () => {
    const handler = vi.fn();
    setDemoReadOnlyHandler(handler);
    mockApi({
      "POST /api/v1/a": () => apiError(403, "demo_read_only", "no"),
      "POST /api/v1/b": () => apiError(403, "not_owner", "no"),
    });
    await expect(apiFetch("/a", { method: "POST" })).rejects.toMatchObject({
      code: "demo_read_only",
    });
    await expect(apiFetch("/b", { method: "POST" })).rejects.toMatchObject({ code: "not_owner" });
    // Told after the caller's own error handling, a tick later.
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(handler).toHaveBeenCalledTimes(1);
    setDemoReadOnlyHandler(null);
  });
});
