import Button from "@mui/material/Button";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DEMO_ME, OWNER_ME } from "../../test/factories";
import { renderWithProviders } from "../../test/render";
import { DemoLock, DEMO_REASON, useIsDemo } from "./demo";

function Mode() {
  return <p>{useIsDemo() ? "demo" : "private"}</p>;
}

describe("useIsDemo", () => {
  it("is true when the account says the mode is demo", () => {
    renderWithProviders(<Mode />, { me: DEMO_ME });
    expect(screen.getByText("demo")).toBeInTheDocument();
  });

  it.each([["the owner", OWNER_ME] as const, ["nobody yet", undefined] as const])(
    "is false for %s",
    (_who, me) => {
      renderWithProviders(<Mode />, me ? { me } : {});
      expect(screen.getByText("private")).toBeInTheDocument();
    },
  );
});

describe("DemoLock", () => {
  it("leaves its control alone outside the demo", () => {
    renderWithProviders(
      <DemoLock reason="add">
        <Button>Add application</Button>
      </DemoLock>,
      { me: OWNER_ME },
    );
    expect(screen.getByRole("button", { name: "Add application" })).toBeEnabled();
    expect(screen.queryByLabelText(DEMO_REASON.add)).not.toBeInTheDocument();
  });

  it("disables its control in the demo and explains why in a tooltip", async () => {
    const user = userEvent.setup({ delay: null });
    renderWithProviders(
      <DemoLock reason="add">
        <Button>Add application</Button>
      </DemoLock>,
      { me: DEMO_ME },
    );
    const button = screen.getByRole("button", { name: "Add application" });
    expect(button).toBeDisabled();
    // A disabled control takes no pointer events, so the tooltip hangs on the wrapper around it.
    await user.hover(screen.getByLabelText(DEMO_REASON.add));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(DEMO_REASON.add);
  });
});
