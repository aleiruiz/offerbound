import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClientError } from "../api/client";
import { apiError } from "../../test/mock-api";
import { renderWithProviders } from "../../test/render";
import { EmptyState, ErrorState, ListSkeleton } from "./States";
import { UndoSnackbar, useUndoSnackbar } from "./UndoSnackbar";

function Trigger({ onUndo }: { onUndo?: () => Promise<void> }) {
  const { show } = useUndoSnackbar();
  return (
    <button type="button" onClick={() => show("Marked as applied", onUndo)}>
      Go
    </button>
  );
}

afterEach(() => vi.useRealTimers());

describe("UndoSnackbar", () => {
  it("shows the message with Undo on the ink ground, runs the undo, then says Undone", async () => {
    const user = userEvent.setup();
    const onUndo = vi.fn(() => Promise.resolve());
    renderWithProviders(
      <>
        <Trigger onUndo={onUndo} />
        <UndoSnackbar />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "Go" }));
    expect(screen.getByText("Marked as applied")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Undone")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  });

  it("goes away after 6 seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithProviders(
      <>
        <Trigger onUndo={() => Promise.resolve()} />
        <UndoSnackbar />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "Go" }));
    expect(screen.getByText("Marked as applied")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(5900);
    });
    expect(screen.getByText("Marked as applied")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    await vi.waitFor(() => expect(screen.queryByText("Marked as applied")).not.toBeInTheDocument());
  });

  it("explains when the change can no longer be undone", async () => {
    const user = userEvent.setup();
    const err = new ApiClientError({ status: 409, code: "changed_since", message: "Changed." });
    renderWithProviders(
      <>
        <Trigger onUndo={() => Promise.reject(err)} />
        <UndoSnackbar />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "Go" }));
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(
      await screen.findByText(
        "Can't undo: this application changed after the update. Edit it directly.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("shows a message without an action when there is nothing to undo", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <Trigger />
        <UndoSnackbar />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "Go" }));
    expect(screen.getByText("Marked as applied")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  });
});

describe("States", () => {
  it("EmptyState names the next action", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    renderWithProviders(
      <EmptyState
        title="No applications yet"
        body="Import your spreadsheet or start syncing Gmail, and your applications show up here."
        actions={
          <button type="button" onClick={onClick}>
            Import spreadsheet
          </button>
        }
      />,
    );
    expect(screen.getByText("No applications yet")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Import spreadsheet" }));
    expect(onClick).toHaveBeenCalled();
  });

  it("ListSkeleton is a busy region with the requested rows", () => {
    renderWithProviders(<ListSkeleton label="Loading leads" rows={3} />);
    const region = screen.getByLabelText("Loading leads");
    expect(region).toHaveAttribute("aria-busy", "true");
    expect(region.querySelectorAll("[data-skeleton-row]")).toHaveLength(3);
  });

  it("ErrorState says what failed, shows the server's words and retries", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const res = apiError(502, "upstream_error", "Google did not answer.");
    const body = (await res.json()) as { error: { message: string } };
    const error = new ApiClientError({
      status: 502,
      code: "upstream_error",
      message: body.error.message,
    });
    renderWithProviders(<ErrorState what="leads" error={error} onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load leads.");
    expect(screen.getByRole("alert")).toHaveTextContent("Google did not answer.");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("ErrorState falls back to a plain sentence for network failures", () => {
    renderWithProviders(<ErrorState what="interviews" error={new TypeError("Failed to fetch")} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load interviews.");
    expect(screen.getByRole("alert")).toHaveTextContent("Check your connection");
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });
});
