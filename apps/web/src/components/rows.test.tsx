import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { makeApplication, makeInterview } from "../../test/factories";
import { renderWithProviders } from "../../test/render";
import { FollowUpRow } from "./FollowUpRow";
import { InterviewRow } from "./InterviewRow";
import { TargetMeter } from "./TargetMeter";

const NOW = new Date("2026-10-29T18:00:00Z");
const TZ = "America/Monterrey";

describe("FollowUpRow", () => {
  it("states the reason in plain words and has Mark followed up and Open", async () => {
    const user = userEvent.setup();
    const onMarkFollowedUp = vi.fn();
    const app = makeApplication({ appliedAt: "2026-10-20T15:00:00Z" });
    renderWithProviders(
      <ul>
        <FollowUpRow
          application={app}
          now={NOW}
          timezone={TZ}
          onMarkFollowedUp={onMarkFollowedUp}
        />
      </ul>,
    );
    expect(screen.getByText("Northwind Robotics")).toBeInTheDocument();
    expect(
      screen.getByText("Senior Full-stack Engineer. Applied Oct 20, no reply for 9 days."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Mark followed up" }));
    expect(onMarkFollowedUp).toHaveBeenCalledWith(app);
    expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute("href", "/applications/a1");
  });

  it("uses the last company reply when there is one", () => {
    renderWithProviders(
      <ul>
        <FollowUpRow
          application={makeApplication({ lastCompanyActivityAt: "2026-10-21T16:00:00Z" })}
          now={NOW}
          timezone={TZ}
          onMarkFollowedUp={vi.fn()}
        />
      </ul>,
    );
    expect(
      screen.getByText(
        "Senior Full-stack Engineer. Last reply from the company Oct 21, 8 days ago.",
      ),
    ).toBeInTheDocument();
  });
});

describe("InterviewRow", () => {
  it("shows the time range in the owner's zone, the kind, the people and the call link", () => {
    renderWithProviders(
      <ul>
        <InterviewRow interview={makeInterview()} timezone={TZ} now={NOW} />
      </ul>,
    );
    expect(screen.getByText("10:00–11:00")).toBeInTheDocument();
    expect(screen.getByText("Technical interview")).toBeInTheDocument();
    expect(screen.getByText("Tomorrow")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Kestrel Pay, Senior Frontend Engineer. With Priya Natarajan and Tom Salas.",
      ),
    ).toBeInTheDocument();
    const join = screen.getByRole("link", { name: "Join video call" });
    expect(join).toHaveAttribute("href", "https://meet.example/kestrel");
    expect(join).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByRole("link", { name: "Open application" })).toHaveAttribute(
      "href",
      "/applications/a1",
    );
  });

  it("says No time yet for an interview to schedule and offers Pick a time", () => {
    renderWithProviders(
      <ul>
        <InterviewRow
          interview={makeInterview({
            status: "to_schedule",
            startsAt: null,
            endsAt: null,
            meetingUrl: null,
            interviewers: [],
            kind: "hiring_manager",
            schedulingUrl: "https://schedule.example/pick",
          })}
          timezone={TZ}
          now={NOW}
        />
      </ul>,
    );
    expect(screen.getByText("No time yet")).toBeInTheDocument();
    expect(screen.getByText("Hiring manager interview")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Pick a time" })).toHaveAttribute(
      "href",
      "https://schedule.example/pick",
    );
  });
});

describe("TargetMeter", () => {
  it("shows the value, the range, a progressbar with values and the actions", async () => {
    const user = userEvent.setup();
    const onLog = vi.fn();
    renderWithProviders(
      <TargetMeter
        label="Applications"
        value={3}
        min={8}
        max={12}
        caption="Pick from 6 shortlisted"
        actions={
          <button type="button" onClick={onLog}>
            +1 message
          </button>
        }
      />,
    );
    expect(screen.getByText("Applications")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("of 8–12")).toBeInTheDocument();
    const bar = screen.getByRole("progressbar", { name: "Applications" });
    expect(bar).toHaveAttribute("aria-valuenow", "3");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "12");
    expect(screen.getByText("Pick from 6 shortlisted")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "+1 message" }));
    expect(onLog).toHaveBeenCalled();
  });

  it("says Target met, handles a single target and a unit, and caps the bar at 100%", () => {
    renderWithProviders(
      <>
        <TargetMeter label="New leads" value={24} min={20} max={30} />
        <TargetMeter label="Interview prep" value={30} min={90} unit="min" />
      </>,
    );
    expect(screen.getByText("Target met")).toBeInTheDocument();
    expect(screen.getByText("of 90 min")).toBeInTheDocument();
    const full = screen.getByRole("progressbar", { name: "New leads" });
    expect(full).toHaveAttribute("aria-valuenow", "24");
    expect(full).toHaveAttribute("aria-valuemax", "30");
    const part = within(screen.getByText("Interview prep").parentElement!).getByRole("progressbar");
    expect(part).toHaveAttribute("aria-valuemax", "90");
  });
});

describe("TargetMeter bounds", () => {
  it("never reports a value above aria-valuemax", () => {
    renderWithProviders(<TargetMeter label="Outreach" value={7} min={5} />);
    const bar = screen.getByRole("progressbar", { name: "Outreach" });
    expect(bar).toHaveAttribute("aria-valuenow", "7");
    expect(bar).toHaveAttribute("aria-valuemax", "7");
  });
});

describe("row actions below 600px move into a ⋯ menu", () => {
  it("FollowUpRow", async () => {
    const user = userEvent.setup();
    const onMarkFollowedUp = vi.fn();
    renderWithProviders(
      <ul>
        <FollowUpRow
          application={makeApplication()}
          now={NOW}
          timezone={TZ}
          onMarkFollowedUp={onMarkFollowedUp}
        />
      </ul>,
      { width: 400 },
    );
    expect(screen.queryByRole("button", { name: "Mark followed up" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Mark followed up" }));
    expect(onMarkFollowedUp).toHaveBeenCalledTimes(1);
  });

  it("InterviewRow", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ul>
        <InterviewRow interview={makeInterview()} timezone={TZ} now={NOW} onPrepNotes={vi.fn()} />
      </ul>,
      { width: 400 },
    );
    expect(screen.queryByRole("link", { name: "Open application" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "More actions" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Open application" })).toHaveAttribute(
      "href",
      "/applications/a1",
    );
    expect(within(menu).getByRole("menuitem", { name: "Prep notes" })).toBeInTheDocument();
  });
});
