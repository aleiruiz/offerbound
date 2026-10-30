import type { ApplicationDetail, DailyActivityBody, Lead, Today } from "@offerbound/contracts";
import { DEFAULT_SETTINGS } from "@offerbound/contracts";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeApplication,
  makeInterview,
  makeLead,
  makeSyncStatus,
  makeToday,
} from "../../test/factories";
import {
  apiError,
  jsonResponse,
  mockApi,
  type MockApi,
  type MockHandler,
} from "../../test/mock-api";
import { renderWithProviders } from "../../test/render";
import { queryKeys } from "../api/hooks";
import { UndoSnackbar } from "../components/UndoSnackbar";
import { TodayPage } from "./TodayPage";

const ME = {
  mode: "private",
  email: "owner@example.test",
  onboardingCompleted: true,
  timezone: "America/Monterrey",
};

type Routes = Record<string, MockHandler>;

function setup(routes: Routes = {}, width?: number) {
  const api: MockApi = mockApi({
    "GET /api/v1/me": () => ME,
    "GET /api/v1/today": () => makeToday(),
    "GET /api/v1/gmail/status": () => makeSyncStatus(),
    "GET /api/v1/settings": () => DEFAULT_SETTINGS,
    ...routes,
  });
  // The shell mounts the snackbar; the page alone does not.
  const rendered = renderWithProviders(
    <>
      <TodayPage />
      <UndoSnackbar />
    </>,
    { route: "/today", width },
  );
  return { api, ...rendered, user: userEvent.setup() };
}

const callsTo = (api: MockApi, method: string, path: string) =>
  api.calls.filter((c) => c.method === method && new URL(c.url).pathname === path);

/** The page has its data once the header has the date. */
const loaded = () => screen.findByText("Thursday, October 29");

const section = (name: string) => screen.getByRole("region", { name });

const SECTIONS = [
  "Pipeline",
  "Today's targets",
  "Follow-ups due",
  "Needs your review",
  "Top new leads",
  "Next 7 days",
] as const;

function detailOf(id: string): ApplicationDetail {
  return {
    ...makeApplication({ id, followUpDue: false }),
    jobUrl: null,
    locationText: null,
    compensationText: null,
    sponsorshipText: null,
    notes: null,
    leadId: null,
    interviews: [],
    messages: [],
    timeline: [],
  };
}

const RUN = {
  id: "s1",
  trigger: "manual",
  status: "running",
  startedAt: "2026-10-29T18:00:00Z",
  finishedAt: null,
  rounds: 0,
  returned: 0,
  accepted: 0,
  suppressed: 0,
  duplicates: 0,
  dead: 0,
  webSearchCalls: 0,
  costMicros: null,
  error: null,
};

beforeEach(() => {
  // 2026-10-29 12:00 in Monterrey, so "9 days" since Oct 20 is stable.
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-29T18:00:00Z") });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("TodayPage", () => {
  it("renders pipeline, targets, follow-ups due, needs your review, top new leads and next 7 days in that order", async () => {
    setup();
    await screen.findByText("Thursday, October 29");
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual([...SECTIONS]);

    expect(screen.getByRole("heading", { level: 1, name: "Today" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run search now" })).toBeInTheDocument();

    // Pipeline: stops link to Applications by stage; one caption line with totals and rates.
    const pipeline = section("Pipeline");
    expect(
      within(pipeline).getByText(
        "41 applications. Response rate 46%. Reached screening or later 20%.",
      ),
    ).toBeInTheDocument();
    expect(within(pipeline).getByRole("link", { name: /^12\s*Applied$/ })).toHaveAttribute(
      "href",
      "/applications?status=applied",
    );
    expect(within(pipeline).getByText("Rejected 17")).toBeInTheDocument();

    // Targets: five meters.
    const targets = section("Today's targets");
    for (const name of ["Applications", "New leads", "Outreach", "Follow-ups", "Interview prep"]) {
      expect(within(targets).getByRole("progressbar", { name })).toBeInTheDocument();
    }
    expect(within(targets).getByRole("progressbar", { name: "Applications" })).toHaveAttribute(
      "aria-valuenow",
      "3",
    );
    expect(within(targets).getByText("of 8–12")).toBeInTheDocument();
    expect(
      within(targets).getByText("Counts reset at midnight, Monterrey time"),
    ).toBeInTheDocument();

    // Follow-ups: the reason in plain words, Open links, the abandon rule.
    const followUps = section("Follow-ups due");
    expect(
      within(followUps).getByText(
        "Senior Full-stack Engineer. Applied Oct 20, no reply for 9 days.",
      ),
    ).toBeInTheDocument();
    expect(within(followUps).getAllByRole("link", { name: "Open" })[0]).toHaveAttribute(
      "href",
      "/applications/a1",
    );
    expect(
      within(followUps).getByText(/After 14 days without a reply, an application is marked/),
    ).toBeInTheDocument();

    // Review: the first items and a link to the queue.
    const review = section("Needs your review");
    expect(within(review).getByText("Is this a rejection from Quarry AI?")).toBeInTheDocument();
    expect(
      within(review).getByText(/Would change Assessment to Rejected\. Confidence 64%/),
    ).toBeInTheDocument();
    expect(within(review).getByRole("link", { name: "Open review queue" })).toHaveAttribute(
      "href",
      "/review",
    );

    // Leads: the same row anatomy as the Leads page.
    const leads = section("Top new leads");
    expect(within(leads).getByText("Tidewater Labs")).toBeInTheDocument();
    expect(within(leads).getByRole("button", { name: "Shortlist" })).toBeInTheDocument();
    expect(within(leads).getByRole("link", { name: "See all new leads" })).toHaveAttribute(
      "href",
      "/leads",
    );

    // Interviews: in the side column.
    const agenda = section("Next 7 days");
    expect(agenda.closest("aside")).not.toBeNull();
    expect(within(agenda).getByText("10:00–11:00")).toBeInTheDocument();
    expect(within(agenda).getByText("Fri, Oct 30")).toBeInTheDocument();
    expect(within(agenda).getByRole("link", { name: "Join video call" })).toHaveAttribute(
      "href",
      "https://meet.example/kestrel",
    );
  });

  it("+1 outreach and +15, +30 and +60 prep post /daily-activity and update the meter", async () => {
    let outreach = 2;
    let prep = 30;
    const { api, user } = setup({
      "POST /api/v1/daily-activity": async (req) => {
        const body = (await req.clone().json()) as DailyActivityBody;
        if (body.kind === "outreach") outreach += body.amount;
        else prep += body.amount;
        return { date: "2026-10-29", outreach, prepMinutes: prep, followUps: 1 };
      },
    });
    await loaded();
    const targets = section("Today's targets");
    const meter = (name: string) => within(targets).getByRole("progressbar", { name });
    expect(meter("Outreach")).toHaveAttribute("aria-valuenow", "2");

    await user.click(within(targets).getByRole("button", { name: "+1 message" }));
    await waitFor(() => expect(meter("Outreach")).toHaveAttribute("aria-valuenow", "3"));

    for (const [minutes, total] of [
      [15, 45],
      [30, 75],
      [60, 135],
    ] as const) {
      await user.click(within(targets).getByRole("button", { name: `+${minutes} minutes` }));
      await waitFor(() =>
        expect(meter("Interview prep")).toHaveAttribute("aria-valuenow", String(total)),
      );
    }

    const bodies = await Promise.all(
      callsTo(api, "POST", "/api/v1/daily-activity").map((c) => c.json()),
    );
    expect(bodies).toEqual([
      { kind: "outreach", amount: 1 },
      { kind: "prep_minutes", amount: 15 },
      { kind: "prep_minutes", amount: 30 },
      { kind: "prep_minutes", amount: 60 },
    ]);
    expect(
      callsTo(api, "POST", "/api/v1/daily-activity")[0]?.headers.get("X-Offerbound-Request"),
    ).toBe("1");
    // New leads and, now, interview prep are at or above their targets.
    expect(within(targets).getAllByText("Target met")).toHaveLength(2);
  });

  it("says so when logging fails, and leaves the count alone", async () => {
    const { user } = setup({
      "POST /api/v1/daily-activity": () =>
        apiError(502, "upstream_error", "The database didn't answer."),
    });
    await loaded();
    const targets = section("Today's targets");
    await user.click(within(targets).getByRole("button", { name: "+1 message" }));
    expect(await within(targets).findByRole("alert")).toHaveTextContent("Couldn't log that.");
    expect(within(targets).getByRole("progressbar", { name: "Outreach" })).toHaveAttribute(
      "aria-valuenow",
      "2",
    );
  });

  it("Mark followed up posts /applications/:id/follow-up-done and shows 'Marked as followed up'", async () => {
    let done = false;
    const { api, user } = setup({
      "GET /api/v1/today": () =>
        makeToday(
          done ? { followUpsDue: makeToday().followUpsDue.filter((a) => a.id !== "a1") } : {},
        ),
      "POST /api/v1/applications/a1/follow-up-done": () => {
        done = true;
        return detailOf("a1");
      },
    });
    await loaded();
    const followUps = section("Follow-ups due");
    expect(within(followUps).getByText("Northwind Robotics")).toBeInTheDocument();
    await user.click(
      within(followUps).getAllByRole("button", { name: "Mark followed up" })[0] as HTMLElement,
    );

    expect(await screen.findByText("Marked as followed up")).toBeInTheDocument();
    expect(callsTo(api, "POST", "/api/v1/applications/a1/follow-up-done")).toHaveLength(1);
    await waitFor(() =>
      expect(within(followUps).queryByText("Northwind Robotics")).not.toBeInTheDocument(),
    );
    expect(within(followUps).getByText("Caldera Energy")).toBeInTheDocument();
  });

  describe("Run search now", () => {
    it("posts /search/run", async () => {
      const { api, user } = setup({ "POST /api/v1/search/run": () => jsonResponse(RUN, 202) });
      await loaded();
      await user.click(screen.getByRole("button", { name: "Run search now" }));
      expect(await screen.findByText("Search started")).toBeInTheDocument();
      expect(callsTo(api, "POST", "/api/v1/search/run")).toHaveLength(1);
    });

    it("shows 'A search is already running' on 409 already_running", async () => {
      const { user } = setup({
        "POST /api/v1/search/run": () =>
          apiError(409, "already_running", "A search run is already in progress."),
      });
      await loaded();
      await user.click(screen.getByRole("button", { name: "Run search now" }));
      expect(await screen.findByText("A search is already running")).toBeInTheDocument();
    });
  });

  describe("Top new leads", () => {
    it("Dismiss patches the lead with its version, says so, and Undo puts it back to new", async () => {
      const dismissed: Lead = makeLead({ status: "dismissed", version: 2 });
      const { api, user } = setup({
        "PATCH /api/v1/leads/l1": async (req) => {
          const body = (await req.clone().json()) as { status: string };
          return body.status === "dismissed" ? dismissed : makeLead({ version: 3 });
        },
      });
      await loaded();
      const leads = section("Top new leads");
      await user.click(within(leads).getByRole("button", { name: "Dismiss lead" }));
      expect(await screen.findByText("Dismissed Tidewater Labs")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Undo" }));
      expect(await screen.findByText("Undone")).toBeInTheDocument();

      const patches = callsTo(api, "PATCH", "/api/v1/leads/l1");
      expect(await Promise.all(patches.map((p) => p.json()))).toEqual([
        { version: 1, status: "dismissed" },
        { version: 2, status: "new" },
      ]);
    });

    it("Shortlist patches the lead and says 'Shortlisted Tidewater Labs'", async () => {
      const { api, user } = setup({
        "PATCH /api/v1/leads/l1": () => makeLead({ status: "shortlisted", version: 2 }),
      });
      await loaded();
      const leads = section("Top new leads");
      await user.click(within(leads).getByRole("button", { name: "Shortlist" }));
      expect(await screen.findByText("Shortlisted Tidewater Labs")).toBeInTheDocument();
      expect(await callsTo(api, "PATCH", "/api/v1/leads/l1")[0]?.json()).toEqual({
        version: 1,
        status: "shortlisted",
      });
    });
  });

  describe("states (DESIGN_SPEC §7)", () => {
    it("each section shows a skeleton while loading", async () => {
      setup({ "GET /api/v1/today": () => new Promise<never>(() => undefined) });
      for (const name of SECTIONS) {
        const region = await screen.findByRole("region", { name });
        expect(
          within(region).getByRole("status", {
            name: new RegExp(`^Loading ${name.toLowerCase()}`),
          }),
        ).toHaveAttribute("aria-busy", "true");
      }
      expect(screen.getByRole("heading", { level: 1, name: "Today" })).toBeInTheDocument();
    });

    it("each section shows its own empty line", async () => {
      setup({
        "GET /api/v1/settings": () => ({
          ...DEFAULT_SETTINGS,
          search: { ...DEFAULT_SETTINGS.search, enabled: true, runTime: "07:00" },
        }),
        "GET /api/v1/today": () =>
          makeToday({
            followUpsDue: [],
            upcomingInterviews: [],
            topLeads: [],
            review: { open: 0, first: [] },
            pipeline: {
              byStatus: Object.fromEntries(
                Object.keys(makeToday().pipeline.byStatus).map((status) => [status, 0]),
              ) as Today["pipeline"]["byStatus"],
              responseRate: 0,
              interviewRate: 0,
            },
          }),
      });
      await screen.findByRole("heading", { level: 2, name: "Pipeline" });
      await waitFor(() =>
        expect(
          within(section("Pipeline")).getByText(
            (_, el) => el?.tagName === "P" && !!el.textContent?.startsWith("No applications yet."),
          ),
        ).toBeInTheDocument(),
      );
      expect(
        within(section("Follow-ups due")).getByText(
          "No follow-ups due. Applications without a reply for 7 days show up here.",
        ),
      ).toBeInTheDocument();
      expect(
        within(section("Needs your review")).getByText(
          "Nothing to review. Changes Offerbound is sure about are applied on their own.",
        ),
      ).toBeInTheDocument();
      expect(
        within(section("Top new leads")).getByText("No new leads. The next search runs at 07:00."),
      ).toBeInTheDocument();
      expect(
        within(section("Next 7 days")).getByText("No interviews in the next 7 days."),
      ).toBeInTheDocument();
    });

    it("each section shows its own inline error with Try again, and the page still has its header", async () => {
      let healthy = false;
      const { api, user } = setup({
        "GET /api/v1/today": () =>
          healthy ? makeToday() : apiError(503, "not_ready", "The server is starting."),
      });
      for (const name of SECTIONS) {
        const region = await screen.findByRole("region", { name });
        await waitFor(() => expect(within(region).getByRole("alert")).toBeInTheDocument());
        expect(within(region).getByRole("alert")).toHaveTextContent("Couldn't load");
        expect(within(region).getByRole("alert")).toHaveTextContent("The server is starting.");
      }
      expect(screen.getByRole("button", { name: "Run search now" })).toBeInTheDocument();

      healthy = true;
      const before = callsTo(api, "GET", "/api/v1/today").length;
      await user.click(
        within(section("Follow-ups due")).getByRole("button", { name: "Try again" }),
      );
      await waitFor(() => expect(callsTo(api, "GET", "/api/v1/today").length).toBe(before + 1));
      expect(await screen.findByText("Northwind Robotics")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("keeps showing the last answer when a later poll fails", async () => {
      let fail = false;
      const { queryClient } = setup({
        "GET /api/v1/today": () => (fail ? apiError(503, "not_ready", "Not ready.") : makeToday()),
      });
      await screen.findByText("Northwind Robotics");
      fail = true;
      await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.today }));
      expect(screen.getByText("Northwind Robotics")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  it("shows the first-sync progress card while the first backfill runs", async () => {
    setup({
      "GET /api/v1/gmail/status": () =>
        makeSyncStatus({ backfill: { state: "running", listed: 2148, processed: 1204 } }),
    });
    const card = (await screen.findByText("Reading your email")).closest(
      '[role="status"]',
    ) as HTMLElement;
    expect(card).toBeInTheDocument();
    expect(card).toHaveTextContent("1,204 of 2,148 checked.");
    expect(within(card).getByRole("progressbar", { name: "First sync" })).toHaveAttribute(
      "aria-valuenow",
      "56",
    );
  });

  it("has no first-sync card once the first sync is done", async () => {
    setup();
    await screen.findByText("Northwind Robotics");
    expect(screen.queryByRole("progressbar", { name: "First sync" })).not.toBeInTheDocument();
  });

  it("shows dates and times in the owner's time zone from /me", async () => {
    setup({
      "GET /api/v1/me": () => ({ ...ME, timezone: "Asia/Tokyo" }),
      "GET /api/v1/today": () =>
        makeToday({
          upcomingInterviews: [
            makeInterview({ startsAt: "2026-10-30T16:00:00Z", endsAt: "2026-10-30T17:00:00Z" }),
          ],
        }),
    });
    await loaded();
    const agenda = section("Next 7 days");
    await waitFor(() => expect(within(agenda).getByText("01:00–02:00")).toBeInTheDocument());
    expect(within(agenda).getByText("Sat, Oct 31")).toBeInTheDocument();
    expect(screen.getByText("Counts reset at midnight, Tokyo time")).toBeInTheDocument();
  });

  it("puts interviews to schedule on the signal band, and links only http(s) addresses", async () => {
    setup({
      "GET /api/v1/today": () =>
        makeToday({
          upcomingInterviews: [
            makeInterview({ id: "i1", meetingUrl: "javascript:alert(1)" }),
            makeInterview({
              id: "i2",
              kind: "hiring_manager",
              status: "to_schedule",
              startsAt: null,
              endsAt: null,
              meetingUrl: null,
              schedulingUrl: "https://schedule.example/pick",
              application: makeApplication({
                id: "a9",
                company: { id: "c9", name: "Meridian Freight" },
                title: "Tech Lead, Web",
              }),
            }),
          ],
        }),
    });
    await loaded();
    const agenda = section("Next 7 days");
    await within(agenda).findByText("Technical interview");
    expect(within(agenda).queryByRole("link", { name: "Join video call" })).not.toBeInTheDocument();
    const band = within(agenda).getByText("To schedule").closest("li") as HTMLElement;
    expect(within(band).getByText("Hiring manager interview")).toBeInTheDocument();
    expect(within(band).getByText("Meridian Freight, Tech Lead, Web")).toBeInTheDocument();
    expect(within(band).getByRole("link", { name: "Pick a time" })).toHaveAttribute(
      "href",
      "https://schedule.example/pick",
    );
  });

  describe("the pipeline marker (DESIGN_SPEC §8)", () => {
    const counts = (over: Partial<Record<string, number>>): Today =>
      makeToday({
        pipeline: {
          ...makeToday().pipeline,
          byStatus: { ...makeToday().pipeline.byStatus, ...over },
        },
      });

    it("when a poll moves exactly one application between stages, the pipeline marker animates from the old stage to the new", async () => {
      vi.useRealTimers();
      const frames: FrameRequestCallback[] = [];
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => frames.push(cb));
      const flush = () =>
        act(() => {
          frames.splice(0).forEach((cb) => cb(0));
        });

      let answer: Today = counts({});
      const { queryClient } = setup({ "GET /api/v1/today": () => answer });
      await screen.findByText(
        "41 applications. Response rate 46%. Reached screening or later 20%.",
      );
      // The first load is not a movement.
      expect(screen.queryByTestId("route-marker")).not.toBeInTheDocument();

      // Applied 12 -> 11, Screening 3 -> 4.
      answer = counts({ applied: 11, screening: 4 });
      await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.today }));
      const marker = await screen.findByTestId("route-marker");
      expect(marker).toHaveAttribute("data-stop", "screening");
      expect(marker.style.left).toBe("10%");
      flush();
      expect(screen.getByTestId("route-marker").style.left).toBe("30%");

      // Then Assessment 2 -> 1, Interviewing 3 -> 4: the second marker starts at Assessment, not at Screening.
      answer = counts({ applied: 11, screening: 4, assessment: 1, interviewing: 4 });
      await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.today }));
      await waitFor(() =>
        expect(screen.getByTestId("route-marker")).toHaveAttribute("data-stop", "interviewing"),
      );
      expect(screen.getByTestId("route-marker").style.left).toBe("50%");
      flush();
      expect(screen.getByTestId("route-marker").style.left).toBe("70%");
    });

    it("does not animate when two applications moved in one poll", async () => {
      vi.useRealTimers();
      let answer: Today = counts({});
      const { queryClient } = setup({ "GET /api/v1/today": () => answer });
      await screen.findByText(
        "41 applications. Response rate 46%. Reached screening or later 20%.",
      );
      answer = counts({ applied: 10, screening: 5 });
      await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.today }));
      await waitFor(() =>
        expect(
          within(section("Pipeline")).getByRole("link", { name: /^5\s*Screening$/ }),
        ).toBeInTheDocument(),
      );
      expect(screen.queryByTestId("route-marker")).not.toBeInTheDocument();
    });
  });
});
