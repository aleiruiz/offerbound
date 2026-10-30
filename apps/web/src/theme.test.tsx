import Alert from "@mui/material/Alert";
import Paper from "@mui/material/Paper";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "../test/render";
import { createOfferboundTheme } from "./theme";

describe("createOfferboundTheme", () => {
  it("light primary is #0a7356 and dark primary is #4fd1a5", () => {
    expect(createOfferboundTheme("light").palette.primary.main).toBe("#0a7356");
    expect(createOfferboundTheme("dark").palette.primary.main).toBe("#4fd1a5");
    expect(createOfferboundTheme("light").palette.primary.contrastText).toBe("#ffffff");
    expect(createOfferboundTheme("dark").palette.primary.contrastText).toBe("#05281d");
  });

  it("status.applied is {main:'#2f55a4', tint:'#e7edf9'} in light and {main:'#9db8f5', tint:'#1c2a47'} in dark", () => {
    expect(createOfferboundTheme("light").palette.status.applied).toEqual({
      main: "#2f55a4",
      tint: "#e7edf9",
    });
    expect(createOfferboundTheme("dark").palette.status.applied).toEqual({
      main: "#9db8f5",
      tint: "#1c2a47",
    });
  });

  it("defines a status pair for all nine statuses, interviewing following route", () => {
    const light = createOfferboundTheme("light").palette.status;
    expect(Object.keys(light).sort()).toEqual(
      [
        "abandoned",
        "accepted",
        "applied",
        "assessment",
        "interviewing",
        "offer",
        "rejected",
        "screening",
        "withdrawn",
      ].sort(),
    );
    expect(light.interviewing).toEqual({ main: "#0a7356", tint: "#e2f1eb" });
    expect(light.withdrawn).toEqual(light.abandoned);
    expect(createOfferboundTheme("dark").palette.status.rejected).toEqual({
      main: "#f5a097",
      tint: "#3d1a18",
    });
  });

  it("buttons use textTransform none, shape.borderRadius is 6 and fontFamily starts with Overpass", () => {
    const theme = createOfferboundTheme("light");
    expect(theme.typography.button.textTransform).toBe("none");
    expect(theme.shape.borderRadius).toBe(6);
    expect(theme.typography.fontFamily).toMatch(/^Overpass/);
    expect(theme.components?.MuiButton?.defaultProps?.disableElevation).toBe(true);
    expect(theme.spacing(1)).toBe("8px");
  });

  it("maps the surface and text tokens in both modes", () => {
    const light = createOfferboundTheme("light").palette;
    const dark = createOfferboundTheme("dark").palette;
    expect(light.background).toMatchObject({ default: "#f4f6f3", paper: "#ffffff" });
    expect(dark.background).toMatchObject({ default: "#0e151c", paper: "#151e27" });
    expect(light.text).toMatchObject({ primary: "#16202e", secondary: "#4d5866" });
    expect(dark.text).toMatchObject({ primary: "#e7ece9", secondary: "#a7b1ad" });
    expect(light.divider).toBe("#dce1dc");
    expect(light.warning.main).toBe("#8f5400");
    expect(dark.error.main).toBe("#ff8a80");
  });
});

describe("theme refinements", () => {
  it("an Alert has no border, while an elevation-0 Paper keeps the line border", () => {
    renderWithProviders(
      <>
        <Alert severity="warning">Heads up</Alert>
        <Alert severity="error" variant="filled">
          Broken
        </Alert>
        <Paper data-testid="paper">Section</Paper>
      </>,
    );
    for (const alert of screen.getAllByRole("alert")) {
      expect(getComputedStyle(alert).borderStyle).not.toBe("solid");
    }
    expect(getComputedStyle(screen.getByTestId("paper")).borderStyle).toBe("solid");
  });

  it("primary.dark is derived from the route token, not an invented color", () => {
    for (const mode of ["light", "dark"] as const) {
      const theme = createOfferboundTheme(mode);
      expect(theme.palette.primary.dark).not.toBe("#3bb58b");
      expect(theme.palette.primary.dark).not.toBe(theme.palette.primary.main);
    }
  });

  it("below 600px (touch) text fields default to size medium and buttons are 44px targets", () => {
    const desktop = createOfferboundTheme("light");
    const touch = createOfferboundTheme("light", { touch: true });
    expect(desktop.components?.MuiTextField?.defaultProps?.size).toBe("small");
    expect(touch.components?.MuiTextField?.defaultProps?.size).toBe("medium");
    expect(touch.components?.MuiSelect?.defaultProps?.size).toBe("medium");
    const root = touch.components?.MuiButton?.styleOverrides?.root;
    expect(root).toMatchObject({ minHeight: 44 });
    expect(touch.components?.MuiIconButton?.styleOverrides?.root).toMatchObject({
      minHeight: 44,
      minWidth: 44,
    });
  });
});
