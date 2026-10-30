import BookmarkBorderOutlined from "@mui/icons-material/BookmarkBorderOutlined";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../../test/render";
import { RowActions, type RowAction } from "./RowActions";

const REASON = "Turned off for this test.";

function icon(extra: Partial<RowAction> = {}): RowAction {
  return {
    key: "shortlist",
    label: "Shortlist",
    kind: "icon",
    icon: <BookmarkBorderOutlined />,
    onClick: vi.fn(),
    ...extra,
  };
}

describe("RowActions, disabledReason", () => {
  it("an icon action with a reason is disabled and explains why in a tooltip", async () => {
    const action = icon({ disabledReason: REASON });
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<RowActions actions={[action]} />);
    const button = screen.getByRole("button", { name: "Shortlist" });
    expect(button).toBeDisabled();
    // A disabled button takes no pointer events: the tooltip hangs on the wrapper.
    await user.hover(screen.getByLabelText(REASON));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(REASON);
    expect(action.onClick).not.toHaveBeenCalled();
  });

  it("an icon action without a reason works and keeps its label as the tooltip", async () => {
    const action = icon();
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<RowActions actions={[action]} />);
    await user.click(screen.getByRole("button", { name: "Shortlist" }));
    expect(action.onClick).toHaveBeenCalledTimes(1);
  });

  it("a text action with a reason is disabled too", () => {
    renderWithProviders(
      <RowActions actions={[icon({ kind: "text", icon: undefined, disabledReason: REASON })]} />,
    );
    expect(screen.getByRole("button", { name: "Shortlist" })).toBeDisabled();
    expect(screen.getByLabelText(REASON)).toBeInTheDocument();
  });
});
