import type { Page, ReviewItem, ReviewKind } from "@offerbound/contracts";
import { DEFAULT_SETTINGS } from "@offerbound/contracts";
import { screen, waitFor, within, type BoundFunctions, type queries } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeMessage, makeNavCounts, makeReviewItem, makeToday } from "../../test/factories";
import { apiError, mockApi, type MockApi, type MockHandler } from "../../test/mock-api";
import { renderWithProviders } from "../../test/render";
import { HEAVY_TEST_MS, heavyIt, setValue } from "../../test/speed";
import { queryKeys } from "../api/hooks";
import { UndoSnackbar } from "../components/UndoSnackbar";
import { ReviewPage } from "./ReviewPage";

// MUI selects and dialogs render slowly under jsdom; a busy machine must not turn that into a failure.
vi.setConfig({ testTimeout: 15_000 });

const ME = {
  mode: "private",
  email: "owner@example.test",
  onboardingCompleted: true,
  timezone: "America/Monterrey",
};

const SUMMARY = {
  id: "m2",
  internalDate: "2026-10-28T20:00:00Z",
  direction: "inbound" as const,
  fromName: "Dana Ortiz",
  fromEmail: "dana@quarry.example",
  subject: "An update on your Quarry AI application",
  summary: "Thanks you for your time and says the team is reviewing all candidates.",
  category: "rejection" as const,
};

const item = (kind: ReviewKind, overrides: Partial<ReviewItem> = {}): ReviewItem =>
  makeReviewItem({
    id: `r-${kind}`,
    kind,
    message: SUMMARY,
    confidence: null,
    candidates: [],
    proposal: { description: `Question for ${kind}?`, operations: [] },
    ...overrides,
  });

const LOW = item("low_confidence", {
  confidence: 0.64,
  proposal: {
    description: "Is this a rejection from Quarry AI?",
    operations: [
      { entity: "application", action: "update", summary: "Would change Assessment to Rejected." },
    ],
  },
});
const AMBIGUOUS = item("ambiguous_match", {
  candidates: [
    { id: "a1", label: "Senior Frontend Engineer" },
    { id: "a2", label: "Senior Product Engineer, Data" },
  ],
  proposal: {
    description: "Which Arbor Analytics application is this email about?",
    operations: [],
  },
});
const UNEXPECTED = item("unexpected_transition", {
  proposal: {
    description: "Pinecrest Media invited you to interview after rejecting you",
    operations: [
      { entity: "application", action: "update", summary: "Would reopen it as Interviewing." },
    ],
  },
});
const DUPLICATE = item("possible_duplicate_company", {
  message: null,
  proposal: { description: "Is Fjordline the same company as Fjordline Travel?", operations: [] },
});
const FAILED = item("extraction_failed", {
  proposal: { description: "Offerbound couldn't read this email.", operations: [] },
});
const UNDONE = item("undone_change", {
  proposal: { description: "You undid a change from this email.", operations: [] },
});
const OPEN = [LOW, AMBIGUOUS, UNEXPECTED, DUPLICATE, FAILED, UNDONE];

const RESOLVED = [
  item("low_confidence", {
    id: "r-done",
    state: "resolved",
    proposal: { description: "Is this an offer from Brightline Learning?", operations: [] },
  }),
  item("ambiguous_match", {
    id: "r-dismissed",
    state: "dismissed",
    proposal: { description: "Which Halyard Health application is this?", operations: [] },
  }),
];

const page = (items: ReviewItem[], nextCursor: string | null = null): Page<ReviewItem> => ({
  items,
  nextCursor,
});

/** A server holding `items`: filters by state and honours `limit` and `cursor`. */
function reviewHandler(getItems: () => ReviewItem[]): MockHandler {
  return (req) => {
    const url = new URL(req.url);
    const state = url.searchParams.get("state");
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const matching = getItems().filter((r) =>
      state === "resolved" ? r.state !== "open" : r.state === "open",
    );
    const start = Number(url.searchParams.get("cursor") ?? "0");
    return page(
      matching.slice(start, start + limit),
      start + limit < matching.length ? String(start + limit) : null,
    );
  };
}

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

function setup(
  routes: Record<string, MockHandler> = {},
  {
    route = "/review",
    width,
    items = [...OPEN, ...RESOLVED],
  }: { route?: string; width?: number; items?: ReviewItem[] } = {},
) {
  const api: MockApi = mockApi({
    "GET /api/v1/me": () => ME,
    "GET /api/v1/settings": () => DEFAULT_SETTINGS,
    "GET /api/v1/today": () => makeToday(),
    "GET /api/v1/nav-counts": () => makeNavCounts({ openReview: 6 }),
    "GET /api/v1/review-items": reviewHandler(() => items),
    ...routes,
  });
  const rendered = renderWithProviders(
    <>
      <Routes>
        <Route path="/review" element={<ReviewPage />} />
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

type Card = BoundFunctions<typeof queries>;

const cardOf = async (question: string) => {
  const heading = await screen.findByRole("heading", { level: 2, name: question });
  const card = heading.closest("li");
  if (!card) throw new Error(`no card for ${question}`);
  return within(card);
};

const actionNames = (card: Card) =>
  within(card.getByRole("group", { name: "Actions" }))
    .getAllByRole("button")
    .map((b) => b.textContent);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-29T18:00:00Z") });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ReviewPage", () => {
  it("kind chips read 'Not sure', 'Which application?', 'Unexpected change', 'Same company?', \"Couldn't read\" and 'Undone change'", async () => {
    setup();
    const expected: [string, string][] = [
      ["Is this a rejection from Quarry AI?", "Not sure"],
      ["Which Arbor Analytics application is this email about?", "Which application?"],
      ["Pinecrest Media invited you to interview after rejecting you", "Unexpected change"],
      ["Is Fjordline the same company as Fjordline Travel?", "Same company?"],
      ["Offerbound couldn't read this email.", "Couldn't read"],
      ["You undid a change from this email.", "Undone change"],
    ];
    for (const [question, chip] of expected) {
      expect((await cardOf(question)).getByText(chip)).toBeInTheDocument();
    }
    expect(screen.getByRole("heading", { level: 1, name: "Review" })).toBeInTheDocument();
  });

  describe("actions", () => {
    const ACTIONS: [ReviewKind, string, [string, string][]][] = [
      [
        "low_confidence",
        "Is this a rejection from Quarry AI?",
        [
          ["Apply change", "apply"],
          ["Dismiss", "dismiss"],
        ],
      ],
      [
        "ambiguous_match",
        "Which Arbor Analytics application is this email about?",
        [
          ["Create new application", "create_new"],
          ["Dismiss", "dismiss"],
        ],
      ],
      [
        "unexpected_transition",
        "Pinecrest Media invited you to interview after rejecting you",
        [
          ["Reopen application", "reopen"],
          ["Add to timeline only", "timeline_only"],
        ],
      ],
      [
        "possible_duplicate_company",
        "Is Fjordline the same company as Fjordline Travel?",
        [
          ["Merge companies", "merge"],
          ["Same group, different companies", "same_group"],
          ["Keep separate", "keep_separate"],
        ],
      ],
      [
        "extraction_failed",
        "Offerbound couldn't read this email.",
        [
          ["Retry", "retry"],
          ["Dismiss", "dismiss"],
        ],
      ],
      [
        "undone_change",
        "You undid a change from this email.",
        [
          ["Reprocess", "reprocess"],
          ["Ignore", "ignore"],
        ],
      ],
    ];

    it("each kind shows exactly its AC-5.2 actions", async () => {
      setup();
      const shown = {
        low_confidence: ["Apply change", "Edit and apply", "Dismiss"],
        ambiguous_match: ["Attach email", "Create new application", "Dismiss"],
        unexpected_transition: ["Reopen application", "Add to timeline only"],
        possible_duplicate_company: [
          "Merge companies",
          "Same group, different companies",
          "Keep separate",
        ],
        extraction_failed: ["Retry", "Dismiss"],
        undone_change: ["Reprocess", "Ignore"],
      } satisfies Record<ReviewKind, string[]>;
      for (const [kind, question] of ACTIONS) {
        expect(actionNames(await cardOf(question))).toEqual(shown[kind]);
      }
    });

    // One full page per action button, in a loop: heavy under jsdom; see heavyIt.
    it.each(ACTIONS)(
      "%s posts /review-items/:id/resolve with each of its actions",
      async (kind, question, buttons) => {
        for (const [label, action] of buttons) {
          const { api, user, unmount } = setup({
            [`POST /api/v1/review-items/r-${kind}/resolve`]: () => ({
              ...OPEN.find((i) => i.kind === kind),
              state: "resolved",
            }),
          });
          await user.click((await cardOf(question)).getByRole("button", { name: label }));
          await waitFor(() =>
            expect(callsTo(api, "POST", `/api/v1/review-items/r-${kind}/resolve`)).toHaveLength(1),
          );
          const post = callsTo(api, "POST", `/api/v1/review-items/r-${kind}/resolve`)[0];
          expect(await post?.json()).toEqual({ action });
          expect(post?.headers.get("X-Offerbound-Request")).toBe("1");
          unmount();
        }
      },
      HEAVY_TEST_MS,
    );

    it("a resolved item leaves the Open list, the badges are fetched again and the snackbar repeats the verb", async () => {
      let open = [...OPEN];
      const { api, user } = setup(
        {
          "GET /api/v1/review-items": reviewHandler(() => open),
          "POST /api/v1/review-items/r-low_confidence/resolve": () => {
            open = open.filter((i) => i.id !== "r-low_confidence");
            return { ...LOW, state: "resolved" };
          },
        },
        { items: OPEN },
      );
      const navBefore = callsTo(api, "GET", "/api/v1/nav-counts").length;
      await user.click(
        (await cardOf("Is this a rejection from Quarry AI?")).getByRole("button", {
          name: "Apply change",
        }),
      );
      expect(await screen.findByText("Applied the change")).toBeInTheDocument();
      await waitFor(() =>
        expect(
          screen.queryByRole("heading", { name: "Is this a rejection from Quarry AI?" }),
        ).not.toBeInTheDocument(),
      );
      await waitFor(() =>
        expect(callsTo(api, "GET", "/api/v1/nav-counts").length).toBeGreaterThan(navBefore),
      );
    });

    it("resolving an item marks the interviews lists stale, since an invitation can add or move one", async () => {
      const { queryClient, user } = setup({
        "POST /api/v1/review-items/r-low_confidence/resolve": () => ({ ...LOW, state: "resolved" }),
      });
      // No Interviews page is open, so these lists have no observer; invalidation only marks them.
      queryClient.setQueryData(queryKeys.interviewList("upcoming"), { pages: [], pageParams: [] });
      queryClient.setQueryData(queryKeys.interviewList("past"), { pages: [], pageParams: [] });
      await user.click(
        (await cardOf("Is this a rejection from Quarry AI?")).getByRole("button", {
          name: "Apply change",
        }),
      );
      expect(await screen.findByText("Applied the change")).toBeInTheDocument();
      for (const range of ["upcoming", "past"] as const) {
        expect(queryClient.getQueryState(queryKeys.interviewList(range))?.isInvalidated).toBe(true);
      }
    });

    // Heavy under jsdom (MUI re-renders on every step); see heavyIt.
    heavyIt(
      "Edit and apply opens a dialog and posts edit_apply with only the fields that were set",
      async () => {
        const { api, user } = setup({
          "POST /api/v1/review-items/r-low_confidence/resolve": () => ({
            ...LOW,
            state: "resolved",
          }),
        });
        await user.click(
          (await cardOf("Is this a rejection from Quarry AI?")).getByRole("button", {
            name: "Edit and apply",
          }),
        );
        const dialog = await screen.findByRole("dialog", { name: "Edit and apply" });
        const submit = within(dialog).getByRole("button", { name: "Apply with edits" });
        expect(submit).toBeDisabled();
        await user.click(within(dialog).getByRole("combobox", { name: "What the email is" }));
        await user.click(await screen.findByRole("option", { name: "Interview invitation" }));
        setValue(
          within(dialog).getByRole("textbox", { name: "Job link" }),
          "https://jobs.example/quarry/7",
        );
        expect(submit).toBeEnabled();
        await user.click(submit);
        await waitFor(() =>
          expect(
            callsTo(api, "POST", "/api/v1/review-items/r-low_confidence/resolve"),
          ).toHaveLength(1),
        );
        expect(
          await callsTo(api, "POST", "/api/v1/review-items/r-low_confidence/resolve")[0]?.json(),
        ).toEqual({
          action: "edit_apply",
          edits: { category: "interview_invite", jobUrl: "https://jobs.example/quarry/7" },
        });
        expect(await screen.findByText("Applied your edits")).toBeInTheDocument();
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      },
    );

    it("Edit and apply refuses a job link that is not http(s)", async () => {
      const { api, user } = setup();
      await user.click(
        (await cardOf("Is this a rejection from Quarry AI?")).getByRole("button", {
          name: "Edit and apply",
        }),
      );
      const dialog = await screen.findByRole("dialog", { name: "Edit and apply" });
      setValue(within(dialog).getByRole("textbox", { name: "Job link" }), "javascript:1");
      await user.click(within(dialog).getByRole("button", { name: "Apply with edits" }));
      expect(await within(dialog).findByText(/starts with http/)).toBeInTheDocument();
      expect(callsTo(api, "POST", "/api/v1/review-items/r-low_confidence/resolve")).toHaveLength(0);
    });

    it("a choice that changed elsewhere (409) refreshes the lists and says so", async () => {
      const { api, user } = setup({
        "POST /api/v1/review-items/r-low_confidence/resolve": () =>
          apiError(409, "version_conflict", "The record changed."),
      });
      await screen.findByText("Is this a rejection from Quarry AI?");
      const before = callsTo(api, "GET", "/api/v1/review-items").length;
      await user.click(
        (await cardOf("Is this a rejection from Quarry AI?")).getByRole("button", {
          name: "Apply change",
        }),
      );
      expect(
        await screen.findByText("Changes were made elsewhere. Review has been refreshed."),
      ).toBeInTheDocument();
      await waitFor(() =>
        expect(callsTo(api, "GET", "/api/v1/review-items").length).toBeGreaterThan(before),
      );
    });

    it("a 409 with any other code (changed_since) also says changes were made elsewhere", async () => {
      const { user } = setup({
        "POST /api/v1/review-items/r-low_confidence/resolve": () =>
          apiError(409, "changed_since", "The application changed."),
      });
      await user.click(
        (await cardOf("Is this a rejection from Quarry AI?")).getByRole("button", {
          name: "Apply change",
        }),
      );
      expect(
        await screen.findByText("Changes were made elsewhere. Review has been refreshed."),
      ).toBeInTheDocument();
      expect(screen.queryByText("Couldn't save your choice. Try again.")).not.toBeInTheDocument();
    });

    it("in the Edit and apply dialog a 409 with any code closes the dialog and says so", async () => {
      const { user } = setup({
        "POST /api/v1/review-items/r-low_confidence/resolve": () =>
          apiError(409, "changed_since", "The application changed."),
      });
      await user.click(
        (await cardOf("Is this a rejection from Quarry AI?")).getByRole("button", {
          name: "Edit and apply",
        }),
      );
      const dialog = await screen.findByRole("dialog", { name: "Edit and apply" });
      setValue(within(dialog).getByRole("textbox", { name: "Job link" }), "https://x.example/1");
      await user.click(within(dialog).getByRole("button", { name: "Apply with edits" }));
      expect(
        await screen.findByText("Changes were made elsewhere. Review has been refreshed."),
      ).toBeInTheDocument();
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: "Edit and apply" })).not.toBeInTheDocument(),
      );
    });

    it("any other failure says the choice was not saved and keeps the item", async () => {
      const { user } = setup({
        "POST /api/v1/review-items/r-low_confidence/resolve": () =>
          apiError(500, "internal_error", "Something broke."),
      });
      await user.click(
        (await cardOf("Is this a rejection from Quarry AI?")).getByRole("button", {
          name: "Dismiss",
        }),
      );
      expect(await screen.findByText("Couldn't save your choice. Try again.")).toBeInTheDocument();
      expect(screen.getByText("Is this a rejection from Quarry AI?")).toBeInTheDocument();
    });
  });

  describe("Which application?", () => {
    it("requires choosing a candidate radio before Attach", async () => {
      const { api, user } = setup({
        "POST /api/v1/review-items/r-ambiguous_match/resolve": () => ({
          ...AMBIGUOUS,
          state: "resolved",
        }),
      });
      const card = await cardOf("Which Arbor Analytics application is this email about?");
      const attach = card.getByRole("button", { name: "Attach email" });
      expect(attach).toBeDisabled();
      const radios = card.getAllByRole("radio");
      expect(radios.map((r) => (r as HTMLInputElement).labels?.[0]?.textContent)).toEqual([
        "Senior Frontend Engineer",
        "Senior Product Engineer, Data",
      ]);
      expect(radios.every((r) => !(r as HTMLInputElement).checked)).toBe(true);
      expect(card.getByRole("group", { name: "Attach it to" })).toBeInTheDocument();

      expect(callsTo(api, "POST", "/api/v1/review-items/r-ambiguous_match/resolve")).toHaveLength(
        0,
      );

      await user.click(card.getByRole("radio", { name: "Senior Product Engineer, Data" }));
      expect(attach).toBeEnabled();
      await user.click(attach);
      await waitFor(() =>
        expect(callsTo(api, "POST", "/api/v1/review-items/r-ambiguous_match/resolve")).toHaveLength(
          1,
        ),
      );
      expect(
        await callsTo(api, "POST", "/api/v1/review-items/r-ambiguous_match/resolve")[0]?.json(),
      ).toEqual({ action: "attach", applicationId: "a2" });
      expect(await screen.findByText("Attached the email")).toBeInTheDocument();
    });

    it("with no candidates Attach stays off and Create new application is the way forward", async () => {
      setup({}, { items: [{ ...AMBIGUOUS, candidates: [] }] });
      const card = await cardOf("Which Arbor Analytics application is this email about?");
      expect(card.queryByRole("radio")).not.toBeInTheDocument();
      expect(card.getByRole("button", { name: "Attach email" })).toBeDisabled();
      expect(card.getByText(/No application matched/)).toBeInTheDocument();
      expect(card.getByRole("button", { name: "Create new application" })).toBeEnabled();
    });
  });

  describe("confidence", () => {
    it("the meter has role='meter' and states the threshold in words", async () => {
      setup();
      const card = await cardOf("Is this a rejection from Quarry AI?");
      const meter = card.getByRole("meter", { name: "Confidence" });
      expect(meter).toHaveAttribute("aria-valuenow", "64");
      expect(meter).toHaveAttribute("aria-valuemin", "0");
      expect(meter).toHaveAttribute("aria-valuemax", "100");
      expect(
        card.getByText("Confidence 64%. Changes apply on their own at 80% or more."),
      ).toBeInTheDocument();
    });

    it("the threshold follows the setting", async () => {
      setup({
        "GET /api/v1/settings": () => ({
          ...DEFAULT_SETTINGS,
          automation: { ...DEFAULT_SETTINGS.automation, autoApplyMinConfidence: 0.9 },
        }),
      });
      const card = await cardOf("Is this a rejection from Quarry AI?");
      expect(
        await card.findByText("Confidence 64%. Changes apply on their own at 90% or more."),
      ).toBeInTheDocument();
    });

    it("an item with no confidence has no meter", async () => {
      setup();
      const card = await cardOf("Is Fjordline the same company as Fjordline Travel?");
      expect(card.queryByRole("meter")).not.toBeInTheDocument();
    });
  });

  describe("card content", () => {
    it("shows the email summary, the proposed change and the date in the owner's time zone", async () => {
      setup();
      const card = await cardOf("Is this a rejection from Quarry AI?");
      expect(card.getByText("An update on your Quarry AI application")).toBeInTheDocument();
      expect(card.getByText(/dana@quarry\.example/)).toBeInTheDocument();
      expect(card.getByText(/reviewing all candidates/)).toBeInTheDocument();
      expect(card.getByText("Proposed change")).toBeInTheDocument();
      expect(card.getByText("Would change Assessment to Rejected.")).toBeInTheDocument();
      // 2026-10-28T20:00Z is 14:00 in Monterrey.
      expect(card.getByText("Oct 28, 14:00")).toBeInTheDocument();
    });

    it("an item with no email has no email box", async () => {
      setup();
      const card = await cardOf("Is Fjordline the same company as Fjordline Travel?");
      expect(card.queryByText("Show the email")).not.toBeInTheDocument();
    });

    it("Show the email opens the email in the side sheet", async () => {
      const { user } = setup({
        "GET /api/v1/messages/m2": () =>
          makeMessage({ id: "m2", subject: "An update on your Quarry AI application" }),
      });
      const card = await cardOf("Is this a rejection from Quarry AI?");
      await user.click(card.getByRole("button", { name: "Show the email" }));
      const dialog = await screen.findByRole("dialog");
      expect(await within(dialog).findByText("Hello")).toBeInTheDocument();
    });

    it("on a phone the actions wrap and every button is at least 44px tall", async () => {
      setup({}, { width: 390 });
      const card = await cardOf("Is this a rejection from Quarry AI?");
      const group = card.getByRole("group", { name: "Actions" });
      expect(getComputedStyle(group).flexWrap).toBe("wrap");
      for (const button of within(group).getAllByRole("button")) {
        expect(parseFloat(getComputedStyle(button).minHeight)).toBeGreaterThanOrEqual(44);
      }
    });
  });

  describe("tabs", () => {
    it("Open shows its count from the navigation badge, and the tab is kept in ?tab=", async () => {
      const { user } = setup();
      expect(await screen.findByRole("tab", { name: "Open 6" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      expect(
        await screen.findByText("6 emails need a decision. Nothing changes until you choose."),
      ).toBeInTheDocument();
      await user.click(screen.getByRole("tab", { name: "Resolved" }));
      expect(await screen.findByText("Is this an offer from Brightline Learning?")).toBeVisible();
      expect(screen.getByTestId("where")).toHaveTextContent("/review?tab=resolved");
      await user.click(screen.getByRole("tab", { name: "Open 6" }));
      expect(screen.getByTestId("where")).toHaveTextContent(/^\/review$/);
    });

    it("the Resolved tab lists resolved items without actions", async () => {
      const { api } = setup({}, { route: "/review?tab=resolved" });
      expect(await screen.findByText("Is this an offer from Brightline Learning?")).toBeVisible();
      expect(screen.getByText("Which Halyard Health application is this?")).toBeInTheDocument();
      const panel = within(screen.getByRole("tabpanel"));
      expect(panel.getByText("Resolved")).toBeInTheDocument();
      expect(panel.getByText("Dismissed")).toBeInTheDocument();
      expect(screen.queryByRole("group", { name: "Actions" })).not.toBeInTheDocument();
      expect(screen.queryByText("Is this a rejection from Quarry AI?")).not.toBeInTheDocument();
      const list = callsTo(api, "GET", "/api/v1/review-items").at(-1);
      expect(new URL(list?.url ?? "http://none").searchParams.get("state")).toBe("resolved");
    });

    it("the empty Open list reads 'Nothing to review. Changes Offerbound is sure about are applied on their own.'", async () => {
      setup({ "GET /api/v1/nav-counts": () => makeNavCounts({ openReview: 0 }) }, { items: [] });
      expect(
        await screen.findByText(
          "Nothing to review. Changes Offerbound is sure about are applied on their own.",
        ),
      ).toBeInTheDocument();
    });

    it("the Resolved tab lists resolved items; its empty state names what shows there", async () => {
      setup({}, { route: "/review?tab=resolved", items: [...OPEN] });
      expect(await screen.findByText("Nothing resolved yet.")).toBeInTheDocument();
    });
  });

  describe("loading, errors and paging", () => {
    it("shows a skeleton while loading and an error with Try again when the list fails", async () => {
      let fail = true;
      const { user } = setup({
        "GET /api/v1/review-items": (req) =>
          fail ? apiError(500, "internal_error", "Down.") : reviewHandler(() => OPEN)(req),
      });
      expect(screen.getByRole("status", { name: "Loading review items" })).toBeInTheDocument();
      expect(await screen.findByText("Couldn't load review items.")).toBeInTheDocument();
      fail = false;
      await user.click(screen.getByRole("button", { name: "Try again" }));
      expect(await screen.findByText("Is this a rejection from Quarry AI?")).toBeInTheDocument();
    });

    it("Show more follows the cursor", async () => {
      const many = Array.from({ length: 30 }, (_, i) =>
        item("extraction_failed", {
          id: `f${i}`,
          createdAt: `2026-10-28T${String(10 + (i % 10)).padStart(2, "0")}:00:00Z`,
          proposal: { description: `Failed email ${i}`, operations: [] },
        }),
      );
      const { api, user } = setup({}, { items: many });
      await screen.findByText("Failed email 0");
      expect(screen.queryByText("Failed email 25")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Show more" }));
      expect(await screen.findByText("Failed email 25")).toBeInTheDocument();
      const urls = callsTo(api, "GET", "/api/v1/review-items").map((c) => new URL(c.url));
      expect(urls.at(-1)?.searchParams.get("cursor")).toBe("25");
      expect(urls[0]?.searchParams.get("limit")).toBe("25");
    });
  });

  describe("keyboard", () => {
    it("after an item is resolved focus moves to the next card; after the last, to the heading", async () => {
      let open = [LOW, FAILED];
      const { user } = setup(
        {
          "GET /api/v1/review-items": reviewHandler(() => open),
          "POST /api/v1/review-items/r-low_confidence/resolve": () => {
            open = open.filter((i) => i.id !== "r-low_confidence");
            return { ...LOW, state: "resolved" };
          },
          "POST /api/v1/review-items/r-extraction_failed/resolve": () => {
            open = [];
            return { ...FAILED, state: "dismissed" };
          },
        },
        { items: [LOW, FAILED] },
      );
      await user.click(
        (await cardOf("Is this a rejection from Quarry AI?")).getByRole("button", {
          name: "Apply change",
        }),
      );
      const next = screen.getByRole("heading", { name: "Offerbound couldn't read this email." });
      await waitFor(() => expect(next.closest("li")).toHaveFocus());
      await user.click(
        within(next.closest("li") as HTMLElement).getByRole("button", { name: "Dismiss" }),
      );
      await waitFor(() =>
        expect(screen.getByRole("heading", { level: 1, name: "Review" })).toHaveFocus(),
      );
    });

    it("resolving the middle of three cards moves focus to the card that follows it", async () => {
      let open = [LOW, FAILED, UNDONE];
      const { user } = setup(
        {
          "GET /api/v1/review-items": reviewHandler(() => open),
          "POST /api/v1/review-items/r-extraction_failed/resolve": () => {
            open = open.filter((i) => i.id !== "r-extraction_failed");
            return { ...FAILED, state: "dismissed" };
          },
        },
        { items: open },
      );
      await user.click(
        (await cardOf("Offerbound couldn't read this email.")).getByRole("button", {
          name: "Dismiss",
        }),
      );
      const after = screen.getByRole("heading", { name: "You undid a change from this email." });
      await waitFor(() => expect(after.closest("li")).toHaveFocus());
      expect(
        screen.queryByRole("heading", { name: "Offerbound couldn't read this email." }),
      ).toBeNull();
    });

    it("after Edit and apply closes, focus is on the card that follows the edited one", async () => {
      let open = [LOW, FAILED];
      const { user } = setup(
        {
          "GET /api/v1/review-items": reviewHandler(() => open),
          "POST /api/v1/review-items/r-low_confidence/resolve": () => {
            open = open.filter((i) => i.id !== "r-low_confidence");
            return { ...LOW, state: "resolved" };
          },
        },
        { items: open },
      );
      await user.click(
        (await cardOf("Is this a rejection from Quarry AI?")).getByRole("button", {
          name: "Edit and apply",
        }),
      );
      const dialog = await screen.findByRole("dialog", { name: "Edit and apply" });
      setValue(
        within(dialog).getByRole("textbox", { name: "Job link" }),
        "https://jobs.example/q/1",
      );
      await user.click(within(dialog).getByRole("button", { name: "Apply with edits" }));
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: "Edit and apply" })).not.toBeInTheDocument(),
      );
      const next = await screen.findByRole("heading", {
        name: "Offerbound couldn't read this email.",
      });
      // The dialog hands focus back to the button that opened it, which has left with its card:
      // focus must not be lost to the page (a keyboard owner would start again from the top).
      await waitFor(() => expect(next.closest("li")).toHaveFocus());
    });

    it("j moves to the first card and Enter shows its email", async () => {
      const { user } = setup({
        "GET /api/v1/messages/m2": () => makeMessage({ id: "m2", subject: "Quarry update" }),
      });
      await screen.findByText("Is this a rejection from Quarry AI?");
      await user.keyboard("j");
      expect(screen.getByText("Is this a rejection from Quarry AI?").closest("li")).toHaveAttribute(
        "aria-current",
        "true",
      );
      await user.keyboard("{Enter}");
      expect(await screen.findByRole("dialog")).toBeInTheDocument();
    });
  });
});
