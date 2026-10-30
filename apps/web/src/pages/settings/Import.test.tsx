import type { ImportSummary, SheetPreview } from "@offerbound/contracts";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  apiError,
  jsonResponse,
  mockApi,
  type MockApi,
  type MockHandler,
} from "../../../test/mock-api";
import { renderWithProviders } from "../../../test/render";
import { Import } from "./Import";

vi.setConfig({ testTimeout: 15_000 });

const PREVIEW: SheetPreview = {
  previewId: "preview-1",
  expiresAt: "2026-10-30T13:00:00Z",
  totalRows: 10,
  mappings: [
    { sheetStatus: "applied", target: "application_applied", rows: 6 },
    { sheetStatus: "to_research", target: "lead_new", rows: 4 },
  ],
  errors: [],
  duplicatesInFile: [],
  existingMatches: 0,
};

const SUMMARY: ImportSummary = {
  applicationsCreated: 6,
  leadsCreated: 4,
  leadsDismissed: 0,
  skippedExisting: 0,
  skippedDuplicateRows: 0,
  errorRows: 0,
};

function setup(routes: Record<string, MockHandler> = {}) {
  const api: MockApi = mockApi({
    "POST /api/v1/import/sheet/preview": () => PREVIEW,
    ...routes,
  });
  const rendered = renderWithProviders(<Import />, { route: "/settings/import" });
  return { api, ...rendered, user: userEvent.setup({ applyAccept: false, delay: null }) };
}

const csv = () => new File(["Company,Role,Status"], "Applications.csv", { type: "text/csv" });

describe("Settings, Import", () => {
  it("is the onboarding import: choose a CSV, read the preview, import", async () => {
    const { api, user } = setup({
      "POST /api/v1/import/sheet/commit": () => jsonResponse(SUMMARY, 201),
    });
    expect(await screen.findByRole("heading", { level: 2, name: "Import" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "What to expect" })).toBeInTheDocument();
    // No onboarding steps here.
    expect(screen.queryByRole("button", { name: "Skip this step" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Import \d/ })).not.toBeInTheDocument();

    await user.upload(screen.getByLabelText("Choose CSV file"), csv());
    expect(await screen.findByText("Applications.csv")).toBeInTheDocument();
    expect(screen.getByText("Your notes are kept as they are.")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Import 10 rows" }));

    expect(await screen.findByText(/Imported 6 applications, 4 new leads/)).toBeInTheDocument();
    const commit = api.calls.find((c) => new URL(c.url).pathname.endsWith("/commit"));
    expect(await commit?.json()).toEqual({ previewId: "preview-1" });
    expect(screen.queryByRole("button", { name: /^Import \d/ })).not.toBeInTheDocument();
  });

  it("shows an import error under the file", async () => {
    const { user } = setup({
      "POST /api/v1/import/sheet/preview": () =>
        apiError(409, "duplicate_import", "Already imported."),
    });
    await user.upload(await screen.findByLabelText("Choose CSV file"), csv());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This file was already imported");
    // Nothing here is a step that can be skipped.
    expect(alert).not.toHaveTextContent("Skip this step");
  });

  it("links to the paste-a-report importer", async () => {
    setup();
    const section = await screen.findByRole("region", { name: "Paste a report" });
    expect(within(section).getByRole("link", { name: "Paste a report" })).toHaveAttribute(
      "href",
      "/leads/import",
    );
  });
});
