import type {
  ApplicationDetail,
  ApplicationPatch,
  Interview,
  MessageSummary,
  TimelineEvent,
} from "@offerbound/contracts";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { QueryClient } from "@tanstack/react-query";
import { Link, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  makeApplication,
  makeApplicationDetail,
  makeEvent,
  makeMessage,
  makeNavCounts,
  makeToday,
} from "../../test/factories";
import { apiError, mockApi, type MockApi, type MockHandler } from "../../test/mock-api";
import { renderWithProviders } from "../../test/render";
import { heavyIt } from "../../test/speed";
import { queryKeys } from "../api/hooks";
import { UndoSnackbar } from "../components/UndoSnackbar";
import { ApplicationDetailPage } from "./ApplicationDetailPage";

// MUI dialogs and menus render slowly under jsdom; a busy machine must not turn that into a failure.
vi.setConfig({ testTimeout: 15_000 });

const ME = {
  mode: "private",
  email: "owner@example.test",
  onboardingCompleted: true,
  timezone: "America/Monterrey",
};

const INTERVIEW: Interview = {
  id: "i1",
  version: 1,
  applicationId: "a1",
  kind: "technical",
  status: "scheduled",
  startsAt: "2099-10-30T16:00:00Z",
  endsAt: "2099-10-30T17:00:00Z",
  timezoneHint: "America/New_York",
  meetingUrl: "https://meet.example/kestrel",
  schedulingUrl: null,
  location: null,
  interviewers: ["Priya Natarajan", "Tom Salas"],
  notes: "Review the checkout flow migration.",
};

const TIMELINE: TimelineEvent[] = [
  makeEvent({
    id: "e-auto",
    type: "status_changed",
    occurredAt: "2026-10-27T20:12:00Z",
    summary: "Moved to Interviewing and added a technical interview.",
    messageId: "m-invite",
    toStatus: "interviewing",
    undoable: true,
  }),
  makeEvent({
    id: "e-stale",
    type: "status_changed",
    occurredAt: "2026-10-21T15:05:00Z",
    summary: "Moved to Screening",
    toStatus: "screening",
    undoable: false,
  }),
  makeEvent({
    id: "e-me",
    type: "lead_converted",
    actor: "owner",
    occurredAt: "2026-10-15T17:32:00Z",
    summary: "You marked the lead as applied",
    undoable: false,
  }),
];

const MESSAGES: MessageSummary[] = [
  {
    id: "m-invite",
    internalDate: "2026-10-27T20:00:00Z",
    direction: "inbound",
    fromName: "Dana Ortiz",
    fromEmail: "dana@kestrel.example",
    subject: "Next steps",
    summary: "Invited you to a technical interview.",
    category: "interview_invite",
  },
];

function detail(overrides: Partial<ApplicationDetail> = {}): ApplicationDetail {
  return makeApplicationDetail({
    id: "a1",
    version: 3,
    company: { id: "c3", name: "Kestrel Pay" },
    title: "Senior Frontend Engineer, Payments",
    status: "interviewing",
    appliedAt: "2026-10-15T17:00:00Z",
    lastCompanyActivityAt: "2026-10-27T20:00:00Z",
    followUpDue: false,
    workMode: "remote",
    source: "lead_conversion",
    jobUrl: "https://jobs.example/kestrel-pay/7f3c9d",
    locationText: "Remote, open to Mexico",
    compensationText: "US$9.5–11k / month",
    notes: "Ask about on-call expectations.",
    interviews: [INTERVIEW],
    messages: MESSAGES,
    timeline: TIMELINE,
    ...overrides,
  });
}

type Routes = Record<string, MockHandler>;

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

function setup(
  routes: Routes = {},
  { route = "/applications/a1", width }: { route?: string; width?: number } = {},
) {
  const api: MockApi = mockApi({
    "GET /api/v1/me": () => ME,
    "GET /api/v1/today": () => makeToday(),
    "GET /api/v1/nav-counts": () => makeNavCounts(),
    "GET /api/v1/applications/a1": () => detail(),
    ...routes,
  });
  const rendered = renderWithProviders(
    <>
      <Routes>
        <Route path="/applications" element={<p>Applications list</p>} />
        <Route path="/applications/:id" element={<ApplicationDetailPage />} />
      </Routes>
      <Where />
      {/* mouse-down is cancelled so the click does not blur the notes field: only the unmount can save */}
      <Link to="/applications" onMouseDown={(e) => e.preventDefault()}>
        Leave
      </Link>
      <UndoSnackbar />
    </>,
    { route, width },
  );
  return { api, ...rendered, user: userEvent.setup({ delay: null }) };
}

/** Screens that are not open keep their cached answers; a change must mark them stale. */
const BADGE_SCREENS = [queryKeys.today, queryKeys.navCounts] as const;
const OTHER_SCREENS = [...BADGE_SCREENS, queryKeys.reviewItems] as const;
function seedOtherScreens(queryClient: QueryClient) {
  for (const key of OTHER_SCREENS) queryClient.setQueryData(key, {});
}
function expectOtherScreensStale(
  queryClient: QueryClient,
  keys: readonly (readonly string[])[] = OTHER_SCREENS,
) {
  for (const key of keys) {
    expect(queryClient.getQueryState(key)?.isInvalidated, key.join("/")).toBe(true);
  }
}

/** Fake only the timers the page uses for autosave; the mock API answers on microtasks. */
function fakeTimers() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
}
/** user-event waits on a timer Testing Library drains with Jest only, so fake-timer tests fire events. */
const write = (field: HTMLElement, value: string) =>
  act(() => {
    fireEvent.change(field, { target: { value } });
  });
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

/**
 * Lets a request that was just sent reach the mock API and be answered. Query and mutation
 * bookkeeping uses short timers, so a few milliseconds of fake time pass as well (well under 800).
 */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(15);
    }
  });

afterEach(() => {
  vi.useRealTimers();
});

const callsTo = (api: MockApi, method: string, path: string) =>
  api.calls.filter((c) => c.method === method && new URL(c.url).pathname === path);

const loaded = () => screen.findByRole("heading", { level: 1, name: "Kestrel Pay" });

describe("ApplicationDetailPage", () => {
  it("shows the company as the title with the role, status and work mode, under a breadcrumb", async () => {
    setup();
    await loaded();
    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(breadcrumb).getByRole("link", { name: "Applications" })).toHaveAttribute(
      "href",
      "/applications",
    );
    expect(within(breadcrumb).getByText("Kestrel Pay")).toBeInTheDocument();
    expect(screen.getByText("Senior Frontend Engineer, Payments")).toBeInTheDocument();
    const header = screen.getByRole("banner");
    expect(header.querySelector('[data-status="interviewing"]')).toHaveTextContent("Interviewing");
    expect(within(header).getByText("Remote")).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("lists the details: posting, location, compensation, applied, last reply and source", async () => {
    setup();
    await loaded();
    const details = screen.getByRole("complementary");
    const section = within(within(details).getByRole("region", { name: "Details" }));
    expect(section.getByRole("link", { name: /jobs\.example\/kestrel-pay/ })).toHaveAttribute(
      "href",
      "https://jobs.example/kestrel-pay/7f3c9d",
    );
    expect(section.getByText("Remote, open to Mexico")).toBeInTheDocument();
    expect(section.getByText("US$9.5–11k / month")).toBeInTheDocument();
    expect(section.getByText("Oct 15")).toBeInTheDocument();
    expect(section.getByText("Oct 27")).toBeInTheDocument();
    expect(section.getByText("Lead from the search")).toBeInTheDocument();
  });

  it("shows the next interview in the owner's zone, with the invite's own zone, interviewers and call link", async () => {
    setup();
    await loaded();
    const next = within(screen.getByRole("region", { name: "Next interview" }));
    expect(next.getByText("Technical interview")).toBeInTheDocument();
    expect(next.getByText("Fri, Oct 30, 10:00–11:00")).toBeInTheDocument();
    expect(
      next.getByText(/Monterrey time\. Invite sent for 12:00–13:00 New York\./),
    ).toBeInTheDocument();
    expect(next.getByText("Priya Natarajan, Tom Salas")).toBeInTheDocument();
    const call = next.getByRole("link", { name: "Join video call" });
    expect(call).toHaveAttribute("href", "https://meet.example/kestrel");
    expect(call).toHaveAttribute("rel", "noopener noreferrer");
    expect(next.getByText("Review the checkout flow migration.")).toBeInTheDocument();
  });

  it("says so when no interview is coming up", async () => {
    setup({ "GET /api/v1/applications/a1": () => detail({ interviews: [] }) });
    await loaded();
    const next = within(screen.getByRole("region", { name: "Next interview" }));
    expect(next.getByText("No interview scheduled.")).toBeInTheDocument();
  });

  it("links the posting and the call only when they are http(s) addresses", async () => {
    setup({
      "GET /api/v1/applications/a1": () =>
        detail({
          jobUrl: "javascript:alert(1)",
          interviews: [{ ...INTERVIEW, meetingUrl: "javascript:alert(2)" }],
        }),
    });
    await loaded();
    expect(screen.queryByRole("link", { name: "Open posting" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Join video call" })).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="javascript"]')).toBeNull();
  });

  it("Open posting opens the posting in a new tab", async () => {
    setup();
    await loaded();
    const open = screen.getByRole("link", { name: "Open posting" });
    expect(open).toHaveAttribute("href", "https://jobs.example/kestrel-pay/7f3c9d");
    expect(open).toHaveAttribute("target", "_blank");
    expect(open).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("lists the linked emails with their summaries", async () => {
    setup();
    await loaded();
    const emails = within(screen.getByRole("region", { name: "Emails" }));
    expect(emails.getByText("Next steps")).toBeInTheDocument();
    expect(emails.getByText("Invited you to a technical interview.")).toBeInTheDocument();
    expect(emails.getByText(/Dana Ortiz/)).toBeInTheDocument();
  });

  // AC-6.3, TECHNICAL_SPEC §11
  // Heavy under jsdom (MUI re-renders on every step); see heavyIt.
  heavyIt(
    "the detail status Select patches with version; 409 version_conflict refetches and shows 'Changes were made elsewhere'",
    async () => {
      let current = detail();
      const patches: ApplicationPatch[] = [];
      const { api, user, queryClient } = setup({
        "GET /api/v1/applications/a1": () => current,
        "PATCH /api/v1/applications/a1": async (req) => {
          const body = (await req.clone().json()) as ApplicationPatch;
          patches.push(body);
          if (patches.length === 1) {
            // someone else moved it to Screening and bumped the version
            current = detail({ version: 4, status: "screening" });
            return apiError(409, "version_conflict", "Changes were made elsewhere.");
          }
          current = detail({ version: 5, status: body.status ?? current.status });
          return current;
        },
      });
      await loaded();
      expect(callsTo(api, "GET", "/api/v1/applications/a1")).toHaveLength(1);
      seedOtherScreens(queryClient);

      await user.click(screen.getByRole("combobox", { name: "Status" }));
      await user.click(screen.getByRole("option", { name: "Offer" }));
      await waitFor(() => expect(patches).toHaveLength(1));
      expect(patches[0]).toEqual({ version: 3, status: "offer" });

      expect(await screen.findByText(/Changes were made elsewhere/)).toBeInTheDocument();
      // the fresh record is shown: fetched again, with the status the other change left
      await waitFor(() => expect(callsTo(api, "GET", "/api/v1/applications/a1")).toHaveLength(2));
      await waitFor(() =>
        expect(screen.getByRole("combobox", { name: "Status" })).toHaveTextContent("Screening"),
      );

      // the next try carries the fresh version
      await user.click(screen.getByRole("combobox", { name: "Status" }));
      await user.click(screen.getByRole("option", { name: "Offer" }));
      await waitFor(() => expect(patches).toHaveLength(2));
      expect(patches[1]).toEqual({ version: 4, status: "offer" });
      await waitFor(() =>
        expect(screen.getByRole("combobox", { name: "Status" })).toHaveTextContent("Offer"),
      );
      expect(await screen.findByText("Status changed to Offer")).toBeInTheDocument();
      // a manual change marks Today and the badges for a refresh
      expectOtherScreensStale(queryClient, BADGE_SCREENS);
    },
  );

  it("any status can be chosen, in the order of the pipeline", async () => {
    const { user } = setup();
    await loaded();
    await user.click(screen.getByRole("combobox", { name: "Status" }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Applied",
      "Screening",
      "Assessment",
      "Interviewing",
      "Offer",
      "Accepted",
      "Rejected",
      "Withdrawn",
      "Abandoned",
    ]);
  });

  it("an error other than a conflict says the change was not saved", async () => {
    const { user } = setup({
      "PATCH /api/v1/applications/a1": () => apiError(500, "internal_error", "Something broke."),
    });
    await loaded();
    await user.click(screen.getByRole("combobox", { name: "Status" }));
    await user.click(screen.getByRole("option", { name: "Offer" }));
    expect(await screen.findByText("Couldn't save the change. Try again.")).toBeInTheDocument();
    expect(screen.queryByText(/Changes were made elsewhere/)).not.toBeInTheDocument();
  });

  // AC-4.2, AC-4.3
  it("Undo on a timeline entry posts /events/:id/undo and refetches the record", async () => {
    let undone = false;
    const { api, user, queryClient } = setup({
      "GET /api/v1/applications/a1": () =>
        undone
          ? detail({
              version: 4,
              status: "screening",
              timeline: TIMELINE.filter((e) => e.id !== "e-auto"),
            })
          : detail(),
      "POST /api/v1/events/e-auto/undo": () => {
        undone = true;
        return { undone: true };
      },
    });
    await loaded();
    seedOtherScreens(queryClient);
    const entry = screen
      .getAllByRole("listitem")
      .find((li) => li.getAttribute("data-event-id") === "e-auto") as HTMLElement;
    await user.click(within(entry).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(callsTo(api, "POST", "/api/v1/events/e-auto/undo")).toHaveLength(1));
    expect(await screen.findByText("Undone")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Status" })).toHaveTextContent("Screening"),
    );
    // Today, the badges and the review queue (an undone change opens a review item) are refreshed
    expectOtherScreensStale(queryClient);
  });

  it("409 changed_since shows 'Changed since — edit manually' and fetches the record again", async () => {
    const { api, user } = setup({
      "POST /api/v1/events/e-auto/undo": () =>
        apiError(409, "changed_since", "The application changed after this."),
    });
    await loaded();
    const entry = screen
      .getAllByRole("listitem")
      .find((li) => li.getAttribute("data-event-id") === "e-auto") as HTMLElement;
    await user.click(within(entry).getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Changed since — edit manually")).toBeInTheDocument();
    await waitFor(() => expect(callsTo(api, "GET", "/api/v1/applications/a1")).toHaveLength(2));
  });

  it("another failure of Undo says it could not be undone", async () => {
    const { user } = setup({
      "POST /api/v1/events/e-auto/undo": () => apiError(500, "internal_error", "Something broke."),
    });
    await loaded();
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Couldn't undo this change. Try again.")).toBeInTheDocument();
  });

  // DESIGN_SPEC §9.3
  it("u undoes the focused timeline entry", async () => {
    const { api, user } = setup({
      "POST /api/v1/events/e-auto/undo": () => ({ undone: true }),
    });
    await loaded();
    const entries = screen
      .getAllByRole("listitem")
      .filter((li) => li.hasAttribute("data-event-id"));
    // the entry that was changed after has no Undo, so u does nothing there
    const stale = entries.find(
      (li) => li.getAttribute("data-event-id") === "e-stale",
    ) as HTMLElement;
    stale.focus();
    await user.keyboard("u");
    // nothing at all was sent: no request of any kind for the stale entry
    expect(api.calls.filter((c) => c.method !== "GET")).toHaveLength(0);

    const auto = entries.find((li) => li.getAttribute("data-event-id") === "e-auto") as HTMLElement;
    auto.focus();
    await user.keyboard("u");
    await waitFor(() => expect(callsTo(api, "POST", "/api/v1/events/e-auto/undo")).toHaveLength(1));
    expect(api.calls.filter((c) => c.method !== "GET")).toHaveLength(1);
  });

  it("View email opens the side sheet with the plain-text body", async () => {
    const { user } = setup({
      "GET /api/v1/messages/m-invite": () =>
        makeMessage({
          id: "m-invite",
          subject: "Next steps",
          bodyText: "Hi, we would like to invite you to a technical interview.",
        }),
    });
    await loaded();
    const entry = screen
      .getAllByRole("listitem")
      .find((li) => li.getAttribute("data-event-id") === "e-auto") as HTMLElement;
    await user.click(within(entry).getByRole("button", { name: "View email" }));
    const sheet = await screen.findByRole("dialog");
    expect(
      await within(sheet).findByText("Hi, we would like to invite you to a technical interview."),
    ).toBeInTheDocument();
    expect(within(sheet).getByRole("heading", { name: "Next steps" })).toBeInTheDocument();
    await user.click(within(sheet).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("View email in the Emails list opens the same sheet", async () => {
    const { user } = setup({
      "GET /api/v1/messages/m-invite": () =>
        makeMessage({ id: "m-invite", bodyText: "The body of the email." }),
    });
    await loaded();
    const emails = within(screen.getByRole("region", { name: "Emails" }));
    await user.click(emails.getByRole("button", { name: "View email" }));
    expect(await screen.findByText("The body of the email.")).toBeInTheDocument();
  });

  // AC-6.2
  it("notes autosave 800 ms after typing stops", async () => {
    const patches: ApplicationPatch[] = [];
    let current = detail();
    const { api } = setup({
      "GET /api/v1/applications/a1": () => current,
      "PATCH /api/v1/applications/a1": async (req) => {
        const body = (await req.clone().json()) as ApplicationPatch;
        patches.push(body);
        current = detail({ version: 4, notes: body.notes ?? null });
        return current;
      },
    });
    await loaded();
    const notes = screen.getByRole("textbox", { name: "Notes" });
    expect(notes).toHaveValue("Ask about on-call expectations.");
    expect(screen.getByText("Saved automatically")).toBeInTheDocument();

    fakeTimers();
    write(notes, "Ask about on-call expectations. Bring questions.");
    await advance(500);
    write(notes, "Ask about on-call expectations. Bring questions. And more.");
    // 1,300 ms after the first change but only 799 after the last: still waiting
    await advance(799);
    expect(patches).toHaveLength(0);
    await advance(1);
    await settle();
    expect(patches).toEqual([
      { version: 3, notes: "Ask about on-call expectations. Bring questions. And more." },
    ]);
    await settle();
    expect(screen.getByText("Saved")).toBeInTheDocument();

    // clearing the notes saves null
    write(notes, "");
    await advance(800);
    await settle();
    expect(patches).toHaveLength(2);
    expect(patches[1]).toEqual({ version: 4, notes: null });
    expect(callsTo(api, "PATCH", "/api/v1/applications/a1")).toHaveLength(2);
  });

  it("a conflict while saving notes keeps what was typed and saves it again on the fresh version", async () => {
    let current = detail();
    const patches: ApplicationPatch[] = [];
    setup({
      "GET /api/v1/applications/a1": () => current,
      "PATCH /api/v1/applications/a1": async (req) => {
        const body = (await req.clone().json()) as ApplicationPatch;
        patches.push(body);
        if (patches.length === 1) {
          // the sync moved the status; the notes were not touched
          current = detail({ version: 4, status: "offer" });
          return apiError(409, "version_conflict", "Changes were made elsewhere.");
        }
        current = detail({ version: 5, status: "offer", notes: body.notes ?? null });
        return current;
      },
    });
    await loaded();
    const notes = screen.getByRole("textbox", { name: "Notes" });
    fakeTimers();
    write(notes, "Ask about on-call expectations. More.");
    await advance(800);
    await settle();
    expect(patches).toHaveLength(1);
    await advance(800);
    await settle();
    expect(patches).toHaveLength(2);
    expect(patches[1]).toEqual({ version: 4, notes: "Ask about on-call expectations. More." });
    expect(screen.getByText(/Changes were made elsewhere/)).toBeInTheDocument();
    expect(notes).toHaveValue("Ask about on-call expectations. More.");
    await settle();
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("when the notes themselves changed elsewhere, shows the fresh notes instead of overwriting them", async () => {
    let current = detail();
    const patches: ApplicationPatch[] = [];
    setup({
      "GET /api/v1/applications/a1": () => current,
      "PATCH /api/v1/applications/a1": async (req) => {
        patches.push((await req.clone().json()) as ApplicationPatch);
        current = detail({ version: 4, notes: "Edited on another device." });
        return apiError(409, "version_conflict", "Changes were made elsewhere.");
      },
    });
    await loaded();
    const notes = screen.getByRole("textbox", { name: "Notes" });
    fakeTimers();
    write(notes, "Ask about on-call expectations. More.");
    await advance(2000);
    await settle();
    expect(notes).toHaveValue("Edited on another device.");
    expect(screen.getByText(/Changes were made elsewhere/)).toBeInTheDocument();
    expect(patches).toHaveLength(1);
  });

  it("leaving the page within 800 ms of typing still saves the notes", async () => {
    const patches: ApplicationPatch[] = [];
    const { user } = setup({
      "PATCH /api/v1/applications/a1": async (req) => {
        const body = (await req.clone().json()) as ApplicationPatch;
        patches.push(body);
        return detail({ version: 4, notes: body.notes ?? null });
      },
    });
    await loaded();
    await user.click(screen.getByRole("textbox", { name: "Notes" }));
    await user.paste(" Quick thought.");
    expect(patches).toHaveLength(0);
    await user.click(screen.getByRole("link", { name: "Leave" }));
    expect(await screen.findByText("Applications list")).toBeInTheDocument();
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({
      version: 3,
      notes: "Ask about on-call expectations. Quick thought.",
    });
  });

  it("clicking away from the notes saves them at once", async () => {
    const patches: ApplicationPatch[] = [];
    const { user } = setup({
      "PATCH /api/v1/applications/a1": async (req) => {
        const body = (await req.clone().json()) as ApplicationPatch;
        patches.push(body);
        return detail({ version: 4, notes: body.notes ?? null });
      },
    });
    await loaded();
    await user.click(screen.getByRole("textbox", { name: "Notes" }));
    await user.paste(" Another.");
    await user.click(screen.getByRole("heading", { level: 1 }));
    // well inside the 800 ms wait
    await waitFor(() => expect(patches).toHaveLength(1), { timeout: 400 });
  });

  // AC-6.3
  it("Edit details opens a dialog with the record's fields and patches only what changed, with version", async () => {
    const patches: ApplicationPatch[] = [];
    let current = detail({ country: "MX", sponsorshipText: "Not offered" });
    const { user } = setup({
      "GET /api/v1/applications/a1": () => current,
      "PATCH /api/v1/applications/a1": async (req) => {
        const body = (await req.clone().json()) as ApplicationPatch;
        patches.push(body);
        current = { ...current, ...body, version: 4 };
        return current;
      },
    });
    await loaded();
    await user.click(screen.getByRole("button", { name: "Edit details" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit details" });
    expect(within(dialog).getByLabelText("Company")).toHaveValue("Kestrel Pay");
    expect(within(dialog).getByLabelText("Role")).toHaveValue("Senior Frontend Engineer, Payments");
    expect(within(dialog).getByLabelText("Job link")).toHaveValue(
      "https://jobs.example/kestrel-pay/7f3c9d",
    );
    expect(within(dialog).getByLabelText("Location")).toHaveValue("Remote, open to Mexico");
    expect(within(dialog).getByRole("combobox", { name: "Work mode" })).toHaveTextContent("Remote");
    expect(within(dialog).getByLabelText("Country")).toHaveValue("MX");
    expect(within(dialog).getByLabelText("Compensation")).toHaveValue("US$9.5–11k / month");
    expect(within(dialog).getByLabelText("Sponsorship")).toHaveValue("Not offered");
    expect(within(dialog).getByLabelText("Applied date")).toHaveValue("2026-10-15");
    // nothing changed yet: nothing to save
    expect(within(dialog).getByRole("button", { name: "Save changes" })).toBeDisabled();

    const role = within(dialog).getByLabelText("Role");
    await user.clear(role);
    await user.paste("Staff Frontend Engineer");
    await user.clear(within(dialog).getByLabelText("Compensation"));
    await user.clear(within(dialog).getByLabelText("Sponsorship"));
    await user.click(within(dialog).getByRole("combobox", { name: "Work mode" }));
    await user.click(screen.getByRole("option", { name: "Hybrid" }));
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({
      version: 3,
      title: "Staff Frontend Engineer",
      compensationText: null,
      sponsorshipText: null,
      workMode: "hybrid",
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByText("Saved changes")).toBeInTheDocument();
    expect(screen.getByText("Staff Frontend Engineer")).toBeInTheDocument();
  });

  it("Edit details sends a changed applied date as local midnight and the company name for a rename", async () => {
    const patches: ApplicationPatch[] = [];
    const { user } = setup({
      "PATCH /api/v1/applications/a1": async (req) => {
        patches.push((await req.clone().json()) as ApplicationPatch);
        return detail({ version: 4 });
      },
    });
    await loaded();
    await user.click(screen.getByRole("button", { name: "Edit details" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit details" });
    await user.clear(within(dialog).getByLabelText("Company"));
    await user.paste("Kestrel Payments");
    await user.clear(within(dialog).getByLabelText("Applied date"));
    await user.paste("2026-10-05");
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({
      version: 3,
      companyName: "Kestrel Payments",
      appliedAt: "2026-10-05T06:00:00.000Z",
    });
  });

  it("Edit details checks the fields before sending: a name, a role, and an http(s) job link", async () => {
    const patches: unknown[] = [];
    const { user } = setup({
      "PATCH /api/v1/applications/a1": async (req) => {
        patches.push(await req.clone().json());
        return detail({ version: 4 });
      },
    });
    await loaded();
    await user.click(screen.getByRole("button", { name: "Edit details" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit details" });
    await user.clear(within(dialog).getByLabelText("Company"));
    await user.clear(within(dialog).getByLabelText("Role"));
    await user.clear(within(dialog).getByLabelText("Job link"));
    await user.paste("javascript:alert(1)");
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(within(dialog).getByText("Enter the company name")).toBeInTheDocument();
    expect(within(dialog).getByText("Enter the role")).toBeInTheDocument();
    expect(
      within(dialog).getByText("Enter a link that starts with http or https"),
    ).toBeInTheDocument();
    expect(patches).toHaveLength(0);
  });

  it("Edit details: 409 version_conflict refetches, shows the conflict copy and keeps what was typed", async () => {
    let current = detail();
    const patches: ApplicationPatch[] = [];
    const { api, user } = setup({
      "GET /api/v1/applications/a1": () => current,
      "PATCH /api/v1/applications/a1": async (req) => {
        const body = (await req.clone().json()) as ApplicationPatch;
        patches.push(body);
        if (patches.length === 1) {
          current = detail({ version: 4, locationText: "Lisbon" });
          return apiError(409, "version_conflict", "Changes were made elsewhere.");
        }
        current = detail({ version: 5, locationText: "Lisbon", title: body.title ?? "" });
        return current;
      },
    });
    await loaded();
    await user.click(screen.getByRole("button", { name: "Edit details" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit details" });
    await user.clear(within(dialog).getByLabelText("Role"));
    await user.paste("Staff Frontend Engineer");
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));

    expect(await within(dialog).findByText(/Changes were made elsewhere/)).toBeInTheDocument();
    await waitFor(() => expect(callsTo(api, "GET", "/api/v1/applications/a1")).toHaveLength(2));
    // the dialog stays, with the typed role; the record behind it is the fresh one
    expect(within(dialog).getByLabelText("Role")).toHaveValue("Staff Frontend Engineer");
    expect(screen.getByRole("dialog", { name: "Edit details" })).toBeInTheDocument();

    // the next save carries the fresh version, and only the field that was changed
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(patches).toHaveLength(2));
    expect(patches[1]).toEqual({ version: 4, title: "Staff Frontend Engineer" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("links are 44px targets on a phone", async () => {
    setup({}, { width: 390 });
    await loaded();
    const small = { minHeight: "44px" };
    expect(screen.getByRole("link", { name: "Applications" })).toHaveStyle(small);
    expect(screen.getByRole("link", { name: "Join video call" })).toHaveStyle(small);
    expect(screen.getByRole("link", { name: /jobs\.example\/kestrel-pay/ })).toHaveStyle(small);
  });

  it("an unknown id shows the full-page error with Back to applications", async () => {
    const { user } = setup(
      {
        "GET /api/v1/applications/nope": () =>
          apiError(404, "not_found", "That application doesn't exist."),
      },
      { route: "/applications/nope" },
    );
    expect(
      await screen.findByRole("heading", { level: 1, name: "Application not found" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Timeline" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Back to applications" }));
    expect(await screen.findByText("Applications list")).toBeInTheDocument();
  });

  it("shows a skeleton while loading, and Try again when the record cannot be loaded", async () => {
    let fail = true;
    const { user } = setup({
      "GET /api/v1/applications/a1": () =>
        fail ? apiError(500, "internal_error", "Something broke.") : detail(),
    });
    expect(screen.getByRole("status", { name: "Loading application" })).toBeInTheDocument();
    expect(await screen.findByText(/Couldn't load the application/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to applications" })).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await loaded();
  });

  // Heavy under jsdom (MUI re-renders on every step); see heavyIt.
  heavyIt(
    "the overflow menu withdraws the application, and Undo puts the status back",
    async () => {
      let current = detail();
      const patches: ApplicationPatch[] = [];
      const { user } = setup({
        "GET /api/v1/applications/a1": () => current,
        "PATCH /api/v1/applications/a1": async (req) => {
          const body = (await req.clone().json()) as ApplicationPatch;
          patches.push(body);
          current = detail({ version: current.version + 1, status: body.status ?? current.status });
          return current;
        },
      });
      await loaded();
      await user.click(screen.getByRole("button", { name: "More actions" }));
      await user.click(screen.getByRole("menuitem", { name: "Withdraw" }));
      await waitFor(() => expect(patches).toHaveLength(1));
      expect(patches[0]).toEqual({ version: 3, status: "withdrawn" });
      expect(await screen.findByText("Marked as withdrawn")).toBeInTheDocument();
      await waitFor(() =>
        expect(screen.getByRole("combobox", { name: "Status" })).toHaveTextContent("Withdrawn"),
      );

      const toast = screen
        .getByText("Marked as withdrawn")
        .closest('[role="status"]') as HTMLElement;
      await user.click(within(toast).getByRole("button", { name: "Undo" }));
      await waitFor(() => expect(patches).toHaveLength(2));
      expect(patches[1]).toEqual({ version: 4, status: "interviewing" });
      expect(await screen.findByText("Undone")).toBeInTheDocument();
    },
  );

  it("Withdraw is not offered for an application that is already withdrawn", async () => {
    const { user } = setup({
      "GET /api/v1/applications/a1": () => detail({ status: "withdrawn" }),
    });
    await loaded();
    await user.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getByRole("menuitem", { name: "Withdraw" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  // Heavy under jsdom (MUI re-renders on every step); see heavyIt.
  heavyIt(
    "Merge into… finds another application, posts the merge and opens the target",
    async () => {
      const other = makeApplication({
        id: "a2",
        company: { id: "c9", name: "Kestrel Payments Ltd" },
        title: "Frontend Engineer",
      });
      const merged: unknown[] = [];
      const { api, user } = setup({
        "GET /api/v1/applications": (req) => {
          const q = new URL(req.url).searchParams.get("q");
          return {
            items: q === "kestrel" ? [makeApplication({ id: "a1" }), other] : [],
            nextCursor: null,
          };
        },
        "POST /api/v1/applications/a1/merge": async (req) => {
          merged.push(await req.clone().json());
          return detail({ id: "a2", company: { id: "c9", name: "Kestrel Payments Ltd" } });
        },
        "GET /api/v1/applications/a2": () =>
          detail({ id: "a2", company: { id: "c9", name: "Kestrel Payments Ltd" } }),
      });
      await loaded();
      await user.click(screen.getByRole("button", { name: "More actions" }));
      await user.click(screen.getByRole("menuitem", { name: "Merge into…" }));
      const dialog = await screen.findByRole("dialog", { name: "Merge into another application" });
      const confirm = within(dialog).getByRole("button", { name: "Merge" });
      expect(confirm).toBeDisabled();
      await user.click(within(dialog).getByRole("searchbox", { name: "Find an application" }));
      await user.paste("kestrel");
      // the application itself is not offered
      const choice = await within(dialog).findByRole("radio", { name: /Kestrel Payments Ltd/ });
      expect(within(dialog).queryAllByRole("radio")).toHaveLength(1);
      await user.click(choice);
      await user.click(confirm);
      await waitFor(() => expect(merged).toEqual([{ intoId: "a2" }]));
      await waitFor(() =>
        expect(screen.getByTestId("where")).toHaveTextContent("/applications/a2"),
      );
      expect(await screen.findByText("Merged into Kestrel Payments Ltd")).toBeInTheDocument();
      expect(callsTo(api, "POST", "/api/v1/applications/a1/merge")).toHaveLength(1);
    },
  );
});
