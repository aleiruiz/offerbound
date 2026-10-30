import { useTheme } from "@mui/material/styles";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setViewport } from "../test/match-media";
import { ColorModeProvider, readStoredPreference } from "./ColorModeProvider";

function Probe() {
  return <p>{useTheme().palette.mode}</p>;
}

afterEach(() => vi.restoreAllMocks());

describe("theme mode", () => {
  it("follows prefers-color-scheme when nothing is stored", () => {
    setViewport({ width: 1280, dark: true });
    render(
      <ColorModeProvider>
        <Probe />
      </ColorModeProvider>,
    );
    expect(screen.getByText("dark")).toBeInTheDocument();
  });

  it("ob.theme light overrides a dark system preference", () => {
    setViewport({ width: 1280, dark: true });
    window.localStorage.setItem("ob.theme", "light");
    render(
      <ColorModeProvider>
        <Probe />
      </ColorModeProvider>,
    );
    expect(screen.getByText("light")).toBeInTheDocument();
  });

  it("ignores any other stored value", () => {
    window.localStorage.setItem("ob.theme", "sepia");
    expect(readStoredPreference()).toBe("system");
  });

  it("falls back to the system setting when localStorage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readStoredPreference()).toBe("system");
  });
});
