import type { InterviewWithApplication, Page } from "@offerbound/contracts";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeApplication, makeInterview, makeNavCounts, makeToday } from "../../test/factories";
import { apiError, mockApi, type MockApi, type MockHandler } from "../../test/mock-api";
import { renderWithProviders } from "../../test/render";
import { heavyIt, setValue } from "../../test/speed";
import { UndoSnackbar } from "../components/UndoSnackbar";
import { InterviewsPage } from "./InterviewsPage";

// MUI selects and dialogs render slowly under jsdom; a busy machine must not turn that into a failure.
vi.setConfig({ testTimeout: 15_000 });

const ME = {
  mode: "private",
  email: "owner@example.test",
  onboardingCompleted: true,
  timezone: "America/Monterrey",
};

const KESTREL_APP = makeApplication({
  id: "a1",
  company: { id: "c3", name: "Kestrel Pay" },
  title: "Senior Frontend Engineer",
  status: "interviewing",
});
const MERIDIAN_APP = makeApplication({
  id: "a2",
  company: { id: "c4", name: "Meridian Freight" },
  title: "Tech Lead, Web",
  status: "interviewing",
});
const LUMEN_APP = makeApplication({
  id: "a3",
  company: { id: "c5", name: "Lumen Health" },
  title: "Senior Frontend Engineer",
  status: "screening",
});
const ARBOR_APP = makeApplication({
  id: "a4",
  company: { id: "c6", name: "Arbor Analytics" },
  title: "Senior Product Engineer, Data",
  status: "interviewing",
});

/** Thursday Oct 29, 12:00 in Monterrey. */
const NOW = new Date("2026-10-29T18:00:00Z");

const TO_SCHEDULE = makeInterview({
  id: "i-ts",
  applicationId: "a2",
  application: MERIDIAN_APP,
  kind: "hiring_manager",
  status: "to_schedule",
  startsAt: null,
  endsAt: null,
  meetingUrl: null,
  interviewers: [],
  schedulingUrl: "https://schedule.example/meridian",
});
// Fri Oct 30, 10:00 to 11:00 in Monterrey: tomorrow.
const KESTREL = makeInterview({
  id: "i1",
  applicationId: "a1",
  application: KESTREL_APP,
});
// Mon Nov 2, 16:30 to 17:00.
const LUMEN = makeInterview({
  id: "i2",
  applicationId: "a3",
  application: LUMEN_APP,
  kind: "recruiter_screen",
  startsAt: "2026-11-02T22:30:00Z",
  endsAt: "2026-11-02T23:00:00Z",
  meetingUrl: null,
  interviewers: [],
  location: "Phone call; the recruiter will call you",
});
// Wed Nov 4, 12:00 to 13:30.
const ARBOR = makeInterview({
  id: "i3",
  applicationId: "a4",
  application: ARBOR_APP,
  kind: "system_design",
  startsAt: "2026-11-04T18:00:00Z",
  endsAt: "2026-11-04T19:30:00Z",
  notes: "Review the caching chapter",
});
// Wed Nov 4, 23:30 in Monterrey, which is already Nov 5 in UTC.
const LATE = makeInterview({
  id: "i4",
  applicationId: "a1",
  application: KESTREL_APP,
  kind: "behavioral",
  startsAt: "2026-11-05T05:30:00Z",
  endsAt: null,
  meetingUrl: null,
  interviewers: [],
});
// The server answers in order; the page must not depend on it, so this one is shuffled.
const UPCOMING = [ARBOR, TO_SCHEDULE, LATE, KESTREL, LUMEN];

const PAST_DONE_OLD = makeInterview({
  id: "p1",
  application: KESTREL_APP,
  kind: "recruiter_screen",
  status: "completed",
  startsAt: "2026-10-20T15:00:00Z",
  endsAt: "2026-10-20T15:30:00Z",
  meetingUrl: null,
});
const PAST_CANCELLED = makeInterview({
  id: "p2",
  application: ARBOR_APP,
  kind: "technical",
  status: "cancelled",
  startsAt: "2026-10-22T17:00:00Z",
  endsAt: "2026-10-22T18:00:00Z",
  meetingUrl: null,
});
const PAST_DONE_NEW = makeInterview({
  id: "p3",
  application: LUMEN_APP,
  kind: "hiring_manager",
  status: "completed",
  startsAt: "2026-10-27T15:00:00Z",
  endsAt: "2026-10-27T16:00:00Z",
  meetingUrl: null,
});
const PAST = [PAST_DONE_OLD, PAST_DONE_NEW, PAST_CANCELLED];

const page = <T,>(items: T[], nextCursor: string | null = null): Page<T> => ({ items, nextCursor });

/** A server holding interviews per range; honours `limit` and `cursor`. */
function interviewsHandler(
  upcoming: () => InterviewWithApplication[],
  past: () => InterviewWithApplication[] = () => PAST,
): MockHandler {
  return (req) => {
    const url = new URL(req.url);
    const all = url.searchParams.get("range") === "past" ? past() : upcoming();
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const start = Number(url.searchParams.get("cursor") ?? "0");
    return page(
      all.slice(start, start + limit),
      start + limit < all.length ? String(start + limit) : null,
    );
  };
}

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

type Routes = Record<string, MockHandler>;

function setup(
  routes: Routes = {},
  {
    route = "/interviews",
    width,
    me = ME,
  }: { route?: string; width?: number; me?: typeof ME } = {},
) {
  const api: MockApi = mockApi({
    "GET /api/v1/me": () => me,
    "GET /api/v1/today": () => makeToday(),
    "GET /api/v1/nav-counts": () => makeNavCounts({ upcomingInterviews: 5 }),
    "GET /api/v1/interviews": interviewsHandler(() => UPCOMING),
    "GET /api/v1/applications": () => page([KESTREL_APP, MERIDIAN_APP, LUMEN_APP]),
    ...routes,
  });
  const rendered = renderWithProviders(
    <>
      <Routes>
        <Route path="/interviews" element={<InterviewsPage />} />
        <Route path="/applications/:id" element={<p>Application page</p>} />
      </Routes>
      <Where />
      <UndoSnackbar />
    </>,
    { route, width },
  );
  return { api, ...rendered, user: userEvent.setup({ delay: null }) };
}

const callsTo = (api: MockApi, method: string, path: string) =>
  api.calls.filter((c) => c.method === method && new URL(c.url).pathname === path);

const lastList = (api: MockApi) =>
  new URL(callsTo(api, "GET", "/api/v1/interviews").at(-1)?.url ?? "http://none");

/** The row (list item) that shows `text`. */
function rowOf(text: string) {
  const row = screen.getByText(text).closest("li");
  if (!row) throw new Error(`no row for ${text}`);
  return within(row);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("InterviewsPage", () => {
  it("Upcoming shows To schedule first on the amber band, then day groups in owner time with 24-hour times", async () => {
    const { api } = setup();
    expect(screen.getByRole("heading", { level: 1, name: "Interviews" })).toBeInTheDocument();
    const band = await screen.findByRole("region", { name: "To schedule" });
    expect(within(band).getByText("You haven't picked a time yet")).toBeInTheDocument();
    // the amber band is the signal tint
    expect(within(band).getByText("You haven't picked a time yet").parentElement).toHaveStyle({
      backgroundColor: "rgb(252, 239, 216)",
    });
    expect(within(band).getByText("Hiring manager interview")).toBeInTheDocument();
    expect(within(band).getByText("No time yet")).toBeInTheDocument();
    expect(within(band).getByRole("link", { name: "Pick a time" })).toHaveAttribute(
      "href",
      "https://schedule.example/meridian",
    );
    expect(within(band).getByRole("link", { name: "Open application" })).toHaveAttribute(
      "href",
      "/applications/a2",
    );

    // day groups, oldest first, after the band
    const days = screen
      .getAllByRole("heading", { level: 2 })
      .map((h) => h.textContent)
      .filter((t) => t !== "To schedule");
    expect(days).toEqual(["Friday, October 30", "Monday, November 2", "Wednesday, November 4"]);
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings[0]).toBe("To schedule");

    // 24-hour times in Monterrey; 23:30 local is still Wednesday although it is Nov 5 in UTC
    const wednesday = within(screen.getByRole("list", { name: "Wednesday, November 4" }));
    expect(wednesday.getByText("12:00–13:30")).toBeInTheDocument();
    expect(wednesday.getByText("23:30")).toBeInTheDocument();
    expect(
      within(screen.getByRole("list", { name: "Friday, October 30" })).getByText("10:00–11:00"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("list", { name: "Monday, November 2" })).getByText("16:30–17:00"),
    ).toBeInTheDocument();
    // inside a day, earlier first
    const wednesdayTimes = wednesday.getAllByText(/^\d\d:\d\d/).map((t) => t.textContent);
    expect(wednesdayTimes).toEqual(["12:00–13:30", "23:30"]);

    // Tomorrow chip; the place, the people and the call link
    const kestrel = rowOf("10:00–11:00");
    expect(kestrel.getByText("Tomorrow")).toBeInTheDocument();
    expect(kestrel.getByText("Technical interview")).toBeInTheDocument();
    expect(
      kestrel.getByText(
        "Kestrel Pay, Senior Frontend Engineer. With Priya Natarajan and Tom Salas.",
      ),
    ).toBeInTheDocument();
    expect(kestrel.getByRole("link", { name: "Join video call" })).toHaveAttribute(
      "href",
      "https://meet.example/kestrel",
    );
    expect(
      rowOf("16:30–17:00").getByText("Phone call; the recruiter will call you"),
    ).toBeInTheDocument();
    // nothing the DTO cannot say: no Rescheduled chip
    expect(screen.queryByText("Rescheduled")).not.toBeInTheDocument();

    expect(lastList(api).searchParams.get("range")).toBe("upcoming");
    expect(lastList(api).searchParams.get("limit")).toBe("25");
    expect(screen.getByText(/Times are in Monterrey time\./)).toBeInTheDocument();
  });

  it("shows times in the owner's time zone from the account, not the browser's", async () => {
    setup({}, { me: { ...ME, timezone: "America/New_York" } });
    // 16:00Z is 12:00 in New York in October
    expect(await screen.findByText("12:00–13:00")).toBeInTheDocument();
    expect(screen.getByText(/Times are in New York time\./)).toBeInTheDocument();
  });

  it("the Upcoming tab carries the count from /nav-counts and Past has none", async () => {
    setup();
    expect(await screen.findByRole("tab", { name: "Upcoming 5" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "Past" })).toHaveAttribute("aria-selected", "false");
  });

  describe("Past", () => {
    it("Past lists interviews newest first", async () => {
      const { api, user } = setup();
      await user.click(await screen.findByRole("tab", { name: "Past" }));
      expect(await screen.findByText("Hiring manager interview")).toBeInTheDocument();
      expect(screen.getByTestId("where")).toHaveTextContent("/interviews?tab=past");
      expect(lastList(api).searchParams.get("range")).toBe("past");

      // the server order is oldest first on purpose
      const days = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
      expect(days).toEqual(["Tuesday, October 27", "Thursday, October 22", "Tuesday, October 20"]);
      // no band for interviews to schedule
      expect(screen.queryByRole("region", { name: "To schedule" })).not.toBeInTheDocument();
      // outcomes are chips, and a done interview still has its notes and its application
      expect(rowOf("09:00–10:00").getByText("Done")).toBeInTheDocument();
      expect(rowOf("11:00–12:00").getByText("Cancelled")).toBeInTheDocument();
      expect(screen.queryByText("Tomorrow")).not.toBeInTheDocument();
    });

    it("lists a past interview that never got a time under No date, after the days", async () => {
      const never = makeInterview({
        id: "p4",
        application: ARBOR_APP,
        kind: "other",
        status: "cancelled",
        startsAt: null,
        endsAt: null,
        meetingUrl: null,
        interviewers: [],
      });
      setup(
        {
          "GET /api/v1/interviews": interviewsHandler(
            () => UPCOMING,
            () => [never, ...PAST],
          ),
        },
        { route: "/interviews?tab=past" },
      );
      expect(await screen.findByText("No date")).toBeInTheDocument();
      const days = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
      expect(days).toEqual([
        "Tuesday, October 27",
        "Thursday, October 22",
        "Tuesday, October 20",
        "No date",
      ]);
      const group = within(screen.getByRole("list", { name: "No date" }));
      expect(group.getByText("No time yet")).toBeInTheDocument();
      expect(group.getByText("Cancelled")).toBeInTheDocument();
    });

    it("opens on Past when the address says so, and falls back to Upcoming for an unknown tab", async () => {
      const first = setup({}, { route: "/interviews?tab=past" });
      expect(await screen.findByText("Tuesday, October 27")).toBeInTheDocument();
      first.unmount();
      setup({}, { route: "/interviews?tab=nonsense" });
      expect(await screen.findByText("Friday, October 30")).toBeInTheDocument();
    });

    it("says there are no past interviews when there are none", async () => {
      setup(
        {
          "GET /api/v1/interviews": interviewsHandler(
            () => UPCOMING,
            () => [],
          ),
        },
        { route: "/interviews?tab=past" },
      );
      expect(await screen.findByText("No past interviews yet.")).toBeInTheDocument();
    });
  });

  describe("states (DESIGN_SPEC §7)", () => {
    it("shows skeletons while loading", () => {
      setup({ "GET /api/v1/interviews": () => new Promise(() => undefined) });
      expect(screen.getByRole("status", { name: "Loading interviews" })).toBeInTheDocument();
    });

    it("says there is nothing coming up and offers Add interview", async () => {
      setup({ "GET /api/v1/interviews": interviewsHandler(() => []) });
      expect(await screen.findByText("No interviews coming up.")).toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: "Add interview" })).toHaveLength(2);
    });

    it("shows an inline error with Try again", async () => {
      let fail = true;
      const { user } = setup({
        "GET /api/v1/interviews": (req) =>
          fail
            ? apiError(500, "internal_error", "Something broke.")
            : interviewsHandler(() => UPCOMING)(req),
      });
      expect(await screen.findByText(/Something broke\./)).toBeInTheDocument();
      fail = false;
      await user.click(screen.getByRole("button", { name: "Try again" }));
      expect(await screen.findByText("Friday, October 30")).toBeInTheDocument();
    });

    it("Show more follows the cursor", async () => {
      const many = Array.from({ length: 30 }, (_, i) =>
        makeInterview({
          id: `m${i}`,
          application: KESTREL_APP,
          startsAt: new Date(
            Date.UTC(2026, 10, 10 + Math.floor(i / 3), 16 + (i % 3)),
          ).toISOString(),
          endsAt: null,
        }),
      );
      const { api, user } = setup({ "GET /api/v1/interviews": interviewsHandler(() => many) });
      await screen.findByText("Tuesday, November 10");
      expect(screen.queryByText("Thursday, November 19")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Show more" }));
      expect(await screen.findByText("Thursday, November 19")).toBeInTheDocument();
      expect(lastList(api).searchParams.get("cursor")).toBe("25");
      expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
    });
  });

  describe("Prep notes (AC-8.5)", () => {
    it("Prep notes opens the side sheet and patches the notes", async () => {
      const patches: unknown[] = [];
      const { api, user } = setup({
        "PATCH /api/v1/interviews/i3": async (req) => {
          const body = (await req.clone().json()) as Record<string, unknown>;
          patches.push(body);
          return { ...ARBOR, version: 2, notes: body.notes };
        },
      });
      await screen.findByText("12:00–13:30");
      await user.click(rowOf("12:00–13:30").getByRole("button", { name: "Prep notes" }));
      const sheet = await screen.findByRole("dialog", { name: "Prep notes" });
      // it names the interview and shows what is kept so far
      expect(
        within(sheet).getByText(/Arbor Analytics, Senior Product Engineer, Data/),
      ).toBeInTheDocument();
      const field = within(sheet).getByRole("textbox", { name: "Prep notes" });
      expect(field).toHaveValue("Review the caching chapter");
      // nothing to save until it changes
      expect(within(sheet).getByRole("button", { name: "Save notes" })).toBeDisabled();

      setValue(field, "Review the caching chapter\nAsk about on-call");
      await user.click(within(sheet).getByRole("button", { name: "Save notes" }));

      await waitFor(() => expect(patches).toHaveLength(1));
      expect(patches[0]).toEqual({
        version: 1,
        notes: "Review the caching chapter\nAsk about on-call",
      });
      const patch = callsTo(api, "PATCH", "/api/v1/interviews/i3")[0];
      expect(patch?.headers.get("X-Offerbound-Request")).toBe("1");
      expect(await screen.findByText("Saved prep notes")).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      // the list is read again
      await waitFor(() =>
        expect(callsTo(api, "GET", "/api/v1/interviews").length).toBeGreaterThan(1),
      );
    });

    it("clearing the notes sends null", async () => {
      const patches: Record<string, unknown>[] = [];
      const { user } = setup({
        "PATCH /api/v1/interviews/i3": async (req) => {
          patches.push((await req.clone().json()) as Record<string, unknown>);
          return { ...ARBOR, version: 2, notes: null };
        },
      });
      await screen.findByText("12:00–13:30");
      await user.click(rowOf("12:00–13:30").getByRole("button", { name: "Prep notes" }));
      const sheet = await screen.findByRole("dialog", { name: "Prep notes" });
      setValue(within(sheet).getByRole("textbox", { name: "Prep notes" }), "");
      await user.click(within(sheet).getByRole("button", { name: "Save notes" }));
      await waitFor(() => expect(patches).toEqual([{ version: 1, notes: null }]));
    });

    it("a 409 keeps the sheet and the typing, fetches the interview again and the next try carries the fresh version", async () => {
      let current = ARBOR;
      const patches: Record<string, unknown>[] = [];
      const { user } = setup({
        "GET /api/v1/interviews": interviewsHandler(() => [current, KESTREL]),
        "PATCH /api/v1/interviews/i3": async (req) => {
          const body = (await req.clone().json()) as { version: number; notes: string };
          patches.push(body);
          if (body.version === 1) {
            // someone moved the interview in the meantime
            current = { ...ARBOR, version: 2, startsAt: "2026-11-04T19:00:00Z" };
            return apiError(409, "version_conflict", "Changed elsewhere.");
          }
          return { ...current, version: 3, notes: body.notes };
        },
      });
      await screen.findByText("12:00–13:30");
      await user.click(rowOf("12:00–13:30").getByRole("button", { name: "Prep notes" }));
      const sheet = await screen.findByRole("dialog", { name: "Prep notes" });
      setValue(within(sheet).getByRole("textbox", { name: "Prep notes" }), "My notes");
      await user.click(within(sheet).getByRole("button", { name: "Save notes" }));

      expect(
        await within(sheet).findByText(
          /Changes were made elsewhere\. The interview has been refreshed/,
        ),
      ).toBeInTheDocument();
      expect(within(sheet).getByRole("textbox", { name: "Prep notes" })).toHaveValue("My notes");
      // the list shows the move
      expect(await screen.findByText("13:00–13:30")).toBeInTheDocument();

      await user.click(within(sheet).getByRole("button", { name: "Save notes" }));
      await waitFor(() => expect(patches).toHaveLength(2));
      expect(patches[1]).toEqual({ version: 2, notes: "My notes" });
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    it("any other failure keeps the sheet and says so", async () => {
      const { user } = setup({
        "PATCH /api/v1/interviews/i3": () => apiError(500, "internal_error", "Something broke."),
      });
      await screen.findByText("12:00–13:30");
      await user.click(rowOf("12:00–13:30").getByRole("button", { name: "Prep notes" }));
      const sheet = await screen.findByRole("dialog", { name: "Prep notes" });
      setValue(within(sheet).getByRole("textbox", { name: "Prep notes" }), "More");
      await user.click(within(sheet).getByRole("button", { name: "Save notes" }));
      expect(await within(sheet).findByRole("alert")).toHaveTextContent(
        "Couldn't save your notes.",
      );
      expect(within(sheet).getByRole("textbox", { name: "Prep notes" })).toHaveValue("More");
    });

    describe("unsaved typing", () => {
      async function openDirty(user: ReturnType<typeof userEvent.setup>) {
        await screen.findByText("12:00–13:30");
        await user.click(rowOf("12:00–13:30").getByRole("button", { name: "Prep notes" }));
        const sheet = await screen.findByRole("dialog", { name: "Prep notes" });
        setValue(within(sheet).getByRole("textbox", { name: "Prep notes" }), "Unsaved thought");
        return sheet;
      }

      it("Cancel asks 'Discard changes?'; Keep editing leaves the sheet and the typing alone", async () => {
        const { api, user } = setup();
        const sheet = await openDirty(user);
        await user.click(within(sheet).getByRole("button", { name: "Cancel" }));
        const ask = await screen.findByRole("dialog", { name: "Discard changes?" });
        await user.click(within(ask).getByRole("button", { name: "Keep editing" }));
        await waitFor(() =>
          expect(
            screen.queryByRole("dialog", { name: "Discard changes?" }),
          ).not.toBeInTheDocument(),
        );
        expect(screen.getByRole("textbox", { name: "Prep notes" })).toHaveValue("Unsaved thought");

        await user.click(screen.getByRole("button", { name: "Cancel" }));
        await user.click(
          within(await screen.findByRole("dialog", { name: "Discard changes?" })).getByRole(
            "button",
            { name: "Discard" },
          ),
        );
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        expect(callsTo(api, "PATCH", "/api/v1/interviews/i3")).toHaveLength(0);
      });

      it("Esc, a click outside and the close button ask too", async () => {
        const { user } = setup();
        const sheet = await openDirty(user);
        await user.keyboard("{Escape}");
        expect(await screen.findByRole("dialog", { name: "Discard changes?" })).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Keep editing" }));
        await waitFor(() =>
          expect(
            screen.queryByRole("dialog", { name: "Discard changes?" }),
          ).not.toBeInTheDocument(),
        );

        const backdrop = document.querySelector(".MuiDrawer-root > .MuiBackdrop-root");
        if (!backdrop) throw new Error("no backdrop");
        await user.click(backdrop);
        expect(await screen.findByRole("dialog", { name: "Discard changes?" })).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Keep editing" }));
        await waitFor(() =>
          expect(
            screen.queryByRole("dialog", { name: "Discard changes?" }),
          ).not.toBeInTheDocument(),
        );

        await user.click(within(sheet).getByRole("button", { name: "Close" }));
        expect(await screen.findByRole("dialog", { name: "Discard changes?" })).toBeInTheDocument();
      });

      it("a sheet with nothing typed closes without asking, by Cancel, Esc or a click outside", async () => {
        const { user } = setup();
        await screen.findByText("12:00–13:30");
        const open = async () => {
          await user.click(rowOf("12:00–13:30").getByRole("button", { name: "Prep notes" }));
          return screen.findByRole("dialog", { name: "Prep notes" });
        };
        let sheet = await open();
        await user.click(within(sheet).getByRole("button", { name: "Cancel" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

        sheet = await open();
        await user.keyboard("{Escape}");
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

        await open();
        const backdrop = document.querySelector(".MuiDrawer-root > .MuiBackdrop-root");
        if (!backdrop) throw new Error("no backdrop");
        await user.click(backdrop);
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        expect(screen.queryByRole("dialog", { name: "Discard changes?" })).not.toBeInTheDocument();
      });
    });
  });

  // Every test here opens a dialog with ten MUI fields: heavy under jsdom (see heavyIt).
  describe("Add interview (AC-8.4, 8.5)", () => {
    async function openDialog(user: ReturnType<typeof userEvent.setup>) {
      await screen.findByText("Friday, October 30");
      await user.click(screen.getByRole("button", { name: "Add interview" }));
      return screen.findByRole("dialog", { name: "Add interview" });
    }

    heavyIt(
      "Add interview opens a dialog with an application picker and posts /applications/:id/interviews",
      async () => {
        const posted: { id: string; body: unknown }[] = [];
        const { api, user } = setup({
          "POST /api/v1/applications/a1/interviews": async (req) => {
            posted.push({
              id: new URL(req.url).pathname,
              body: await req.clone().json(),
            });
            return new Response(JSON.stringify({ ...KESTREL, id: "i-new" }), {
              status: 201,
              headers: { "Content-Type": "application/json" },
            });
          },
        });
        const dialog = await openDialog(user);

        // the picker lists applications to choose from, and nothing is chosen yet
        const picker = await within(dialog).findByRole("radiogroup", { name: "Application" });
        expect(within(picker).getAllByRole("radio")).toHaveLength(3);
        expect(within(picker).getByRole("radio", { name: /Kestrel Pay/ })).not.toBeChecked();
        expect(
          callsTo(api, "GET", "/api/v1/applications").every(
            (c) => new URL(c.url).searchParams.get("sort") === "last_activity",
          ),
        ).toBe(true);

        await user.click(within(picker).getByRole("radio", { name: /Kestrel Pay/ }));
        await user.click(within(dialog).getByRole("combobox", { name: "Kind of interview" }));
        await user.click(await screen.findByRole("option", { name: "System design" }));
        setValue(within(dialog).getByLabelText("Date"), "2026-11-05");
        setValue(within(dialog).getByLabelText("Start time"), "10:00");
        setValue(within(dialog).getByLabelText("End time"), "11:00");
        setValue(within(dialog).getByLabelText("Interviewers"), "Priya Natarajan,  Tom Salas, ");
        setValue(within(dialog).getByLabelText("Call link"), "https://meet.example/k2");
        setValue(within(dialog).getByLabelText("Location"), "Room 4");
        setValue(within(dialog).getByLabelText("Prep notes"), "Bring the architecture diagram");
        await user.click(within(dialog).getByRole("button", { name: "Add interview" }));

        await waitFor(() => expect(posted).toHaveLength(1));
        expect(posted[0]?.body).toEqual({
          kind: "system_design",
          status: "scheduled",
          // 10:00 and 11:00 in Monterrey, UTC-6
          startsAt: "2026-11-05T16:00:00.000Z",
          endsAt: "2026-11-05T17:00:00.000Z",
          meetingUrl: "https://meet.example/k2",
          location: "Room 4",
          interviewers: ["Priya Natarajan", "Tom Salas"],
          notes: "Bring the architecture diagram",
        });
        const post = callsTo(api, "POST", "/api/v1/applications/a1/interviews")[0];
        expect(post?.headers.get("X-Offerbound-Request")).toBe("1");
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        expect(await screen.findByText("Added interview for Kestrel Pay")).toBeInTheDocument();
        // the list is read again
        await waitFor(() =>
          expect(callsTo(api, "GET", "/api/v1/interviews").length).toBeGreaterThan(1),
        );
      },
    );

    heavyIt(
      "without a date the interview is to schedule, and empty fields are sent as null",
      async () => {
        const posted: unknown[] = [];
        const { user } = setup({
          "POST /api/v1/applications/a2/interviews": async (req) => {
            posted.push(await req.clone().json());
            return new Response(JSON.stringify({ ...TO_SCHEDULE, id: "i-new" }), {
              status: 201,
              headers: { "Content-Type": "application/json" },
            });
          },
        });
        const dialog = await openDialog(user);
        await user.click(await within(dialog).findByRole("radio", { name: /Meridian Freight/ }));
        await user.click(within(dialog).getByRole("button", { name: "Add interview" }));
        await waitFor(() => expect(posted).toHaveLength(1));
        expect(posted[0]).toEqual({
          kind: "other",
          status: "to_schedule",
          startsAt: null,
          endsAt: null,
          meetingUrl: null,
          location: null,
          interviewers: [],
          notes: null,
        });
      },
    );

    heavyIt("the picker searches applications", async () => {
      const { api, user } = setup();
      const dialog = await openDialog(user);
      await within(dialog).findByRole("radiogroup", { name: "Application" });
      await user.type(
        within(dialog).getByRole("searchbox", { name: "Find an application" }),
        "lum",
      );
      await waitFor(() =>
        expect(
          callsTo(api, "GET", "/api/v1/applications").some(
            (c) => new URL(c.url).searchParams.get("q") === "lum",
          ),
        ).toBe(true),
      );
    });

    heavyIt(
      "asks for the application, a start time that goes with the date, a real link and an end after the start",
      async () => {
        const { api, user } = setup();
        const dialog = await openDialog(user);
        await within(dialog).findByRole("radiogroup", { name: "Application" });

        await user.click(within(dialog).getByRole("button", { name: "Add interview" }));
        expect(
          within(dialog).getByText("Pick the application this interview is for"),
        ).toBeInTheDocument();

        await user.click(within(dialog).getByRole("radio", { name: /Kestrel Pay/ }));
        setValue(within(dialog).getByLabelText("Date"), "2026-11-05");
        setValue(within(dialog).getByLabelText("Call link"), "javascript:alert(1)");
        await user.click(within(dialog).getByRole("button", { name: "Add interview" }));
        expect(within(dialog).getByText("Enter the start time")).toBeInTheDocument();
        expect(
          within(dialog).getByText("Enter a link that starts with http or https"),
        ).toBeInTheDocument();

        setValue(within(dialog).getByLabelText("Call link"), "");
        setValue(within(dialog).getByLabelText("Start time"), "11:00");
        setValue(within(dialog).getByLabelText("End time"), "10:00");
        await user.click(within(dialog).getByRole("button", { name: "Add interview" }));
        expect(within(dialog).getByText("The end must be after the start")).toBeInTheDocument();

        setValue(within(dialog).getByLabelText("Start time"), "");
        setValue(within(dialog).getByLabelText("End time"), "");
        setValue(within(dialog).getByLabelText("Date"), "");
        setValue(within(dialog).getByLabelText("Start time"), "10:00");
        await user.click(within(dialog).getByRole("button", { name: "Add interview" }));
        expect(within(dialog).getByText("Pick the date")).toBeInTheDocument();
        expect(callsTo(api, "POST", "/api/v1/applications/a1/interviews")).toHaveLength(0);
      },
    );

    heavyIt("shows the server's field errors and keeps the dialog", async () => {
      const { user } = setup({
        "POST /api/v1/applications/a1/interviews": () =>
          apiError(422, "validation_failed", "Check the details.", { meetingUrl: "Not a link" }),
      });
      const dialog = await openDialog(user);
      await user.click(await within(dialog).findByRole("radio", { name: /Kestrel Pay/ }));
      await user.click(within(dialog).getByRole("button", { name: "Add interview" }));
      expect(await within(dialog).findByText("Not a link")).toBeInTheDocument();
      expect(screen.getByRole("dialog", { name: "Add interview" })).toBeInTheDocument();
    });

    heavyIt("shows a server error on startsAt or endsAt under the time fields", async () => {
      const { user } = setup({
        "POST /api/v1/applications/a1/interviews": () =>
          apiError(422, "validation_failed", "Check the details.", {
            startsAt: "The start is in the past",
            endsAt: "The end is too far away",
          }),
      });
      const dialog = await openDialog(user);
      await user.click(await within(dialog).findByRole("radio", { name: /Kestrel Pay/ }));
      await user.click(within(dialog).getByRole("button", { name: "Add interview" }));
      expect(await within(dialog).findByText("The start is in the past")).toBeInTheDocument();
      expect(within(dialog).getByText("The end is too far away")).toBeInTheDocument();
      // a field carries the message, so there is no second, generic alert
      expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    });

    heavyIt(
      "a server error for a field the dialog does not have still shows an alert",
      async () => {
        const { user } = setup({
          "POST /api/v1/applications/a1/interviews": () =>
            apiError(422, "validation_failed", "Check the details.", { status: "Not allowed" }),
        });
        const dialog = await openDialog(user);
        await user.click(await within(dialog).findByRole("radio", { name: /Kestrel Pay/ }));
        await user.click(within(dialog).getByRole("button", { name: "Add interview" }));
        expect(await within(dialog).findByRole("alert")).toHaveTextContent(
          "Couldn't add the interview. Check the details.",
        );
        expect(screen.getByRole("dialog", { name: "Add interview" })).toBeInTheDocument();
      },
    );

    heavyIt(
      "Esc and a click outside do not close it while the interview is being added",
      async () => {
        const { user } = setup({
          "POST /api/v1/applications/a1/interviews": () => new Promise(() => undefined),
        });
        const dialog = await openDialog(user);
        await user.click(await within(dialog).findByRole("radio", { name: /Kestrel Pay/ }));
        await user.click(within(dialog).getByRole("button", { name: "Add interview" }));
        await waitFor(() =>
          expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled(),
        );
        await user.keyboard("{Escape}");
        const backdrop = document.querySelector(".MuiDialog-container");
        if (!backdrop) throw new Error("no backdrop");
        await user.click(backdrop);
        // a closing dialog stays in the DOM for its exit transition (225 ms): wait it out
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(screen.getByRole("dialog", { name: "Add interview" })).toBeInTheDocument();
      },
    );

    heavyIt("is full screen on a phone, and Cancel closes it", async () => {
      const { user } = setup({}, { width: 390 });
      const dialog = await openDialog(user);
      expect(dialog.closest(".MuiDialog-paper")).toHaveClass("MuiDialog-paperFullScreen");
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });
  });

  describe("keyboard (DESIGN_SPEC §9.3)", () => {
    it("j and k move between interviews, Enter opens the application", async () => {
      const { user } = setup();
      await screen.findByText("Friday, October 30");
      await user.keyboard("j");
      // the band comes first, so the first interview is the one to schedule
      expect(screen.getByText("No time yet").closest("li")).toHaveAttribute("aria-current", "true");
      await user.keyboard("j");
      expect(screen.getByText("10:00–11:00").closest("li")).toHaveAttribute("aria-current", "true");
      await user.keyboard("k");
      expect(screen.getByText("No time yet").closest("li")).toHaveAttribute("aria-current", "true");
      await user.keyboard("{Enter}");
      expect(await screen.findByText("Application page")).toBeInTheDocument();
      expect(screen.getByTestId("where")).toHaveTextContent("/applications/a2");
    });

    heavyIt("keys do nothing while typing in the dialog", async () => {
      const { user } = setup();
      await screen.findByText("Friday, October 30");
      await user.click(screen.getByRole("button", { name: "Add interview" }));
      const dialog = await screen.findByRole("dialog", { name: "Add interview" });
      await user.type(within(dialog).getByRole("searchbox", { name: "Find an application" }), "jj");
      expect(document.querySelector("[aria-current='true']")).toBeNull();
    });
  });

  describe("phones (DESIGN_SPEC §9.4)", () => {
    it("tabs and Add interview are at least 44px tall below 600px", async () => {
      setup({}, { width: 390 });
      await screen.findByText("Friday, October 30");
      expect(screen.getByRole("tab", { name: /^Upcoming/ })).toHaveStyle({ minHeight: "44px" });
      expect(screen.getByRole("tab", { name: "Past" })).toHaveStyle({ minHeight: "44px" });
      expect(screen.getByRole("button", { name: "Add interview" })).toHaveStyle({
        minHeight: "44px",
      });
    });

    it("row actions move into a menu below 600px", async () => {
      const { user } = setup({}, { width: 390 });
      await screen.findByText("Friday, October 30");
      const row = rowOf("10:00–11:00");
      expect(row.queryByRole("button", { name: "Prep notes" })).not.toBeInTheDocument();
      await user.click(row.getByRole("button", { name: "More actions" }));
      expect(await screen.findByRole("menuitem", { name: "Prep notes" })).toBeInTheDocument();
      expect(screen.getByRole("menuitem", { name: "Open application" })).toBeInTheDocument();
    });

    it("the call link is 44px tall", async () => {
      setup({}, { width: 390 });
      await screen.findByText("Friday, October 30");
      expect(rowOf("10:00–11:00").getByRole("link", { name: "Join video call" })).toHaveStyle({
        minHeight: "44px",
      });
    });
  });
});
