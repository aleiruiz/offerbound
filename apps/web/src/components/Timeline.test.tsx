import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { makeEvent } from "../../test/factories";
import { renderWithProviders } from "../../test/render";
import { createOfferboundTheme } from "../theme";
import { Timeline } from "./Timeline";

const events = [
  makeEvent({
    id: "old",
    type: "lead_created",
    actor: "system",
    occurredAt: "2026-10-14T13:04:00Z",
    summary: "Lead found by the morning search",
    undoable: false,
  }),
  makeEvent({
    id: "auto",
    type: "status_changed",
    actor: "system",
    occurredAt: "2026-10-27T20:12:00Z",
    summary: "Moved to Interviewing",
    toStatus: "interviewing",
    messageId: "m9",
    undoable: true,
  }),
  makeEvent({
    id: "mail",
    type: "email_received",
    actor: "system",
    occurredAt: "2026-10-23T23:30:00Z",
    summary: "Email from Dana Ortiz",
    messageId: "m5",
    undoable: false,
  }),
  makeEvent({
    id: "stale",
    type: "status_changed",
    actor: "system",
    occurredAt: "2026-10-21T15:05:00Z",
    summary: "Moved to Screening",
    toStatus: "screening",
    undoable: false,
  }),
  makeEvent({
    id: "me",
    type: "lead_converted",
    actor: "owner",
    occurredAt: "2026-10-15T17:32:00Z",
    summary: "You marked the lead as applied",
    undoable: false,
  }),
];

function entries() {
  return within(screen.getByRole("list")).getAllByRole("listitem");
}

describe("Timeline", () => {
  it("is newest first; an automatic change has Undo; a non-undoable entry shows a caption, not a disabled button", async () => {
    const user = userEvent.setup();
    const onUndo = vi.fn();
    const onViewEmail = vi.fn();
    renderWithProviders(
      <Timeline
        events={events}
        onUndo={onUndo}
        onViewEmail={onViewEmail}
        timezone="America/Monterrey"
      />,
    );
    const items = entries();
    expect(items.map((li) => li.getAttribute("data-event-id"))).toEqual([
      "auto",
      "mail",
      "stale",
      "me",
      "old",
    ]);
    expect(within(items[0]!).getByText("Oct 27, 14:12")).toBeInTheDocument();
    expect(within(items[0]!).getByText("Moved to Interviewing")).toBeInTheDocument();

    const undo = within(items[0]!).getByRole("button", { name: "Undo" });
    await user.click(undo);
    expect(onUndo).toHaveBeenCalledWith("auto");
    await user.click(within(items[0]!).getByRole("button", { name: "View email" }));
    expect(onViewEmail).toHaveBeenCalledWith("m9");

    // the automatic change that can't be undone says so; it has no Undo button, not even a disabled one
    expect(within(items[2]!).queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
    expect(within(items[2]!).getByText(/Can't undo/)).toBeInTheDocument();
    // email and owner entries have no Undo and no caption about it
    expect(within(items[1]!).queryByText(/Can't undo/)).not.toBeInTheDocument();
    expect(within(items[3]!).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Undo" })).toHaveLength(1);
  });

  it("Timeline stops carry data-stop auto | email | owner | lead", () => {
    renderWithProviders(<Timeline events={events} onUndo={vi.fn()} onViewEmail={vi.fn()} />);
    const stopOf = (id: string) =>
      document.querySelector(`[data-event-id="${id}"] [data-stop]`)?.getAttribute("data-stop");
    expect(stopOf("auto")).toBe("auto");
    expect(stopOf("stale")).toBe("auto");
    expect(stopOf("mail")).toBe("email");
    expect(stopOf("me")).toBe("owner");
    expect(stopOf("old")).toBe("lead");
  });

  it("colors an automatic stop with the status it moved to; a rejected event is the rejected color", () => {
    const rejected = makeEvent({
      id: "rej",
      summary: "Moved to Rejected",
      toStatus: "rejected",
      undoable: true,
    });
    renderWithProviders(
      <Timeline events={[...events, rejected]} onUndo={vi.fn()} onViewEmail={vi.fn()} />,
    );
    const stop = (id: string) => document.querySelector(`[data-event-id="${id}"] [data-stop]`);
    expect(stop("stale")).toHaveAttribute("data-status", "screening");
    expect(stop("rej")).toHaveAttribute("data-status", "rejected");
    const palette = createOfferboundTheme("light").palette;
    expect(stop("rej")).toHaveStyle({ backgroundColor: palette.status.rejected.main });
    expect(stop("stale")).toHaveStyle({ backgroundColor: palette.status.screening.main });
  });

  it("an automatic event without toStatus gets the neutral color, never the route color", () => {
    renderWithProviders(
      <Timeline
        events={[makeEvent({ id: "plain", summary: "Moved to Interviewing", toStatus: null })]}
        onUndo={vi.fn()}
        onViewEmail={vi.fn()}
      />,
    );
    const stop = document.querySelector('[data-event-id="plain"] [data-stop]');
    expect(stop).not.toHaveAttribute("data-status");
    const palette = createOfferboundTheme("light").palette;
    expect(stop).toHaveStyle({ backgroundColor: palette.text.secondary });
    expect(stop).not.toHaveStyle({ backgroundColor: palette.primary.main });
  });

  it("says an undone change was undone, and u undoes the focused entry", async () => {
    const user = userEvent.setup();
    const onUndo = vi.fn();
    renderWithProviders(
      <Timeline
        events={[
          makeEvent({ id: "u1", undoable: true }),
          makeEvent({
            id: "u2",
            occurredAt: "2026-10-26T12:00:00Z",
            undoable: false,
            undoneAt: "2026-10-26T13:00:00Z",
          }),
        ]}
        onUndo={onUndo}
        onViewEmail={vi.fn()}
      />,
    );
    expect(screen.getByText("Undone on Oct 26, 07:00")).toBeInTheDocument();
    entries()[0]!.focus();
    await user.keyboard("u");
    expect(onUndo).toHaveBeenCalledWith("u1");
    entries()[1]!.focus();
    await user.keyboard("u");
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it("says the application changed afterwards only for entries that could have been undone", () => {
    const base = { actor: "system" as const, undoable: false, undoneAt: null };
    renderWithProviders(
      <Timeline
        events={[
          makeEvent({
            ...base,
            id: "t-status",
            type: "status_changed",
            occurredAt: "2026-10-27T10:00:00Z",
          }),
          makeEvent({
            ...base,
            id: "t-created",
            type: "application_created",
            messageId: "m1",
            occurredAt: "2026-10-26T10:00:00Z",
          }),
          makeEvent({
            ...base,
            id: "t-interview",
            type: "interview_created",
            occurredAt: "2026-10-25T10:00:00Z",
          }),
          makeEvent({
            ...base,
            id: "t-converted",
            type: "lead_converted",
            actor: "owner",
            occurredAt: "2026-10-24T10:00:00Z",
          }),
          makeEvent({
            ...base,
            id: "t-due",
            type: "follow_up_due",
            occurredAt: "2026-10-23T10:00:00Z",
          }),
          makeEvent({
            ...base,
            id: "t-undone",
            type: "undone",
            occurredAt: "2026-10-22T10:00:00Z",
          }),
          makeEvent({
            ...base,
            id: "t-merged",
            type: "merged",
            occurredAt: "2026-10-21T10:00:00Z",
          }),
          makeEvent({
            ...base,
            id: "t-done",
            type: "follow_up_done",
            occurredAt: "2026-10-20T10:00:00Z",
          }),
          makeEvent({
            ...base,
            id: "t-owner",
            type: "status_changed",
            actor: "owner",
            occurredAt: "2026-10-19T10:00:00Z",
          }),
        ]}
        onUndo={vi.fn()}
        onViewEmail={vi.fn()}
      />,
    );
    const captioned = entries()
      .filter((li) => within(li).queryByText(/Can't undo/) !== null)
      .map((li) => li.getAttribute("data-event-id"));
    expect(captioned).toEqual(["t-status", "t-created", "t-interview", "t-converted"]);
  });

  it("shows nothing but an empty list for no events", () => {
    renderWithProviders(<Timeline events={[]} onUndo={vi.fn()} onViewEmail={vi.fn()} />);
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });
});

describe("Timeline, a new entry arriving", () => {
  const arrival = makeEvent({
    id: "new",
    type: "status_changed",
    actor: "system",
    occurredAt: "2026-10-30T16:00:00Z",
    summary: "Moved to Screening",
    toStatus: "screening",
    undoable: true,
  });
  const noop = () => undefined;
  /** Shows the timeline; the button is a refetch that brings the new entry. */
  function Harness() {
    const [list, setList] = useState(events);
    return (
      <>
        <button onClick={() => setList([arrival, ...events])}>Refetch</button>
        <Timeline events={list} onUndo={noop} onViewEmail={noop} />
      </>
    );
  }
  const entering = () =>
    within(screen.getByRole("list"))
      .getAllByRole("listitem")
      .filter((li) => li.dataset.entering === "true")
      .map((li) => li.dataset.eventId);

  it("fades in only the entry that arrives after the first render", async () => {
    renderWithProviders(<Harness />);
    expect(entering()).toEqual([]);
    await userEvent.setup().click(screen.getByRole("button", { name: "Refetch" }));
    expect(entering()).toEqual(["new"]);
  });

  it("keeps fading the arrival through later renders, without animating the others", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    await user.click(screen.getByRole("button", { name: "Refetch" }));
    await user.click(screen.getByRole("button", { name: "Refetch" }));
    expect(entering()).toEqual(["new"]);
  });

  it("does not animate with reduced motion: the entry just appears", async () => {
    renderWithProviders(<Harness />, { reducedMotion: true });
    await userEvent.setup().click(screen.getByRole("button", { name: "Refetch" }));
    expect(entering()).toEqual([]);
    expect(document.querySelector('[data-event-id="new"]')).toBeInTheDocument();
  });
});
