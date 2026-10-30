import type { ApplicationCreate, ApplicationSummary, Page } from "@offerbound/contracts";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, Route, Routes, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";
import {
  makeApplication,
  makeApplicationDetail,
  makeNavCounts,
  makeToday,
} from "../../test/factories";
import { apiError, mockApi, type MockApi, type MockHandler } from "../../test/mock-api";
import { renderWithProviders } from "../../test/render";
import { UndoSnackbar } from "../components/UndoSnackbar";
import { ApplicationsPage } from "./ApplicationsPage";

// MUI dialogs and menus render slowly under jsdom; a busy machine must not turn that into a failure.
vi.setConfig({ testTimeout: 15_000 });

const ME = {
  mode: "private",
  email: "owner@example.test",
  onboardingCompleted: true,
  timezone: "America/Monterrey",
};

const DAY_MS = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString();

const KESTREL = makeApplication({
  id: "a-kestrel",
  company: { id: "c-kestrel", name: "Kestrel Pay" },
  title: "Senior Frontend Engineer, Payments",
  status: "interviewing",
  appliedAt: "2026-10-15T17:00:00Z",
  lastCompanyActivityAt: daysAgo(2),
  followUpDue: false,
  nextInterviewAt: "2026-10-30T16:00:00Z",
});
const NORTHWIND = makeApplication({
  id: "a-northwind",
  company: { id: "c-northwind", name: "Northwind Robotics" },
  title: "Senior Full-stack Engineer",
  status: "applied",
  appliedAt: "2026-10-20T15:00:00Z",
  lastCompanyActivityAt: null,
  followUpDue: true,
});

const page = (
  items: ApplicationSummary[],
  nextCursor: string | null = null,
): Page<ApplicationSummary> => ({
  items,
  nextCursor,
});

type Routes = Record<string, MockHandler>;

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

function setup(
  routes: Routes = {},
  { route = "/applications", width }: { route?: string; width?: number } = {},
) {
  const api: MockApi = mockApi({
    "GET /api/v1/me": () => ME,
    "GET /api/v1/today": () => makeToday(),
    "GET /api/v1/nav-counts": () => makeNavCounts(),
    "GET /api/v1/applications": () => page([KESTREL, NORTHWIND]),
    ...routes,
  });
  const rendered = renderWithProviders(
    <>
      <Routes>
        <Route path="/applications" element={<ApplicationsPage />} />
        <Route path="/applications/:id" element={<p>Detail page</p>} />
      </Routes>
      <Where />
      <Link to="/applications">Applications nav</Link>
      <UndoSnackbar />
    </>,
    { route, width },
  );
  return { api, ...rendered, user: userEvent.setup() };
}

/** Typing a long text key by key is slow under MUI; the owner pasting it is the same to the page. */
async function fill(user: ReturnType<typeof userEvent.setup>, field: HTMLElement, text: string) {
  await user.click(field);
  await user.paste(text);
}

const listCalls = (api: MockApi) =>
  api.calls.filter((c) => c.method === "GET" && new URL(c.url).pathname === "/api/v1/applications");
const lastList = (api: MockApi) => new URL(listCalls(api).at(-1)?.url ?? "http://none");

describe("ApplicationsPage", () => {
  it("lists applications: company and role, status, follow-up flag, last reply, next interview, applied", async () => {
    setup();
    expect(await screen.findByRole("link", { name: "Kestrel Pay" })).toHaveAttribute(
      "href",
      "/applications/a-kestrel",
    );
    const rows = within(screen.getByRole("table")).getAllByRole("row");
    // header row, then one row per application
    expect(rows).toHaveLength(3);
    const kestrel = within(rows[1]!);
    expect(kestrel.getByText("Senior Frontend Engineer, Payments")).toBeInTheDocument();
    expect(kestrel.getByText("Interviewing")).toBeInTheDocument();
    expect(kestrel.getByText("2 days ago")).toBeInTheDocument();
    expect(kestrel.getByText("Fri, Oct 30, 10:00")).toBeInTheDocument();
    expect(kestrel.getByText("Oct 15")).toBeInTheDocument();
    expect(kestrel.queryByText("Follow-up due")).not.toBeInTheDocument();

    const northwind = within(rows[2]!);
    expect(northwind.getByText("Applied")).toBeInTheDocument();
    expect(northwind.getByText("Follow-up due")).toBeInTheDocument();
    expect(northwind.getByText("No reply yet")).toBeInTheDocument();
    expect(northwind.getByText("None")).toBeInTheDocument();
    expect(northwind.getByText("Oct 20")).toBeInTheDocument();
  });

  it("the header counts all applications and the open ones", async () => {
    setup();
    expect(
      await screen.findByText(
        "41 applications, 20 still open. Updated from Gmail every 5 minutes.",
      ),
    ).toBeInTheDocument();
  });

  // AC-6.1
  it("status filter chips are toggle buttons with aria-pressed and update the query; Follow-up due only and search filter too", async () => {
    const { api, user } = setup();
    await screen.findByRole("link", { name: "Kestrel Pay" });
    const filter = screen.getByRole("group", { name: "Filter by status" });

    const all = within(filter).getByRole("button", { name: "All 41" });
    expect(all).toHaveAttribute("aria-pressed", "true");
    expect(within(filter).getByRole("button", { name: "Applied 12" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(lastList(api).searchParams.getAll("status")).toEqual([]);

    await user.click(within(filter).getByRole("button", { name: "Applied 12" }));
    await waitFor(() => expect(lastList(api).searchParams.getAll("status")).toEqual(["applied"]));
    expect(within(filter).getByRole("button", { name: "Applied 12" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(all).toHaveAttribute("aria-pressed", "false");

    await user.click(within(filter).getByRole("button", { name: "Rejected 17" }));
    await waitFor(() =>
      expect(lastList(api).searchParams.getAll("status")).toEqual(["applied", "rejected"]),
    );

    // toggling a pressed chip turns it off
    await user.click(within(filter).getByRole("button", { name: "Applied 12" }));
    await waitFor(() => expect(lastList(api).searchParams.getAll("status")).toEqual(["rejected"]));

    // All clears the selection
    await user.click(within(filter).getByRole("button", { name: "All 41" }));
    await waitFor(() => expect(lastList(api).searchParams.getAll("status")).toEqual([]));
    expect(all).toHaveAttribute("aria-pressed", "true");

    expect(lastList(api).searchParams.get("followUpDue")).toBeNull();
    await user.click(screen.getByRole("switch", { name: "Follow-up due only" }));
    await waitFor(() => expect(lastList(api).searchParams.get("followUpDue")).toBe("true"));

    await user.type(screen.getByRole("searchbox", { name: "Search" }), "north");
    await waitFor(() => expect(lastList(api).searchParams.get("q")).toBe("north"));
    // typing is debounced: not one request per key
    expect(listCalls(api).filter((c) => new URL(c.url).searchParams.has("q"))).toHaveLength(1);
  });

  it("sorts by last activity by default, or by applied date or status", async () => {
    const { api, user } = setup();
    await screen.findByRole("link", { name: "Kestrel Pay" });
    expect(lastList(api).searchParams.get("sort")).toBe("last_activity");
    await user.click(screen.getByRole("combobox", { name: "Sort by" }));
    await user.click(screen.getByRole("option", { name: "Applied date" }));
    await waitFor(() => expect(lastList(api).searchParams.get("sort")).toBe("applied"));
    await user.click(screen.getByRole("combobox", { name: "Sort by" }));
    await user.click(screen.getByRole("option", { name: "Status" }));
    await waitFor(() => expect(lastList(api).searchParams.get("sort")).toBe("status"));
  });

  it("starts from the filters in the address, as the Today pipeline links to them", async () => {
    const { api } = setup({}, { route: "/applications?status=screening&status=offer" });
    await screen.findByRole("link", { name: "Kestrel Pay" });
    expect(lastList(api).searchParams.getAll("status")).toEqual(["screening", "offer"]);
    const filter = screen.getByRole("group", { name: "Filter by status" });
    expect(within(filter).getByRole("button", { name: "Screening 3" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(filter).getByRole("button", { name: "Offer 0" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(filter).getByRole("button", { name: "All 41" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("ignores a status in the address that is not one of the nine", async () => {
    const { api } = setup({}, { route: "/applications?status=hired&status=offer" });
    await screen.findByRole("link", { name: "Kestrel Pay" });
    expect(lastList(api).searchParams.getAll("status")).toEqual(["offer"]);
  });

  it("search follows the address: going to Applications from the nav clears it and it stays cleared", async () => {
    const { api, user } = setup({}, { route: "/applications?q=north" });
    await screen.findByRole("link", { name: "Kestrel Pay" });
    expect(screen.getByRole("searchbox", { name: "Search" })).toHaveValue("north");
    expect(lastList(api).searchParams.get("q")).toBe("north");
    await user.click(screen.getByRole("link", { name: "Applications nav" }));
    await waitFor(() => expect(screen.getByRole("searchbox", { name: "Search" })).toHaveValue(""));
    await waitFor(() => expect(lastList(api).searchParams.get("q")).toBeNull());
    // longer than the debounce: the old text must not be written back
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/applications$/);
    expect(lastList(api).searchParams.get("q")).toBeNull();
  });

  it("status chips and the company link are 44px targets on a phone and compact on a wide screen", async () => {
    const phone = setup({}, { width: 390 });
    await screen.findByRole("link", { name: "Kestrel Pay" });
    expect(screen.getByRole("button", { name: "Applied 12" })).toHaveStyle({ minHeight: "44px" });
    expect(screen.getByRole("button", { name: "All 41" })).toHaveStyle({ minHeight: "44px" });
    expect(screen.getByRole("link", { name: "Kestrel Pay" })).toHaveStyle({ minHeight: "44px" });
    phone.unmount();

    setup({}, { width: 1280 });
    await screen.findByRole("link", { name: "Kestrel Pay" });
    expect(screen.getByRole("button", { name: "Applied 12" })).toHaveStyle({ height: "32px" });
    expect(screen.getByRole("link", { name: "Kestrel Pay" })).not.toHaveStyle({
      minHeight: "44px",
    });
  });

  it("the table is a real <table> with scope='col' headers and scrolls inside its Paper", async () => {
    setup();
    const table = await screen.findByRole("table");
    const headers = within(table).getAllByRole("columnheader");
    expect(headers.map((h) => h.textContent)).toEqual([
      "Company and role",
      "Status",
      "Last reply from company",
      "Next interview",
      "Applied",
    ]);
    for (const header of headers) expect(header).toHaveAttribute("scope", "col");
    // the scroll container sits inside the outlined Paper and is the one that scrolls sideways
    const scroller = table.parentElement as HTMLElement;
    expect(scroller).toHaveStyle({ overflowX: "auto" });
    const paper = scroller.closest(".MuiPaper-root");
    expect(paper).not.toBeNull();
    expect(paper).toContainElement(table);
    expect(screen.getByRole("region", { name: "Applications" })).toBe(paper);
  });

  it("Show more follows the cursor and appends the next page", async () => {
    const second = makeApplication({
      id: "a-third",
      company: { id: "c-third", name: "Lumen Health" },
      title: "Senior Frontend Engineer",
    });
    const { api, user } = setup({
      "GET /api/v1/applications": (req) =>
        new URL(req.url).searchParams.get("cursor") === "next-1"
          ? page([second])
          : page([KESTREL, NORTHWIND], "next-1"),
    });
    await screen.findByRole("link", { name: "Kestrel Pay" });
    expect(screen.getByText("Showing 2 of 41")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show more" }));
    expect(await screen.findByRole("link", { name: "Lumen Health" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Kestrel Pay" })).toBeInTheDocument();
    expect(lastList(api).searchParams.get("cursor")).toBe("next-1");
    expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
  });

  it("j and k move between rows and Enter opens the application", async () => {
    const { user } = setup();
    await screen.findByRole("link", { name: "Kestrel Pay" });
    await user.keyboard("j");
    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(rows[1]).toHaveFocus();
    await user.keyboard("j");
    expect(rows[2]).toHaveFocus();
    await user.keyboard("k");
    expect(rows[1]).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(await screen.findByText("Detail page")).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/applications/a-kestrel");
  });

  // DESIGN_SPEC §7
  it("shows skeleton rows while loading, and an inline error with Try again when the list fails", async () => {
    let fail = true;
    const { user } = setup({
      "GET /api/v1/applications": () =>
        fail
          ? apiError(500, "internal_error", "Something went wrong on our side.")
          : page([KESTREL]),
    });
    expect(screen.getByRole("status", { name: "Loading applications" })).toBeInTheDocument();
    expect(await screen.findByText(/Couldn't load applications/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: "Kestrel Pay" })).toBeInTheDocument();
  });

  it("with no applications at all, invites importing a spreadsheet or syncing Gmail", async () => {
    setup({ "GET /api/v1/applications": () => page([]) });
    expect(await screen.findByText("No applications yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Import spreadsheet" })).toHaveAttribute(
      "href",
      "/settings/import",
    );
    expect(screen.getByRole("link", { name: "Start syncing Gmail" })).toHaveAttribute(
      "href",
      "/settings/gmail",
    );
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("with filters that match nothing, says so and offers to clear them", async () => {
    const { user } = setup(
      {
        "GET /api/v1/applications": (req) =>
          new URL(req.url).searchParams.has("followUpDue") ? page([]) : page([KESTREL]),
      },
      { route: "/applications?followUpDue=1" },
    );
    expect(await screen.findByText("No applications match these filters")).toBeInTheDocument();
    expect(screen.queryByText("No applications yet")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(await screen.findByRole("link", { name: "Kestrel Pay" })).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/applications");
    expect(screen.getByTestId("where")).not.toHaveTextContent("followUpDue");
  });

  // AC-6.3
  it("Add application opens a dialog and posts /applications", async () => {
    const posted: ApplicationCreate[] = [];
    const { api, user } = setup({
      "POST /api/v1/applications": async (req) => {
        posted.push((await req.clone().json()) as ApplicationCreate);
        return new Response(
          JSON.stringify(
            makeApplicationDetail({
              id: "a-new",
              company: { id: "c-new", name: "Tidewater Labs" },
            }),
          ),
          {
            status: 201,
            headers: { "Content-Type": "application/json" },
          },
        );
      },
    });
    await screen.findByRole("link", { name: "Kestrel Pay" });
    await user.click(screen.getByRole("button", { name: "Add application" }));
    const dialog = await screen.findByRole("dialog", { name: "Add application" });

    // a company and a role are required: nothing is sent without them
    await user.click(within(dialog).getByRole("button", { name: "Add application" }));
    expect(within(dialog).getByText("Enter the company name")).toBeInTheDocument();
    expect(within(dialog).getByText("Enter the role")).toBeInTheDocument();
    expect(posted).toHaveLength(0);

    await fill(user, within(dialog).getByLabelText("Company"), "Tidewater Labs");
    await fill(user, within(dialog).getByLabelText("Role"), "Staff Engineer");
    await fill(user, within(dialog).getByLabelText("Job link"), "https://jobs.example/tidewater/7");
    await fill(user, within(dialog).getByLabelText("Notes"), "Referred by a friend");
    await user.clear(within(dialog).getByLabelText("Applied date"));
    await fill(user, within(dialog).getByLabelText("Applied date"), "2026-10-05");
    await user.click(within(dialog).getByRole("combobox", { name: "Status" }));
    await user.click(screen.getByRole("option", { name: "Screening" }));
    const listsBefore = listCalls(api).length;
    await user.click(within(dialog).getByRole("button", { name: "Add application" }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      companyName: "Tidewater Labs",
      title: "Staff Engineer",
      jobUrl: "https://jobs.example/tidewater/7",
      status: "screening",
      // a date means local midnight in the owner's zone
      appliedAt: "2026-10-05T06:00:00.000Z",
      notes: "Referred by a friend",
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByText("Added Tidewater Labs")).toBeInTheDocument();
    // the list is fetched again
    await waitFor(() => expect(listCalls(api).length).toBeGreaterThan(listsBefore));
  });

  it("the Add application dialog sends empty optional fields as null and shows the server's field errors", async () => {
    const posted: ApplicationCreate[] = [];
    const { user } = setup({
      "POST /api/v1/applications": async (req) => {
        posted.push((await req.clone().json()) as ApplicationCreate);
        return apiError(400, "validation_failed", "Check the highlighted fields.", {
          jobUrl: "Enter a link that starts with http or https",
        });
      },
    });
    await screen.findByRole("link", { name: "Kestrel Pay" });
    await user.click(screen.getByRole("button", { name: "Add application" }));
    const dialog = await screen.findByRole("dialog", { name: "Add application" });
    await fill(user, within(dialog).getByLabelText("Company"), "Tidewater Labs");
    await fill(user, within(dialog).getByLabelText("Role"), "Staff Engineer");
    await user.clear(within(dialog).getByLabelText("Applied date"));
    await user.click(within(dialog).getByRole("button", { name: "Add application" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({
      jobUrl: null,
      appliedAt: null,
      notes: null,
      status: "applied",
    });
    expect(
      await within(dialog).findByText("Enter a link that starts with http or https"),
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Add application" })).toBeInTheDocument();
  });

  it("rejects a job link that is not http or https before sending anything", async () => {
    const posted: unknown[] = [];
    const { user } = setup({
      "POST /api/v1/applications": async (req) => {
        posted.push(await req.clone().json());
        return makeApplicationDetail();
      },
    });
    await screen.findByRole("link", { name: "Kestrel Pay" });
    await user.click(screen.getByRole("button", { name: "Add application" }));
    const dialog = await screen.findByRole("dialog", { name: "Add application" });
    await fill(user, within(dialog).getByLabelText("Company"), "Tidewater Labs");
    await fill(user, within(dialog).getByLabelText("Role"), "Staff Engineer");
    await fill(user, within(dialog).getByLabelText("Job link"), "javascript:alert(1)");
    await user.click(within(dialog).getByRole("button", { name: "Add application" }));
    expect(
      await within(dialog).findByText("Enter a link that starts with http or https"),
    ).toBeInTheDocument();
    expect(posted).toHaveLength(0);
  });

  it("the Add application dialog is full screen on a phone", async () => {
    const { user } = setup({}, { width: 390 });
    await screen.findByRole("link", { name: "Kestrel Pay" });
    await user.click(screen.getByRole("button", { name: "Add application" }));
    const dialog = await screen.findByRole("dialog", { name: "Add application" });
    expect(dialog.closest(".MuiDialog-paperFullScreen")).not.toBeNull();
  });
});
