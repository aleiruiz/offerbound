import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { makeMessage } from "../../test/factories";
import { apiError, mockApi } from "../../test/mock-api";
import { renderWithProviders } from "../../test/render";
import { EmailSheet } from "./EmailSheet";

describe("EmailSheet", () => {
  it("renders the body as text and links only http(s) URLs with rel='noopener noreferrer'", async () => {
    const body = [
      "See https://careers.example/apply?id=7, then http://plain.example/x.",
      "Not a link: javascript:alert(1) and ftp://files.example/a and data:text/html,hi",
      '<script>alert("x")</script> <b>bold</b>',
    ].join("\n");
    mockApi({ "GET /api/v1/messages/m1": () => makeMessage({ bodyText: body }) });
    renderWithProviders(<EmailSheet messageId="m1" onClose={vi.fn()} />);

    const dialog = await screen.findByRole("dialog", { name: "Next steps" });
    const links = within(dialog).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "https://careers.example/apply?id=7",
      "http://plain.example/x",
    ]);
    for (const a of links) {
      expect(a).toHaveAttribute("rel", "noopener noreferrer");
      expect(a).toHaveAttribute("target", "_blank");
    }
    // markup in the body stays text
    expect(dialog.querySelector("script")).toBeNull();
    expect(dialog.querySelector("b")).toBeNull();
    expect(
      within(dialog).getByText(/<script>alert\("x"\)<\/script> <b>bold<\/b>/),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/javascript:alert\(1\)/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Dana Ortiz/)).toBeInTheDocument();
  });

  it("shows loading, then the sender and date, and closes", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    mockApi({ "GET /api/v1/messages/m1": () => makeMessage() });
    renderWithProviders(
      <EmailSheet messageId="m1" onClose={onClose} timezone="America/Monterrey" />,
    );
    expect(screen.getByLabelText("Loading email")).toBeInTheDocument();
    expect(await screen.findByText("Oct 27, 14:00")).toBeInTheDocument();
    expect(screen.getByText(/dana@kestrel\.example/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("shows an error with Try again when the email cannot be loaded", async () => {
    mockApi({ "GET /api/v1/messages/m1": () => apiError(404, "not_found", "No such email.") });
    renderWithProviders(<EmailSheet messageId="m1" onClose={vi.fn()} />);
    expect(await screen.findByText(/Couldn't load the email/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("renders nothing when no message is selected", () => {
    const api = mockApi({});
    const { container } = renderWithProviders(<EmailSheet messageId={null} onClose={vi.fn()} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
    expect(api.calls).toHaveLength(0);
  });

  it("says when an email has no text", async () => {
    mockApi({ "GET /api/v1/messages/m2": () => makeMessage({ id: "m2", bodyText: null }) });
    renderWithProviders(<EmailSheet messageId="m2" onClose={vi.fn()} />);
    expect(await screen.findByText("This email has no text to show.")).toBeInTheDocument();
  });
});
