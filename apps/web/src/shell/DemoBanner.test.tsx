import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DEMO_ME, OWNER_ME } from "../../test/factories";
import { apiError, mockApi, type MockHandler } from "../../test/mock-api";
import { renderWithProviders } from "../../test/render";
import { UndoSnackbar } from "../components/UndoSnackbar";
import { DemoBanner } from "./DemoBanner";

vi.setConfig({ testTimeout: 15_000 });

function setup(routes: Record<string, MockHandler> = {}, me = DEMO_ME) {
  const api = mockApi({
    "POST /api/v1/demo/simulate-email": () =>
      new Response('{"messageId":"m-sim-1"}', { status: 202 }),
    ...routes,
  });
  const rendered = renderWithProviders(
    <>
      <DemoBanner />
      <UndoSnackbar />
    </>,
    { me },
  );
  return { api, ...rendered, user: userEvent.setup({ delay: null }) };
}

describe("DemoBanner", () => {
  // AC-16.3
  it("demo mode shows 'Demo with made-up data. Everything resets every hour.' and Simulate an incoming email", () => {
    setup();
    const banner = screen.getByRole("region", { name: "Demo" });
    expect(banner).toHaveTextContent("Demo with made-up data. Everything resets every hour.");
    expect(banner).toHaveTextContent("Writing notes and importing files are turned off.");
    expect(screen.getByRole("button", { name: "Simulate an incoming email" })).toBeEnabled();
  });

  it("shows nothing for the owner", () => {
    setup({}, OWNER_ME);
    expect(screen.queryByRole("region", { name: "Demo" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Simulate an incoming email" }),
    ).not.toBeInTheDocument();
  });

  // AC-16.4
  it("Simulate an incoming email asks the server for the next one, then refreshes what is on screen", async () => {
    const { api, queryClient, user } = setup();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await user.click(screen.getByRole("button", { name: "Simulate an incoming email" }));
    await waitFor(() => expect(invalidate).toHaveBeenCalled());
    const posts = api.calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(new URL(posts[0]!.url).pathname).toBe("/api/v1/demo/simulate-email");
    expect(posts[0]!.headers.get("X-Offerbound-Request")).toBe("1");
    // Everything an email can change is fetched again: the whole cache, not a list of keys.
    expect(invalidate).toHaveBeenCalledWith();
    expect(await screen.findByRole("status")).toHaveTextContent("Simulated an email");
  });

  it("holds the button while the email goes through", async () => {
    let finish: (r: Response) => void = () => {};
    const { user } = setup({
      "POST /api/v1/demo/simulate-email": () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    });
    await user.click(screen.getByRole("button", { name: "Simulate an incoming email" }));
    expect(await screen.findByRole("button", { name: "Simulating" })).toBeDisabled();
    finish(new Response('{"messageId":"m"}', { status: 202 }));
    expect(await screen.findByRole("button", { name: "Simulate an incoming email" })).toBeEnabled();
  });

  it("says so when the demo is rate limited", async () => {
    const { user } = setup({
      "POST /api/v1/demo/simulate-email": () => apiError(429, "rate_limited", "Slow down."),
    });
    await user.click(screen.getByRole("button", { name: "Simulate an incoming email" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Too many requests. Wait a minute and try again.",
    );
  });

  it("says plainly when it did not work", async () => {
    const { user } = setup({
      "POST /api/v1/demo/simulate-email": () => apiError(500, "internal_error", "Boom."),
    });
    await user.click(screen.getByRole("button", { name: "Simulate an incoming email" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't simulate an email. Try again.",
    );
  });
});
