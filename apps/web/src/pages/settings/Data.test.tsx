import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { apiError, mockApi, type MockApi, type MockHandler } from "../../../test/mock-api";
import { renderWithProviders } from "../../../test/render";
import { Data } from "./Data";

vi.setConfig({ testTimeout: 15_000 });

const PATH = "/api/v1/data/purge-email-content";

function setup(routes: Record<string, MockHandler> = {}) {
  const api: MockApi = mockApi({
    [`POST ${PATH}`]: () => ({ messagesPurged: 0 }),
    ...routes,
  });
  const rendered = renderWithProviders(
    <Routes>
      <Route path="/settings/data" element={<Data />} />
    </Routes>,
    { route: "/settings/data" },
  );
  return { api, ...rendered, user: userEvent.setup({ delay: null }) };
}

const purges = (api: MockApi) => api.calls.filter((c) => c.method === "POST");

describe("Settings, Data", () => {
  it("says what is deleted and what stays", () => {
    setup();
    const section = screen.getByRole("region", { name: "Data" });
    expect(within(section).getByRole("heading", { level: 2, name: "Data" })).toBeInTheDocument();
    expect(within(section).getByText(/Your applications, leads, interviews/)).toBeInTheDocument();
    expect(within(section).getByText(/can't be undone/)).toBeInTheDocument();
    expect(
      within(section).getByRole("heading", { level: 3, name: "Delete stored email content" }),
    ).toBeInTheDocument();
  });

  it("keeps the button disabled until DELETE is typed exactly", async () => {
    const { user, api } = setup();
    const button = screen.getByRole("button", { name: "Delete stored email content" });
    const field = screen.getByRole("textbox", { name: "Type DELETE to confirm" });
    expect(button).toBeDisabled();

    for (const text of ["D", "delete", "DELETE ", " DELETE", "DELETED", "Delete"]) {
      await user.clear(field);
      await user.type(field, text);
      expect(button).toBeDisabled();
    }
    await user.clear(field);
    await user.type(field, "DELETE");
    expect(button).toBeEnabled();

    await user.type(field, "x");
    expect(button).toBeDisabled();
    expect(purges(api)).toHaveLength(0);
  });

  it("posts the exact body and shows how many emails were cleared", async () => {
    const { user, api } = setup({ [`POST ${PATH}`]: () => ({ messagesPurged: 1234 }) });
    const field = screen.getByRole("textbox", { name: "Type DELETE to confirm" });
    await user.type(field, "DELETE");
    await user.click(screen.getByRole("button", { name: "Delete stored email content" }));

    expect(
      await screen.findByText("Deleted the stored content of 1,234 emails."),
    ).toBeInTheDocument();
    const [call] = purges(api);
    expect(call?.headers.get("X-Offerbound-Request")).toBe("1");
    expect(call?.headers.get("Content-Type")).toBe("application/json");
    expect(await call?.json()).toEqual({ confirm: "DELETE" });
    // The field is cleared, so a second click needs a new confirmation.
    expect(field).toHaveValue("");
    expect(screen.getByRole("button", { name: "Delete stored email content" })).toBeDisabled();
  });

  it("uses the singular for one email and says so when there was nothing to delete", async () => {
    const answers = [{ messagesPurged: 1 }, { messagesPurged: 0 }];
    const { user } = setup({ [`POST ${PATH}`]: () => answers.shift() });
    const field = screen.getByRole("textbox", { name: "Type DELETE to confirm" });
    const button = screen.getByRole("button", { name: "Delete stored email content" });

    await user.type(field, "DELETE");
    await user.click(button);
    expect(await screen.findByText("Deleted the stored content of 1 email.")).toBeInTheDocument();

    await user.type(field, "DELETE");
    await user.click(button);
    expect(
      await screen.findByText("There was no stored email content to delete."),
    ).toBeInTheDocument();
  });

  it.each([
    [400, "validation_failed", "Type DELETE to confirm."],
    [500, "internal_error", "Something went wrong on our side."],
  ])("shows an error and keeps the confirmation on a %i", async (status, code, message) => {
    const { user } = setup({ [`POST ${PATH}`]: () => apiError(status, code, message) });
    const field = screen.getByRole("textbox", { name: "Type DELETE to confirm" });
    await user.type(field, "DELETE");
    await user.click(screen.getByRole("button", { name: "Delete stored email content" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(`Couldn't delete the stored email content. ${message}`);
    expect(screen.queryByText(/Deleted the stored content/)).not.toBeInTheDocument();
    // Nothing was reported as deleted, so the owner can try again straight away.
    expect(field).toHaveValue("DELETE");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Delete stored email content" })).toBeEnabled(),
    );
  });

  it("shows a connection message when the request never arrives", async () => {
    const { user } = setup({
      [`POST ${PATH}`]: () => {
        throw new TypeError("Failed to fetch");
      },
    });
    await user.type(screen.getByRole("textbox", { name: "Type DELETE to confirm" }), "DELETE");
    await user.click(screen.getByRole("button", { name: "Delete stored email content" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't delete the stored email content. Check your connection and try again.",
    );
  });

  it("clears an earlier result when the confirmation is typed again", async () => {
    const { user } = setup({ [`POST ${PATH}`]: () => ({ messagesPurged: 3 }) });
    const field = screen.getByRole("textbox", { name: "Type DELETE to confirm" });
    await user.type(field, "DELETE");
    await user.click(screen.getByRole("button", { name: "Delete stored email content" }));
    expect(await screen.findByText("Deleted the stored content of 3 emails.")).toBeInTheDocument();
    await user.type(field, "D");
    expect(screen.queryByText(/Deleted the stored content/)).not.toBeInTheDocument();
  });
});
