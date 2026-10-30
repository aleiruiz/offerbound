import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "../../test/render";
import { createOfferboundTheme } from "../theme";
import { FlagChip, StatusChip } from "./StatusChip";

describe("StatusChip", () => {
  it("shows the status word on its tint; Abandoned has a dashed border", () => {
    const { status } = createOfferboundTheme("light").palette;
    renderWithProviders(
      <>
        <StatusChip status="screening" />
        <StatusChip status="withdrawn" />
        <StatusChip status="abandoned" />
      </>,
    );
    const screening = screen.getByText("Screening").closest(".MuiChip-root");
    expect(screening).toHaveStyle({
      backgroundColor: status.screening.tint,
      color: status.screening.main,
    });
    const withdrawn = screen.getByText("Withdrawn").closest(".MuiChip-root");
    const abandoned = screen.getByText("Abandoned").closest(".MuiChip-root");
    expect(abandoned).toHaveStyle({ borderStyle: "dashed", borderWidth: "1px" });
    expect(withdrawn).not.toHaveStyle({ borderStyle: "dashed" });
    expect(abandoned).toHaveAttribute("data-status", "abandoned");
  });

  it("uses the dark pair in dark mode", () => {
    const { status } = createOfferboundTheme("dark").palette;
    renderWithProviders(<StatusChip status="rejected" />, { mode: "dark" });
    expect(screen.getByText("Rejected").closest(".MuiChip-root")).toHaveStyle({
      backgroundColor: status.rejected.tint,
      color: status.rejected.main,
    });
  });
});

describe("FlagChip", () => {
  it("renders signal, route and neutral flags with their words", () => {
    const light = createOfferboundTheme("light").palette;
    renderWithProviders(
      <>
        <FlagChip tone="signal" label="Estimate" />
        <FlagChip tone="route" label="Verified posting" />
        <FlagChip tone="neutral" label="Remote" />
      </>,
    );
    expect(screen.getByText("Estimate").closest(".MuiChip-root")).toHaveStyle({
      backgroundColor: light.tokens.signalTint,
      color: light.warning.main,
    });
    expect(screen.getByText("Verified posting").closest(".MuiChip-root")).toHaveStyle({
      backgroundColor: light.tokens.routeTint,
      color: light.primary.main,
    });
    expect(screen.getByText("Remote").closest(".MuiChip-root")).toHaveStyle({
      backgroundColor: light.status.withdrawn.tint,
    });
  });
});
