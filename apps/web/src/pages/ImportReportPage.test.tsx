import type { ReportPreview } from "@offerbound/contracts";
import { MAX_REPORT_CHARS } from "@offerbound/contracts";
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiError, mockApi, type MockApi, type MockHandler } from "../../test/mock-api";
import { renderWithProviders } from "../../test/render";
import { ImportReportPage } from "./ImportReportPage";

vi.setConfig({ testTimeout: 15_000 });

const lead = (company: string, title: string) => ({
  company,
  companyDomain: null,
  title,
  jobUrl: null,
  locationText: "Remote, Mexico",
  country: "MX",
  workMode: "remote" as const,
  compensationText: null,
  postedAt: null,
  seniority: "senior" as const,
});

const PREVIEW: ReportPreview = {
  previewId: "preview-1",
  expiresAt: "2026-10-30T13:00:00Z",
  rows: [
    {
      rowId: "r1",
      annotation: "new",
      defaultKeep: true,
      lead: lead("Tidewater Labs", "Platform Engineer"),
    },
    {
      rowId: "r2",
      annotation: "new",
      defaultKeep: true,
      lead: lead("Kittiwake Systems", "Frontend Engineer"),
    },
    {
      rowId: "r3",
      annotation: "duplicate",
      defaultKeep: false,
      lead: lead("Brightline Learning", "Full-stack Engineer"),
    },
    {
      rowId: "r4",
      annotation: "company_already_seen",
      defaultKeep: false,
      lead: lead("Halyard Health", "Tech Lead"),
    },
    {
      rowId: "r5",
      annotation: "excluded_seniority",
      defaultKeep: false,
      lead: lead("Sable Security", "Junior Developer"),
    },
  ],
  droppedRows: 0,
};

const LIST = "Halyard Health\n  Halyard\nSable Security\n";

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname}</p>;
}

function setup(routes: Record<string, MockHandler> = {}) {
  const api: MockApi = mockApi({
    "POST /api/v1/leads/import/preview": () => PREVIEW,
    "POST /api/v1/leads/import/commit": () =>
      Response.json({ batchId: "batch-1" }, { status: 202 }),
    "GET /api/v1/companies/exclusion-list": () =>
      new Response(LIST, { headers: { "Content-Type": "text/plain; charset=utf-8" } }),
    ...routes,
  });
  const rendered = renderWithProviders(
    <Routes>
      <Route path="/leads/import" element={<ImportReportPage />} />
      <Route path="/leads" element={<Where />} />
    </Routes>,
    { route: "/leads/import" },
  );
  return { api, ...rendered, user: userEvent.setup({ delay: null }) };
}

const paste = (text = "Some report") =>
  fireEvent.change(screen.getByLabelText("Report"), { target: { value: text } });

async function readReport(user: ReturnType<typeof userEvent.setup>) {
  paste();
  await user.click(screen.getByRole("button", { name: "Read the report" }));
  return screen.findByRole("table", { name: "Roles in the report" });
}

const keepBox = (name: string) =>
  screen.getByRole("checkbox", { name: new RegExp(`^Keep ${name}`) });

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("Paste a report", () => {
  it("says the roles become leads and points to the spreadsheet import", async () => {
    setup();
    expect(
      await screen.findByRole("heading", { level: 1, name: "Paste a report" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Import your applications spreadsheet instead" }),
    ).toHaveAttribute("href", "/settings/import");
  });

  it("shows each row's annotation and starts the checkboxes at defaultKeep", async () => {
    const { api, user } = setup();
    const table = await readReport(user);

    const call = api.calls.find((c) => c.url.endsWith("/leads/import/preview"));
    expect(await call?.json()).toEqual({ text: "Some report" });

    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(5);
    expect(within(rows[0]!).getByText("New")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("Already tracked")).toBeInTheDocument();
    expect(within(rows[3]!).getByText("Suppressed: company already seen")).toBeInTheDocument();
    expect(within(rows[4]!).getByText("Suppressed: seniority excluded")).toBeInTheDocument();

    expect(keepBox("Tidewater")).toBeChecked();
    expect(keepBox("Kittiwake")).toBeChecked();
    expect(keepBox("Brightline")).not.toBeChecked();
    expect(keepBox("Halyard")).not.toBeChecked();
    expect(keepBox("Sable")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Import 2 leads" })).toBeEnabled();
  });

  it("tells the owner when rows beyond the limit weren't read", async () => {
    const { user } = setup({
      "POST /api/v1/leads/import/preview": () => ({ ...PREVIEW, droppedRows: 37 }),
    });
    await readReport(user);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The report has more than 200 roles. 37 roles after the first 200 weren't read.",
    );
  });

  it("blocks a report over the limit and counts the characters", () => {
    const { api } = setup();
    paste("x".repeat(MAX_REPORT_CHARS));
    expect(screen.getByText("50,000 of 50,000 characters")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Read the report" })).toBeEnabled();

    paste("x".repeat(MAX_REPORT_CHARS + 1));
    expect(screen.getByText("50,001 of 50,000 characters")).toBeInTheDocument();
    expect(screen.getByText(/Over the limit by 1 characters/)).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Read the report" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(api.calls.filter((c) => c.url.endsWith("/preview"))).toHaveLength(0);
  });

  it("shows a message when the API says the report is too large", async () => {
    const { user } = setup({
      "POST /api/v1/leads/import/preview": () => apiError(413, "too_large", "Too large."),
    });
    paste();
    await user.click(screen.getByRole("button", { name: "Read the report" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That report is over 50,000 characters. Paste a shorter one.",
    );
  });

  it("posts only the checked rows, then offers the way back to Leads", async () => {
    const { api, user } = setup();
    await readReport(user);
    await user.click(keepBox("Tidewater")); // uncheck
    await user.click(keepBox("Halyard")); // check
    await user.click(screen.getByRole("button", { name: "Import 2 leads" }));

    const call = api.calls.find((c) => c.url.endsWith("/leads/import/commit"));
    expect(await call?.json()).toEqual({ previewId: "preview-1", keepRowIds: ["r2", "r4"] });
    expect(
      await screen.findByText(
        "Imported 2 leads: 1 in New, 1 in Suppressed. New leads appear once their links are checked.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Import \d/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Go to Leads" }));
    expect(await screen.findByTestId("where")).toHaveTextContent("/leads");
  });

  it("can't keep a row Offerbound already tracks, and leaves it out of the count", async () => {
    const { api, user } = setup();
    await readReport(user);
    const duplicate = keepBox("Brightline");
    expect(duplicate).toBeDisabled();
    expect(duplicate).not.toBeChecked();
    // The other already-seen rows stay checkable.
    expect(keepBox("Halyard")).toBeEnabled();
    expect(keepBox("Sable")).toBeEnabled();

    // Select all takes every row except the tracked one.
    await user.click(screen.getByRole("checkbox", { name: "Keep every row" }));
    expect(duplicate).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Import 4 leads" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Import 4 leads" }));
    const call = api.calls.find((c) => c.url.endsWith("/leads/import/commit"));
    expect(await call?.json()).toEqual({
      previewId: "preview-1",
      keepRowIds: ["r1", "r2", "r4", "r5"],
    });
  });

  it("says which kept rows go to Suppressed, before and after the import", async () => {
    const { user } = setup();
    await readReport(user);
    expect(
      screen.getByText(/Rows already tracked can't be added\..*go to Suppressed, not New\./),
    ).toBeInTheDocument();
    await user.click(keepBox("Halyard"));
    await user.click(keepBox("Sable"));
    await user.click(screen.getByRole("button", { name: "Import 4 leads" }));
    expect(
      await screen.findByText(
        "Imported 4 leads: 2 in New, 2 in Suppressed. New leads appear once their links are checked.",
      ),
    ).toBeInTheDocument();
  });

  it("doesn't promise New when only suppressed rows were kept", async () => {
    const { user } = setup();
    await readReport(user);
    await user.click(keepBox("Tidewater"));
    await user.click(keepBox("Kittiwake"));
    await user.click(keepBox("Halyard"));
    await user.click(screen.getByRole("button", { name: "Import 1 lead" }));
    expect(
      await screen.findByText("Imported 1 lead: 0 in New, 1 in Suppressed."),
    ).toBeInTheDocument();
  });

  it("offers to import another report after a success", async () => {
    const { user } = setup();
    await readReport(user);
    await user.click(screen.getByRole("button", { name: "Import 2 leads" }));
    await user.click(await screen.findByRole("button", { name: "Import another report" }));
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText(/^Imported/)).not.toBeInTheDocument();
    const box = screen.getByLabelText("Report");
    expect(box).toHaveValue("");
    expect(box).toBeEnabled();
  });

  it("disables the import when nothing is kept", async () => {
    const { user } = setup();
    await readReport(user);
    await user.click(screen.getByRole("checkbox", { name: "Keep every row" })); // 2 of 4: select all
    await user.click(screen.getByRole("checkbox", { name: "Keep every row" })); // none
    expect(screen.getByRole("button", { name: "Import 0 leads" })).toBeDisabled();
  });

  it("asks for the report again when the preview expired", async () => {
    const { user } = setup({
      "POST /api/v1/leads/import/commit": () => apiError(404, "not_found", "Preview not found."),
    });
    await readReport(user);
    await user.click(screen.getByRole("button", { name: "Import 2 leads" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This preview expired or was already used. Paste the report again.",
    );
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Import \d/ })).not.toBeInTheDocument();
  });
});

describe("Copy companies already seen", () => {
  it("fetches the list as text and writes it to the clipboard", async () => {
    const { api, user } = setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    await user.click(screen.getByRole("button", { name: "Copy companies already seen" }));
    expect(await screen.findByText("Copied to the clipboard")).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(LIST);
    const call = api.calls.find((c) => c.url.endsWith("/companies/exclusion-list"));
    expect(call?.headers.get("Accept")).toBe("text/plain");
    expect(screen.queryByLabelText("Companies already seen")).not.toBeInTheDocument();
  });

  it("selects the text when the clipboard refuses", async () => {
    const { user } = setup();
    const writeText = vi.fn(() => Promise.reject(new Error("denied")));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    await user.click(screen.getByRole("button", { name: "Copy companies already seen" }));
    const box = await screen.findByLabelText<HTMLTextAreaElement>("Companies already seen");
    expect(box.value).toBe(LIST);
    expect(box).toHaveFocus();
    expect(box.selectionStart).toBe(0);
    expect(box.selectionEnd).toBe(LIST.length);
    expect(screen.getByText(/press Ctrl\+C/)).toBeInTheDocument();
    expect(screen.queryByText("Copied to the clipboard")).not.toBeInTheDocument();
  });

  it("selects the text when there is no clipboard", async () => {
    const { user } = setup();
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    await user.click(screen.getByRole("button", { name: "Copy companies already seen" }));
    expect(await screen.findByLabelText("Companies already seen")).toHaveValue(LIST);
  });

  it("says so when there are no companies yet", async () => {
    const { user } = setup({
      "GET /api/v1/companies/exclusion-list": () =>
        new Response("", { headers: { "Content-Type": "text/plain" } }),
    });
    await user.click(screen.getByRole("button", { name: "Copy companies already seen" }));
    expect(await screen.findByText(/No companies yet/)).toBeInTheDocument();
  });

  it("reports a failure to load the list", async () => {
    const { user } = setup({
      "GET /api/v1/companies/exclusion-list": () => apiError(500, "internal_error", "Boom."),
    });
    await user.click(screen.getByRole("button", { name: "Copy companies already seen" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't load the list. Try again.",
    );
  });
});
