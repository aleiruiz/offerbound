import type { Lead, Page, SearchRun } from "@offerbound/contracts";
import { DEFAULT_SETTINGS } from "@offerbound/contracts";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeApplicationDetail,
  makeEvent,
  makeLead,
  makeNavCounts,
  makeToday,
} from "../../test/factories";
import { apiError, mockApi, type MockApi, type MockHandler } from "../../test/mock-api";
import { renderWithProviders } from "../../test/render";
import { heavyIt } from "../../test/speed";
import { LEADS_SEEN_KEY } from "../lib/last-visit";
import { UndoSnackbar } from "../components/UndoSnackbar";
import { LeadsPage } from "./LeadsPage";

// MUI menus render slowly under jsdom; a busy machine must not turn that into a failure.
vi.setConfig({ testTimeout: 15_000 });

const ME = {
  mode: "private",
  email: "owner@example.test",
  onboardingCompleted: true,
  timezone: "America/Monterrey",
};

const SETTINGS = {
  ...DEFAULT_SETTINGS,
  search: {
    ...DEFAULT_SETTINGS.search,
    enabled: true,
    tracks: [
      { key: "A", label: "Remote from MX", priority: 1 },
      { key: "B", label: "Relocation", priority: 2 },
    ],
  },
};

const TIDEWATER = makeLead({ id: "l1", track: "A", fitScore: 91 });
const KITTIWAKE = makeLead({
  id: "l2",
  company: { id: "c2", name: "Kittiwake Systems" },
  title: "Senior Frontend Engineer, Dublin",
  jobUrl: "https://jobs.example/kittiwake/2",
  track: "B",
  fitScore: 87,
});
const BRIGHTLINE = makeLead({
  id: "l3",
  company: { id: "c3", name: "Brightline Learning" },
  title: "Senior Full-stack Engineer",
  status: "shortlisted",
  track: "A",
  fitScore: 84,
});
const HALYARD = makeLead({
  id: "l4",
  company: { id: "c4", name: "Halyard Health" },
  title: "Senior Frontend Engineer",
  status: "applied",
  applicationId: "a-halyard",
});
const SABLE = makeLead({
  id: "l5",
  company: { id: "c5", name: "Sable Security" },
  title: "Senior Software Engineer, Frontend",
  status: "dismissed",
});
const COBALT = makeLead({
  id: "l6",
  company: { id: "c6", name: "Cobalt Freightworks" },
  title: "Tech Lead, Platform",
  status: "suppressed",
  suppressedReason: "company_already_seen",
  jobUrl: null,
});
const ALL_LEADS = [TIDEWATER, KITTIWAKE, BRIGHTLINE, HALYARD, SABLE, COBALT];

const RUN: SearchRun = {
  id: "s1",
  trigger: "schedule",
  status: "succeeded",
  startedAt: "2026-10-29T13:00:00Z",
  finishedAt: "2026-10-29T13:09:00Z",
  rounds: 2,
  returned: 40,
  accepted: 24,
  suppressed: 9,
  duplicates: 4,
  dead: 3,
  webSearchCalls: 61,
  costMicros: null,
  error: null,
};

const page = (items: Lead[], nextCursor: string | null = null): Page<Lead> => ({
  items,
  nextCursor,
});

/** A server holding `leads`: filters by status and track, and honours `limit`. */
function leadsHandler(getLeads: () => Lead[]): MockHandler {
  return (req) => {
    const url = new URL(req.url);
    const status = url.searchParams.get("status");
    const track = url.searchParams.get("track");
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const matching = getLeads().filter(
      (l) => (status === null || l.status === status) && (track === null || l.track === track),
    );
    const start = Number(url.searchParams.get("cursor") ?? "0");
    const items = matching.slice(start, start + limit);
    return page(items, start + limit < matching.length ? String(start + limit) : null);
  };
}

type Routes = Record<string, MockHandler>;

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

function setup(
  routes: Routes = {},
  {
    route = "/leads",
    width,
    leads = ALL_LEADS,
  }: { route?: string; width?: number; leads?: Lead[] } = {},
) {
  const api: MockApi = mockApi({
    "GET /api/v1/me": () => ME,
    "GET /api/v1/settings": () => SETTINGS,
    "GET /api/v1/today": () => makeToday(),
    "GET /api/v1/nav-counts": () => makeNavCounts(),
    "GET /api/v1/leads": leadsHandler(() => leads),
    "GET /api/v1/search/runs": () => [RUN],
    ...routes,
  });
  const rendered = renderWithProviders(
    <>
      <Routes>
        <Route path="/leads" element={<LeadsPage />} />
        <Route path="/applications/:id" element={<p>Application page</p>} />
        <Route path="/settings/:section" element={<p>Settings page</p>} />
      </Routes>
      <Where />
      <Link to="/leads">Leads nav</Link>
      <UndoSnackbar />
    </>,
    { route, width },
  );
  return { api, ...rendered, user: userEvent.setup({ delay: null }) };
}

const callsTo = (api: MockApi, method: string, path: string) =>
  api.calls.filter((c) => c.method === method && new URL(c.url).pathname === path);

/** The page-sized list requests, not the tab-count reads. */
const listCalls = (api: MockApi) =>
  callsTo(api, "GET", "/api/v1/leads").filter(
    (c) => new URL(c.url).searchParams.get("limit") === "25",
  );
const lastList = (api: MockApi) => new URL(listCalls(api).at(-1)?.url ?? "http://none");

const tab = (name: RegExp | string) => screen.findByRole("tab", { name });
const rowOf = (company: string) => {
  const row = screen.getByText(company).closest("li");
  if (!row) throw new Error(`no row for ${company}`);
  return within(row);
};

beforeEach(() => {
  // 2026-10-29 12:00 in Monterrey, the day the search ran.
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-29T18:00:00Z") });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("LeadsPage", () => {
  // Heavy under jsdom (MUI re-renders on every step); see heavyIt.
  heavyIt(
    "tabs New, Shortlisted, Applied, Dismissed and Suppressed show counts, and the tab is kept in ?tab=",
    async () => {
      const { api, user } = setup();
      expect(await tab("New 2")).toHaveAttribute("aria-selected", "true");
      expect(await tab("Shortlisted 1")).toHaveAttribute("aria-selected", "false");
      expect(await tab("Applied 1")).toBeInTheDocument();
      expect(await tab("Dismissed 1")).toBeInTheDocument();
      expect(await tab("Suppressed 1")).toBeInTheDocument();
      expect(screen.getByRole("heading", { level: 1, name: "Leads" })).toBeInTheDocument();
      expect(await screen.findByText("Tidewater Labs")).toBeInTheDocument();
      expect(screen.queryByText("Brightline Learning")).not.toBeInTheDocument();

      await user.click(screen.getByRole("tab", { name: "Shortlisted 1" }));
      expect(await screen.findByText("Brightline Learning")).toBeInTheDocument();
      expect(screen.getByTestId("where")).toHaveTextContent("/leads?tab=shortlisted");
      expect(screen.getByRole("tab", { name: "Shortlisted 1" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      expect(lastList(api).searchParams.get("status")).toBe("shortlisted");
    },
  );

  it("opens on the tab named in the address, and falls back to New for an unknown one", async () => {
    const first = setup({}, { route: "/leads?tab=dismissed" });
    expect(await screen.findByText("Sable Security")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^Dismissed/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    first.unmount();

    setup({}, { route: "/leads?tab=bogus" });
    expect(await screen.findByText("Tidewater Labs")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^New/ })).toHaveAttribute("aria-selected", "true");
  });

  // Heavy under jsdom (MUI re-renders on every step); see heavyIt.
  heavyIt(
    "track filter chips and the sort 'Track, then fit' / 'Newest first' change the query",
    async () => {
      const { api, user } = setup();
      await screen.findByText("Tidewater Labs");
      // The default asks for no explicit sort and no track.
      expect(lastList(api).searchParams.has("sort")).toBe(false);
      expect(lastList(api).searchParams.has("track")).toBe(false);

      const group = screen.getByRole("group", { name: "Filter by track" });
      expect(within(group).getByRole("button", { name: "All tracks" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await user.click(within(group).getByRole("button", { name: "Relocation" }));
      expect(await screen.findByText("Kittiwake Systems")).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByText("Tidewater Labs")).not.toBeInTheDocument());
      expect(lastList(api).searchParams.get("track")).toBe("B");
      expect(within(group).getByRole("button", { name: "Relocation" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(screen.getByTestId("where")).toHaveTextContent("track=B");

      // Pressing the chosen track again goes back to every track.
      await user.click(within(group).getByRole("button", { name: "Relocation" }));
      expect(await screen.findByText("Tidewater Labs")).toBeInTheDocument();
      expect(lastList(api).searchParams.has("track")).toBe(false);

      await user.click(screen.getByRole("combobox", { name: "Sort" }));
      await user.click(await screen.findByRole("option", { name: "Newest first" }));
      await waitFor(() => expect(lastList(api).searchParams.get("sort")).toBe("newest"));
      expect(screen.getByTestId("where")).toHaveTextContent("sort=newest");

      await user.click(screen.getByRole("combobox", { name: "Sort" }));
      await user.click(await screen.findByRole("option", { name: "Track, then fit" }));
      await waitFor(() => expect(lastList(api).searchParams.has("sort")).toBe(false));
    },
  );

  it("keeps the track and the sort when the tab changes", async () => {
    const { api, user } = setup({}, { route: "/leads?track=A&sort=newest" });
    await screen.findByText("Tidewater Labs");
    await user.click(screen.getByRole("tab", { name: /^Shortlisted/ }));
    await screen.findByText("Brightline Learning");
    expect(lastList(api).searchParams.get("track")).toBe("A");
    expect(lastList(api).searchParams.get("sort")).toBe("newest");
  });

  it("shows each lead as a row: fit, company and role, track label, chips, reason and caption", async () => {
    setup();
    await screen.findByText("Tidewater Labs");
    const row = rowOf("Tidewater Labs");
    expect(row.getByText("91")).toBeInTheDocument();
    expect(row.getByText("Senior Product Engineer")).toBeInTheDocument();
    // The lead stores the track key; the row shows its label.
    expect(row.getByText("Remote from MX")).toBeInTheDocument();
    expect(row.getByText("Verified posting")).toBeInTheDocument();
    expect(row.getByText("US$9.5–11k / month")).toBeInTheDocument();
    expect(row.getByText("React, TypeScript and Node match your CV.")).toBeInTheDocument();
    expect(row.getByText(/Gaps: Go\. Found by the search at 07:04\./)).toBeInTheDocument();
    expect(row.getByRole("link", { name: "Open job posting" })).toHaveAttribute(
      "href",
      "https://jobs.example/tidewater/1",
    );
  });

  describe("actions", () => {
    it("Shortlist and Dismiss patch with version; Dismiss shows 'Dismissed {Company}' with Undo, which patches back to new", async () => {
      const { api, user } = setup({
        "PATCH /api/v1/leads/l1": async (req) => {
          const body = (await req.clone().json()) as { status: string };
          if (body.status === "shortlisted")
            return { ...TIDEWATER, status: "shortlisted", version: 2 };
          if (body.status === "dismissed") return { ...TIDEWATER, status: "dismissed", version: 3 };
          return { ...TIDEWATER, version: 4 };
        },
        "PATCH /api/v1/leads/l2": () => ({ ...KITTIWAKE, status: "dismissed", version: 2 }),
      });
      await screen.findByText("Tidewater Labs");

      await user.click(rowOf("Tidewater Labs").getByRole("button", { name: "Shortlist" }));
      expect(await screen.findByText("Shortlisted Tidewater Labs")).toBeInTheDocument();

      await user.click(rowOf("Kittiwake Systems").getByRole("button", { name: "Dismiss lead" }));
      expect(await screen.findByText("Dismissed Kittiwake Systems")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Undo" }));
      expect(await screen.findByText("Undone")).toBeInTheDocument();

      expect(await callsTo(api, "PATCH", "/api/v1/leads/l1")[0]?.json()).toEqual({
        version: 1,
        status: "shortlisted",
      });
      const kittiwake = callsTo(api, "PATCH", "/api/v1/leads/l2");
      expect(await Promise.all(kittiwake.map((p) => p.json()))).toEqual([
        { version: 1, status: "dismissed" },
        // The undo carries the version the dismissal produced.
        { version: 2, status: "new" },
      ]);
    });

    it("refreshes the lists and the counts after a change", async () => {
      let store = ALL_LEADS;
      const { user } = setup(
        {
          "GET /api/v1/leads": leadsHandler(() => store),
          "PATCH /api/v1/leads/l1": () => {
            store = store.map((l) => (l.id === "l1" ? { ...l, status: "shortlisted" } : l));
            return { ...TIDEWATER, status: "shortlisted", version: 2 };
          },
        },
        {},
      );
      await screen.findByText("Tidewater Labs");
      await user.click(rowOf("Tidewater Labs").getByRole("button", { name: "Shortlist" }));
      await waitFor(() => expect(screen.queryByText("Tidewater Labs")).not.toBeInTheDocument());
      expect(await tab("New 1")).toBeInTheDocument();
      expect(await tab("Shortlisted 2")).toBeInTheDocument();
    });

    it("undoing a dismissal of a shortlisted lead puts it back to shortlisted", async () => {
      const { api, user } = setup(
        {
          "PATCH /api/v1/leads/l3": () => ({ ...BRIGHTLINE, status: "dismissed", version: 2 }),
        },
        { route: "/leads?tab=shortlisted" },
      );
      await screen.findByText("Brightline Learning");
      await user.click(rowOf("Brightline Learning").getByRole("button", { name: "Dismiss lead" }));
      await screen.findByText("Dismissed Brightline Learning");
      await user.click(screen.getByRole("button", { name: "Undo" }));
      await screen.findByText("Undone");
      const patches = callsTo(api, "PATCH", "/api/v1/leads/l3");
      expect(await patches[1]?.json()).toEqual({ version: 2, status: "shortlisted" });
    });

    it("Mark applied posts mark-applied and shows 'Marked as applied' with Undo, which undoes the lead_converted event", async () => {
      const converted = makeApplicationDetail({
        id: "a-new",
        leadId: "l1",
        timeline: [
          makeEvent({ id: "e-status", type: "status_changed", undoable: false }),
          makeEvent({ id: "e-conv", type: "lead_converted", undoable: true }),
        ],
      });
      const { api, user } = setup({
        "POST /api/v1/leads/l1/mark-applied": () => ({ ...converted }),
        "POST /api/v1/events/e-conv/undo": () => ({ undone: true }),
      });
      await screen.findByText("Tidewater Labs");
      await user.click(rowOf("Tidewater Labs").getByRole("button", { name: "Mark applied" }));
      expect(await screen.findByText("Marked as applied")).toBeInTheDocument();
      expect(callsTo(api, "POST", "/api/v1/leads/l1/mark-applied")).toHaveLength(1);

      await user.click(screen.getByRole("button", { name: "Undo" }));
      expect(await screen.findByText("Undone")).toBeInTheDocument();
      expect(callsTo(api, "POST", "/api/v1/events/e-conv/undo")).toHaveLength(1);
      // Only the lead_converted event is undone, not the status entry before it.
      expect(callsTo(api, "POST", "/api/v1/events/e-status/undo")).toHaveLength(0);
    });

    it("offers no Undo when the answer carries no undoable lead_converted event", async () => {
      const { user } = setup({
        "POST /api/v1/leads/l1/mark-applied": () =>
          makeApplicationDetail({
            id: "a-new",
            timeline: [makeEvent({ type: "lead_converted", undoable: false })],
          }),
      });
      await screen.findByText("Tidewater Labs");
      await user.click(rowOf("Tidewater Labs").getByRole("button", { name: "Mark applied" }));
      expect(await screen.findByText("Marked as applied")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
    });

    it("says so when an action fails, and leaves the row alone", async () => {
      const { user } = setup({
        "PATCH /api/v1/leads/l1": () => apiError(500, "internal_error", "Something went wrong."),
        "POST /api/v1/leads/l2/mark-applied": () =>
          apiError(500, "internal_error", "Something went wrong."),
      });
      await screen.findByText("Tidewater Labs");
      await user.click(rowOf("Tidewater Labs").getByRole("button", { name: "Shortlist" }));
      expect(
        await screen.findByText("Couldn't shortlist Tidewater Labs. Try again."),
      ).toBeInTheDocument();
      await user.click(rowOf("Kittiwake Systems").getByRole("button", { name: "Mark applied" }));
      expect(
        await screen.findByText("Couldn't mark Kittiwake Systems as applied. Try again."),
      ).toBeInTheDocument();
      expect(screen.getByText("Tidewater Labs")).toBeInTheDocument();
    });

    it("a lead that changed elsewhere (409 version_conflict) refreshes the lists, says so, and the next try carries the fresh version", async () => {
      let fresh = false;
      let reject = true;
      const { api, user } = setup({
        "GET /api/v1/leads": leadsHandler(() =>
          ALL_LEADS.map((l) => (l.id === "l1" && fresh ? { ...l, version: 2 } : l)),
        ),
        "PATCH /api/v1/leads/l1": () => {
          if (reject) {
            fresh = true;
            reject = false;
            return apiError(409, "version_conflict", "The lead changed.");
          }
          return { ...TIDEWATER, status: "shortlisted", version: 3 };
        },
      });
      await screen.findByText("Tidewater Labs");
      const before = listCalls(api).length;
      await user.click(rowOf("Tidewater Labs").getByRole("button", { name: "Shortlist" }));
      expect(
        await screen.findByText("Changes were made elsewhere. Leads have been refreshed."),
      ).toBeInTheDocument();
      await waitFor(() => expect(listCalls(api).length).toBeGreaterThan(before));

      await user.click(rowOf("Tidewater Labs").getByRole("button", { name: "Shortlist" }));
      expect(await screen.findByText("Shortlisted Tidewater Labs")).toBeInTheDocument();
      const patches = callsTo(api, "PATCH", "/api/v1/leads/l1");
      expect(await Promise.all(patches.map((p) => p.json()))).toEqual([
        { version: 1, status: "shortlisted" },
        { version: 2, status: "shortlisted" },
      ]);
    });

    it("an Undo that meets a newer version says so", async () => {
      let first = true;
      const { user } = setup({
        "PATCH /api/v1/leads/l1": () => {
          if (first) {
            first = false;
            return { ...TIDEWATER, status: "dismissed", version: 2 };
          }
          return apiError(409, "version_conflict", "The lead changed.");
        },
      });
      await screen.findByText("Tidewater Labs");
      await user.click(rowOf("Tidewater Labs").getByRole("button", { name: "Dismiss lead" }));
      await screen.findByText("Dismissed Tidewater Labs");
      await user.click(screen.getByRole("button", { name: "Undo" }));
      expect(
        await screen.findByText(/Can't undo: changes were made elsewhere\./),
      ).toBeInTheDocument();
    });

    it("does not send a second request for a lead while its first is still under way", async () => {
      let release: (lead: Lead) => void = () => undefined;
      const { api, user } = setup({
        "PATCH /api/v1/leads/l1": () =>
          new Promise<Lead>((resolve) => {
            release = resolve;
          }),
      });
      await screen.findByText("Tidewater Labs");
      const shortlist = rowOf("Tidewater Labs").getByRole("button", { name: "Shortlist" });
      await user.click(shortlist);
      await user.click(shortlist);
      expect(callsTo(api, "PATCH", "/api/v1/leads/l1")).toHaveLength(1);
      act(() => release({ ...TIDEWATER, status: "shortlisted", version: 2 }));
      expect(await screen.findByText("Shortlisted Tidewater Labs")).toBeInTheDocument();
    });

    it("a slow change to one lead does not hold up another lead", async () => {
      const { api, user } = setup({
        "PATCH /api/v1/leads/l1": () => new Promise<Lead>(() => undefined),
        "PATCH /api/v1/leads/l2": () => ({ ...KITTIWAKE, status: "shortlisted", version: 2 }),
      });
      await screen.findByText("Tidewater Labs");
      await user.click(rowOf("Tidewater Labs").getByRole("button", { name: "Shortlist" }));
      await user.click(rowOf("Kittiwake Systems").getByRole("button", { name: "Shortlist" }));
      expect(await screen.findByText("Shortlisted Kittiwake Systems")).toBeInTheDocument();
      expect(callsTo(api, "PATCH", "/api/v1/leads/l1")).toHaveLength(1);
    });

    it("the snackbar does not wait for the tab counts to be read again", async () => {
      let hang = false;
      const base = leadsHandler(() => ALL_LEADS);
      const { user } = setup({
        "GET /api/v1/leads": (req) =>
          hang && new URL(req.url).searchParams.get("limit") === "200"
            ? new Promise<Response>(() => undefined)
            : base(req),
        "PATCH /api/v1/leads/l1": () => ({ ...TIDEWATER, status: "shortlisted", version: 2 }),
      });
      await tab("New 2");
      await screen.findByText("Tidewater Labs");
      hang = true;
      await user.click(rowOf("Tidewater Labs").getByRole("button", { name: "Shortlist" }));
      expect(await screen.findByText("Shortlisted Tidewater Labs")).toBeInTheDocument();
    });

    it("a 409 on Mark applied says the lead changed elsewhere and refreshes the lists", async () => {
      const { api, user } = setup({
        "POST /api/v1/leads/l1/mark-applied": () =>
          apiError(409, "changed_since", "The lead was already converted."),
      });
      await screen.findByText("Tidewater Labs");
      const before = listCalls(api).length;
      await user.click(rowOf("Tidewater Labs").getByRole("button", { name: "Mark applied" }));
      expect(
        await screen.findByText("Changes were made elsewhere. Leads have been refreshed."),
      ).toBeInTheDocument();
      await waitFor(() => expect(listCalls(api).length).toBeGreaterThan(before));
    });
  });

  describe("tabs other than New", () => {
    it("Shortlisted rows offer Mark applied and Dismiss, not Shortlist", async () => {
      setup({}, { route: "/leads?tab=shortlisted" });
      await screen.findByText("Brightline Learning");
      const row = rowOf("Brightline Learning");
      expect(row.getByRole("button", { name: "Mark applied" })).toBeInTheDocument();
      expect(row.getByRole("button", { name: "Dismiss lead" })).toBeInTheDocument();
      expect(row.queryByRole("button", { name: "Shortlist" })).not.toBeInTheDocument();
    });

    it("Applied rows link to their application", async () => {
      setup({}, { route: "/leads?tab=applied" });
      await screen.findByText("Halyard Health");
      expect(
        rowOf("Halyard Health").getByRole("link", { name: "Open application" }),
      ).toHaveAttribute("href", "/applications/a-halyard");
      expect(rowOf("Halyard Health").queryByRole("button", { name: "Mark applied" })).toBeNull();
    });

    it("Dismissed rows offer Reconsider, which patches the lead back to new", async () => {
      const { api, user } = setup(
        { "PATCH /api/v1/leads/l5": () => ({ ...SABLE, status: "new", version: 2 }) },
        { route: "/leads?tab=dismissed" },
      );
      await screen.findByText("Sable Security");
      await user.click(rowOf("Sable Security").getByRole("button", { name: "Reconsider" }));
      expect(await screen.findByText("Reconsidered Sable Security")).toBeInTheDocument();
      expect(await callsTo(api, "PATCH", "/api/v1/leads/l5")[0]?.json()).toEqual({
        version: 1,
        status: "new",
      });
    });

    it("Suppressed rows show the reason chip and Reconsider", async () => {
      const { api, user } = setup(
        {
          "POST /api/v1/leads/l6/reconsider": () => ({
            ...COBALT,
            status: "new",
            suppressedReason: null,
          }),
        },
        { route: "/leads?tab=suppressed" },
      );
      await screen.findByText("Cobalt Freightworks");
      const row = rowOf("Cobalt Freightworks");
      expect(row.getByText("Company already seen")).toBeInTheDocument();
      await user.click(row.getByRole("button", { name: "Reconsider" }));
      expect(await screen.findByText("Reconsidered Cobalt Freightworks")).toBeInTheDocument();
      expect(callsTo(api, "POST", "/api/v1/leads/l6/reconsider")).toHaveLength(1);
    });
  });

  describe("keyboard (DESIGN_SPEC §9.3)", () => {
    it("the keys s, d, a and o act on the focused row", async () => {
      const open = vi.spyOn(window, "open").mockReturnValue(null);
      const { api, user } = setup({
        "PATCH /api/v1/leads/l1": () => ({ ...TIDEWATER, status: "shortlisted", version: 2 }),
      });
      await screen.findByText("Tidewater Labs");

      // Nothing is focused yet: the keys do nothing.
      await user.keyboard("s");
      expect(callsTo(api, "PATCH", "/api/v1/leads/l1")).toHaveLength(0);

      await user.keyboard("j");
      expect(screen.getByText("Tidewater Labs").closest("li")).toHaveAttribute(
        "aria-current",
        "true",
      );
      await user.keyboard("o");
      expect(open).toHaveBeenCalledWith(
        "https://jobs.example/tidewater/1",
        "_blank",
        "noopener,noreferrer",
      );

      await user.keyboard("s");
      await screen.findByText("Shortlisted Tidewater Labs");
      expect(await callsTo(api, "PATCH", "/api/v1/leads/l1")[0]?.json()).toEqual({
        version: 1,
        status: "shortlisted",
      });
    });

    it("d dismisses and a marks applied, each on the focused row", async () => {
      const converted = makeApplicationDetail({
        timeline: [makeEvent({ id: "e-conv", type: "lead_converted" })],
      });
      const { api, user } = setup({
        "PATCH /api/v1/leads/l2": () => ({ ...KITTIWAKE, status: "dismissed", version: 2 }),
        "POST /api/v1/leads/l1/mark-applied": () => converted,
      });
      await screen.findByText("Tidewater Labs");
      await user.keyboard("jj");
      await user.keyboard("d");
      await screen.findByText("Dismissed Kittiwake Systems");
      expect(callsTo(api, "PATCH", "/api/v1/leads/l2")).toHaveLength(1);

      // Back to the first row, whatever the list did after the change.
      await user.keyboard("k");
      await user.keyboard("k");
      await user.keyboard("a");
      await screen.findByText("Marked as applied");
      expect(callsTo(api, "POST", "/api/v1/leads/l1/mark-applied")).toHaveLength(1);
    });

    it("s on a row that is not New, and o on a lead with no posting link, do nothing", async () => {
      const open = vi.spyOn(window, "open").mockReturnValue(null);
      const { api, user } = setup({}, { route: "/leads?tab=suppressed" });
      await screen.findByText("Cobalt Freightworks");
      await user.keyboard("j");
      await user.keyboard("s");
      await user.keyboard("d");
      await user.keyboard("a");
      await user.keyboard("o");
      expect(callsTo(api, "PATCH", "/api/v1/leads/l6")).toHaveLength(0);
      expect(callsTo(api, "POST", "/api/v1/leads/l6/mark-applied")).toHaveLength(0);
      expect(open).not.toHaveBeenCalled();
    });

    it("row keys do nothing while focus is in the Sort select or its menu, or on a button outside the list", async () => {
      const { api, user } = setup();
      await screen.findByText("Tidewater Labs");
      await user.keyboard("j");
      // Focus moves to the Sort select: s is not for the list now.
      screen.getByRole("combobox", { name: "Sort" }).focus();
      await user.keyboard("s");
      await user.keyboard("d");
      // The open menu is outside the list too.
      await user.click(screen.getByRole("combobox", { name: "Sort" }));
      await screen.findByRole("listbox");
      await user.keyboard("a");
      await user.keyboard("{Escape}");
      screen.getByRole("button", { name: "All tracks" }).focus();
      await user.keyboard("s");
      expect(callsTo(api, "PATCH", "/api/v1/leads/l1")).toHaveLength(0);
      expect(callsTo(api, "POST", "/api/v1/leads/l1/mark-applied")).toHaveLength(0);
    });

    it("does not open a posting link that is not http(s)", async () => {
      const open = vi.spyOn(window, "open").mockReturnValue(null);
      const { user } = setup(
        {},
        { leads: [{ ...TIDEWATER, jobUrl: "javascript:alert(1)" }, KITTIWAKE] },
      );
      await screen.findByText("Tidewater Labs");
      await user.keyboard("j");
      await user.keyboard("o");
      expect(open).not.toHaveBeenCalled();
      expect(
        rowOf("Tidewater Labs").queryByRole("link", { name: "Open job posting" }),
      ).not.toBeInTheDocument();
    });

    it("shows the shortcut hint under the list", async () => {
      setup();
      await screen.findByText("Tidewater Labs");
      expect(screen.getByText(/shortlist,/)).toBeInTheDocument();
      expect(screen.getByText(/mark applied,/)).toBeInTheDocument();
    });
  });

  describe("search", () => {
    it("captions the last run with its counts, in the owner's time zone", async () => {
      setup();
      expect(
        await screen.findByText(
          "The last search ran at 07:00: 24 new, 9 suppressed, 3 closed postings dropped.",
        ),
      ).toBeInTheDocument();
    });

    it("names the day when the last run was not today", async () => {
      setup({
        "GET /api/v1/search/runs": () => [
          { ...RUN, startedAt: "2026-10-27T13:00:00Z", dead: 1, suppressed: 1 },
        ],
      });
      expect(
        await screen.findByText(
          "The last search ran on Oct 27 at 07:00: 24 new, 1 suppressed, 1 closed posting dropped.",
        ),
      ).toBeInTheDocument();
    });

    it("points to Recent runs when the last search failed", async () => {
      setup({
        "GET /api/v1/search/runs": () => [{ ...RUN, status: "failed", error: "provider_error" }],
      });
      expect(await screen.findByText(/The last search failed\./)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Recent runs" })).toHaveAttribute(
        "href",
        "/settings/search",
      );
    });

    it("takes the newest run whatever order the list arrives in", async () => {
      setup({
        "GET /api/v1/search/runs": () => [
          { ...RUN, id: "old", startedAt: "2026-10-20T13:00:00Z", accepted: 3 },
          { ...RUN, id: "new", startedAt: "2026-10-29T13:00:00Z", accepted: 24 },
        ],
      });
      expect(
        await screen.findByText(/The last search ran at 07:00: 24 new, 9 suppressed/),
      ).toBeInTheDocument();
    });

    it("says no search has run yet when there are no runs", async () => {
      setup({ "GET /api/v1/search/runs": () => [] });
      expect(await screen.findByText("No search has run yet.")).toBeInTheDocument();
    });

    it("Run search now posts /search/run, says so, and shows the progress card", async () => {
      let started = false;
      const { api, user } = setup({
        "GET /api/v1/search/runs": () => [
          started
            ? { ...RUN, id: "s2", status: "running", finishedAt: null, rounds: 1, accepted: 5 }
            : RUN,
        ],
        "POST /api/v1/search/run": () => {
          started = true;
          return { ...RUN, id: "s2", status: "running", finishedAt: null, rounds: 0, accepted: 0 };
        },
      });
      await screen.findByText("Tidewater Labs");
      await user.click(screen.getByRole("button", { name: "Run search now" }));
      expect(await screen.findByText("Search started")).toBeInTheDocument();
      expect(callsTo(api, "POST", "/api/v1/search/run")).toHaveLength(1);
      const card = await screen.findByRole("status", { name: "Search progress" });
      expect(within(card).getByText("Searching for new leads")).toBeInTheDocument();
    });

    it("says 'A search is already running' on 409 already_running", async () => {
      const { user } = setup({
        "POST /api/v1/search/run": () => apiError(409, "already_running", "A search is running."),
      });
      await screen.findByText("Tidewater Labs");
      await user.click(screen.getByRole("button", { name: "Run search now" }));
      expect(await screen.findByText("A search is already running")).toBeInTheDocument();
    });

    it("a running search shows the progress card until the run finishes", async () => {
      vi.useRealTimers();
      vi.useFakeTimers({
        toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
        now: new Date("2026-10-29T18:00:00Z"),
      });
      let run: SearchRun = {
        ...RUN,
        id: "s2",
        status: "running",
        finishedAt: null,
        rounds: 2,
        accepted: 17,
      };
      let leads = ALL_LEADS;
      const { api } = setup({
        "GET /api/v1/search/runs": () => [run],
        "GET /api/v1/leads": leadsHandler(() => leads),
      });
      // Responses are read on real macrotasks, so a few short turns let an answer reach the screen.
      const settle = async () => {
        for (let i = 0; i < 3; i++) await act(() => vi.advanceTimersByTimeAsync(20));
      };
      await settle();

      const card = screen.getByRole("status", { name: "Search progress" });
      expect(within(card).getByText("Searching for new leads")).toBeInTheDocument();
      expect(
        within(card).getByText(
          "Round 2 of 3. 17 new leads so far. You can keep working; they appear in Leads when it finishes.",
        ),
      ).toBeInTheDocument();
      // Not a rows skeleton: the existing leads are still listed under the card.
      expect(screen.getByText("Tidewater Labs")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Run search now" })).toBeDisabled();

      // The card follows the run's progress.
      run = { ...run, rounds: 3, accepted: 24 };
      await act(() => vi.advanceTimersByTimeAsync(5_000));
      await settle();
      expect(screen.getByText(/Round 3 of 3\. 24 new leads so far\./)).toBeInTheDocument();

      // The run finishes: the card goes, the caption states the result and the lists are fetched again.
      const listsBefore = listCalls(api).length;
      leads = [makeLead({ id: "l9", company: { id: "c9", name: "Newfound Works" } }), ...ALL_LEADS];
      run = {
        ...run,
        status: "succeeded",
        finishedAt: "2026-10-29T18:06:00Z",
        suppressed: 9,
        dead: 3,
      };
      await act(() => vi.advanceTimersByTimeAsync(5_000));
      await settle();
      expect(screen.queryByRole("status", { name: "Search progress" })).not.toBeInTheDocument();
      expect(
        screen.getByText(/The last search ran at 07:00: 24 new, 9 suppressed/),
      ).toBeInTheDocument();
      expect(listCalls(api).length).toBeGreaterThan(listsBefore);
      expect(screen.getByText("Newfound Works")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Run search now" })).toBeEnabled();
    });

    it("stops asking quickly once nothing is running", async () => {
      vi.useRealTimers();
      vi.useFakeTimers({
        toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
        now: new Date("2026-10-29T18:00:00Z"),
      });
      const { api } = setup();
      await act(() => vi.advanceTimersByTimeAsync(0));
      const before = callsTo(api, "GET", "/api/v1/search/runs").length;
      await act(() => vi.advanceTimersByTimeAsync(10_000));
      expect(callsTo(api, "GET", "/api/v1/search/runs")).toHaveLength(before);
    });
  });

  describe("states (DESIGN_SPEC §7)", () => {
    it("shows skeleton rows while the leads load", async () => {
      let release: (page: Page<Lead>) => void = () => undefined;
      setup({
        "GET /api/v1/leads": () =>
          new Promise<Page<Lead>>((resolve) => {
            release = resolve;
          }),
      });
      expect(await screen.findByRole("status", { name: "Loading leads" })).toBeInTheDocument();
      act(() => release(page([])));
    });

    it("New, empty: 'No new leads. The next search runs at 07:00.' with Run search now", async () => {
      setup({}, { leads: [] });
      expect(
        await screen.findByText("No new leads. The next search runs at 07:00."),
      ).toBeInTheDocument();
      // The header button and the empty state's own button.
      expect(screen.getAllByRole("button", { name: "Run search now" })).toHaveLength(2);
    });

    it("New, empty, with the daily search off, says to use Run search now", async () => {
      setup(
        {
          "GET /api/v1/settings": () => ({
            ...SETTINGS,
            search: { ...SETTINGS.search, enabled: false },
          }),
        },
        { leads: [] },
      );
      expect(await screen.findByText("No new leads. The daily search is off.")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute(
        "href",
        "/settings/search",
      );
    });

    it.each([
      ["shortlisted", "No shortlisted leads"],
      ["applied", "No applied leads"],
      ["dismissed", "No dismissed leads"],
      ["suppressed", "No suppressed leads"],
    ])("%s, empty, names the next step", async (tabKey, title) => {
      setup({}, { route: `/leads?tab=${tabKey}`, leads: [] });
      expect(await screen.findByText(title)).toBeInTheDocument();
    });

    it("a track with no leads offers to show every track", async () => {
      const { user } = setup({}, { route: "/leads?track=B", leads: [TIDEWATER] });
      expect(await screen.findByText("No leads in this track")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Show every track" }));
      expect(await screen.findByText("Tidewater Labs")).toBeInTheDocument();
    });

    it("an inline error with Try again replaces the list, and the header and tabs stay", async () => {
      let fail = true;
      const base = leadsHandler(() => ALL_LEADS);
      const { user } = setup({
        "GET /api/v1/leads": (req) =>
          fail ? apiError(500, "internal_error", "The server had a problem.") : base(req),
      });
      expect(await screen.findByText("Couldn't load leads.")).toBeInTheDocument();
      expect(screen.getByRole("heading", { level: 1, name: "Leads" })).toBeInTheDocument();
      fail = false;
      await user.click(screen.getByRole("button", { name: "Try again" }));
      expect(await screen.findByText("Tidewater Labs")).toBeInTheDocument();
    });

    // Heavy under jsdom (MUI re-renders on every step); see heavyIt.
    heavyIt("Show more follows the cursor", async () => {
      const many = Array.from({ length: 30 }, (_, i) =>
        makeLead({
          id: `m${i}`,
          company: { id: `mc${i}`, name: `Company ${String(i).padStart(2, "0")}` },
        }),
      );
      const { api, user } = setup({}, { leads: many });
      await screen.findByText("Company 00");
      expect(screen.queryByText("Company 29")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Show more" }));
      expect(await screen.findByText("Company 29")).toBeInTheDocument();
      expect(lastList(api).searchParams.get("cursor")).toBe("25");
      expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
    });

    it("reads 200+ for a tab that holds more than one page of counts", async () => {
      const many = Array.from({ length: 201 }, (_, i) =>
        makeLead({ id: `d${i}`, company: { id: `dc${i}`, name: `Old ${i}` }, status: "dismissed" }),
      );
      setup({}, { leads: [TIDEWATER, ...many] });
      expect(await tab("Dismissed 200+")).toBeInTheDocument();
    });
  });

  describe("phones (DESIGN_SPEC §9.4)", () => {
    it("filter chips and tabs are at least 44px tall below 600px", async () => {
      setup({}, { width: 390 });
      await screen.findByText("Tidewater Labs");
      expect(screen.getByRole("button", { name: "All tracks" })).toHaveStyle({ minHeight: "44px" });
      expect(screen.getByRole("button", { name: "Relocation" })).toHaveStyle({ minHeight: "44px" });
      expect(screen.getByRole("tab", { name: /^Shortlisted/ })).toHaveStyle({ minHeight: "44px" });
    });

    it("row actions move into a menu below 600px", async () => {
      const { user } = setup({}, { width: 390 });
      await screen.findByText("Tidewater Labs");
      const row = rowOf("Tidewater Labs");
      expect(row.queryByRole("button", { name: "Shortlist" })).not.toBeInTheDocument();
      await user.click(row.getByRole("button", { name: "More actions" }));
      expect(await screen.findByRole("menuitem", { name: "Shortlist" })).toBeInTheDocument();
    });

    it("the link to Recent runs is 44px tall below 600px", async () => {
      setup({ "GET /api/v1/search/runs": () => [{ ...RUN, status: "failed" }] }, { width: 390 });
      expect(await screen.findByRole("link", { name: "Recent runs" })).toHaveStyle({
        minHeight: "44px",
      });
    });
  });

  it("uses the address bar's tab when the nav link to /leads is followed", async () => {
    const { user } = setup({}, { route: "/leads?tab=dismissed" });
    await screen.findByText("Sable Security");
    await user.click(screen.getByRole("link", { name: "Leads nav" }));
    expect(await screen.findByText("Tidewater Labs")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^New/ })).toHaveAttribute("aria-selected", "true");
  });

  it("links to the report importer", async () => {
    setup();
    expect(await screen.findByRole("link", { name: "Import a report" })).toHaveAttribute(
      "href",
      "/leads/import",
    );
  });

  describe("leads found since your last visit", () => {
    // The fake clock stands at 2026-10-29T18:00Z. The previous visit was that morning.
    const PREVIOUS = "2026-10-29T10:00:00.000Z";
    const FRESH = makeLead({ id: "n1", foundAt: "2026-10-29T13:04:00Z" });
    const FRESHER = makeLead({
      id: "n2",
      company: { id: "c7", name: "Marlin Analytics" },
      foundAt: "2026-10-29T15:30:00Z",
    });
    const STALE = makeLead({
      id: "n3",
      company: { id: "c8", name: "Quillon Works" },
      foundAt: "2026-10-28T09:00:00Z",
    });
    const LEADS = [FRESH, FRESHER, STALE];
    const newChip = (company: string) => rowOf(company).queryByText("New");

    it("highlights only leads found after the stored visit and counts them in the caption", async () => {
      window.localStorage.setItem(LEADS_SEEN_KEY, PREVIOUS);
      setup({}, { leads: LEADS });
      await screen.findByText("Tidewater Labs");
      expect(newChip("Tidewater Labs")).toBeInTheDocument();
      expect(newChip("Marlin Analytics")).toBeInTheDocument();
      expect(newChip("Quillon Works")).not.toBeInTheDocument();
      expect(screen.getByText("2 new in this list since your last visit")).toBeInTheDocument();
      expect(screen.getAllByText("New", { selector: ".MuiChip-label" })).toHaveLength(2);
    });

    it("says '1 new' for a single find", async () => {
      window.localStorage.setItem(LEADS_SEEN_KEY, "2026-10-29T14:00:00.000Z");
      setup({}, { leads: LEADS });
      await screen.findByText("Tidewater Labs");
      expect(screen.getByText("1 new in this list since your last visit")).toBeInTheDocument();
    });

    it("highlights nothing and shows no count on the first visit ever", async () => {
      setup({}, { leads: LEADS });
      await screen.findByText("Tidewater Labs");
      expect(screen.queryByText("New", { selector: ".MuiChip-label" })).not.toBeInTheDocument();
      expect(screen.queryByText(/since your last visit/)).not.toBeInTheDocument();
    });

    it("shows no count when nothing is newer than the last visit", async () => {
      window.localStorage.setItem(LEADS_SEEN_KEY, "2026-10-29T17:00:00.000Z");
      setup({}, { leads: LEADS });
      await screen.findByText("Tidewater Labs");
      expect(screen.queryByText("New", { selector: ".MuiChip-label" })).not.toBeInTheDocument();
      expect(screen.queryByText(/since your last visit/)).not.toBeInTheDocument();
    });

    it("stores the current time as the new last visit", async () => {
      window.localStorage.setItem(LEADS_SEEN_KEY, PREVIOUS);
      setup({}, { leads: LEADS });
      await screen.findByText("Tidewater Labs");
      expect(window.localStorage.getItem(LEADS_SEEN_KEY)).toBe("2026-10-29T18:00:00.000Z");
    });

    it("stores the time on the first visit too, so the next one has a mark", async () => {
      setup({}, { leads: LEADS });
      await screen.findByText("Tidewater Labs");
      expect(window.localStorage.getItem(LEADS_SEEN_KEY)).toBe("2026-10-29T18:00:00.000Z");
    });

    it("keeps the mark fixed during the visit, across a refetch and a later clock", async () => {
      window.localStorage.setItem(LEADS_SEEN_KEY, PREVIOUS);
      const { queryClient } = setup({}, { leads: LEADS });
      await screen.findByText("Tidewater Labs");
      expect(screen.getByText("2 new in this list since your last visit")).toBeInTheDocument();
      // Time passes and the leads are fetched again: the page has already stored a later time,
      // yet the same rows stay highlighted.
      act(() => {
        vi.setSystemTime(new Date("2026-10-29T20:00:00Z"));
      });
      await act(async () => {
        await queryClient.invalidateQueries();
      });
      await screen.findByText("Tidewater Labs");
      expect(newChip("Tidewater Labs")).toBeInTheDocument();
      expect(screen.getByText("2 new in this list since your last visit")).toBeInTheDocument();
    });

    it("highlights a lead on any tab it appears in", async () => {
      window.localStorage.setItem(LEADS_SEEN_KEY, PREVIOUS);
      const shortlisted = makeLead({
        id: "n4",
        company: { id: "c9", name: "Plover Robotics" },
        status: "shortlisted",
        foundAt: "2026-10-29T16:00:00Z",
      });
      setup({}, { leads: [...LEADS, shortlisted], route: "/leads?tab=shortlisted" });
      await screen.findByText("Plover Robotics");
      expect(newChip("Plover Robotics")).toBeInTheDocument();
    });

    it("counts the rows of the current tab, not every lead", async () => {
      window.localStorage.setItem(LEADS_SEEN_KEY, PREVIOUS);
      const shortlisted = makeLead({
        id: "n4",
        company: { id: "c9", name: "Plover Robotics" },
        status: "shortlisted",
        foundAt: "2026-10-29T16:00:00Z",
      });
      setup({}, { leads: [...LEADS, shortlisted], route: "/leads?tab=shortlisted" });
      await screen.findByText("Plover Robotics");
      expect(screen.getByText("1 new in this list since your last visit")).toBeInTheDocument();
    });

    it("counts the rows of a filtered list", async () => {
      window.localStorage.setItem(LEADS_SEEN_KEY, PREVIOUS);
      const trackA = makeLead({ id: "n5", track: "A", foundAt: "2026-10-29T13:04:00Z" });
      const trackB = makeLead({
        id: "n6",
        track: "B",
        company: { id: "c10", name: "Osprey Cloud" },
        foundAt: "2026-10-29T14:00:00Z",
      });
      const trackBOld = makeLead({
        id: "n7",
        track: "B",
        company: { id: "c11", name: "Heron Data" },
        foundAt: "2026-10-27T14:00:00Z",
      });
      setup({}, { leads: [trackA, trackB, trackBOld], route: "/leads?track=B" });
      await screen.findByText("Osprey Cloud");
      expect(screen.queryByText("Tidewater Labs")).not.toBeInTheDocument();
      expect(screen.getByText("1 new in this list since your last visit")).toBeInTheDocument();
    });

    it("keeps the same mark when switching tabs within the page", async () => {
      window.localStorage.setItem(LEADS_SEEN_KEY, PREVIOUS);
      const shortlistedNew = makeLead({
        id: "n4",
        company: { id: "c9", name: "Plover Robotics" },
        status: "shortlisted",
        foundAt: "2026-10-29T16:00:00Z",
      });
      const shortlistedOld = makeLead({
        id: "n8",
        company: { id: "c12", name: "Egret Labs" },
        status: "shortlisted",
        foundAt: "2026-10-29T09:00:00Z",
      });
      const { user } = setup({}, { leads: [...LEADS, shortlistedNew, shortlistedOld] });
      await screen.findByText("Tidewater Labs");
      expect(window.localStorage.getItem(LEADS_SEEN_KEY)).toBe("2026-10-29T18:00:00.000Z");
      act(() => {
        vi.setSystemTime(new Date("2026-10-29T20:00:00Z"));
      });
      await user.click(await tab(/^Shortlisted/));
      await screen.findByText("Plover Robotics");
      expect(newChip("Plover Robotics")).toBeInTheDocument();
      expect(newChip("Egret Labs")).not.toBeInTheDocument();
      expect(screen.getByText("1 new in this list since your last visit")).toBeInTheDocument();
    });

    it("does not store the visit when the leads fail to load", async () => {
      window.localStorage.setItem(LEADS_SEEN_KEY, PREVIOUS);
      setup(
        { "GET /api/v1/leads": () => apiError(500, "internal_error", "Something went wrong.") },
        { leads: LEADS },
      );
      await screen.findByRole("button", { name: /retry|try again/i });
      expect(window.localStorage.getItem(LEADS_SEEN_KEY)).toBe(PREVIOUS);
    });

    it("does not crash and highlights nothing when storage throws", async () => {
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("blocked");
      });
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("blocked");
      });
      setup({}, { leads: LEADS });
      expect(await screen.findByText("Tidewater Labs")).toBeInTheDocument();
      expect(screen.queryByText("New", { selector: ".MuiChip-label" })).not.toBeInTheDocument();
      expect(screen.queryByText(/since your last visit/)).not.toBeInTheDocument();
    });
  });
});
