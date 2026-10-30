import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import lockupDark from "../assets/brand/lockup-dark.svg";
import { renderWithProviders } from "../../test/render";
import { LoginPage } from "./LoginPage";

describe("LoginPage", () => {
  it("the sign-in page renders the wordmark, 'Welcome back' and one 'Sign in with Google' link to /api/v1/auth/google/start", () => {
    renderWithProviders(<LoginPage />, { route: "/login" });
    expect(screen.getByRole("img", { name: "Offerbound" })).toHaveAttribute("src", lockupDark);
    expect(
      screen.getByText(
        /Every application, interview and lead, kept current from your inbox\. Next stop: the offer\./,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Welcome back" })).toBeInTheDocument();
    expect(
      screen.getByText("This Offerbound is private. Sign in with its owner's Google account."),
    ).toBeInTheDocument();
    const links = screen.getAllByRole("link", { name: "Sign in with Google" });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "/api/v1/auth/google/start");
    expect(screen.getByText(window.location.host)).toBeInTheDocument();
  });

  it("the sign-in page shows the read-only Gmail note and the public demo link", () => {
    renderWithProviders(<LoginPage />, { route: "/login" });
    expect(screen.getByText("Read-only Gmail access.")).toBeInTheDocument();
    expect(
      screen.getByText(
        /Offerbound never sends, deletes or labels email\. Google will say the app isn't verified; that's expected for a personal app\./,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/Just looking around\?/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the public demo" })).toHaveAttribute(
      "href",
      "https://offerbound.northsoftmx.com",
    );
  });

  it("the route marker is marked aria-hidden and has data-testid='route-marker'", () => {
    renderWithProviders(<LoginPage />, { route: "/login" });
    const marker = screen.getByTestId("route-marker");
    expect(marker).toHaveAttribute("aria-hidden", "true");
  });

  it("labels the five stops of the route line, with the decoration hidden from assistive tech", () => {
    renderWithProviders(<LoginPage />, { route: "/login" });
    for (const label of ["Applied", "Screening", "Assessment", "Interviewing", "Offer"]) {
      const el = screen.getByText(label);
      expect(el.closest("[aria-hidden='true']")).not.toBeNull();
    }
  });

  it("?error=expired shows the expired sign-in message", () => {
    renderWithProviders(<LoginPage />, { route: "/login?error=expired" });
    expect(screen.getByRole("alert")).toHaveTextContent("Sign-in took too long. Try again.");
  });

  it("shows no error banner by default", () => {
    renderWithProviders(<LoginPage />, { route: "/login" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
