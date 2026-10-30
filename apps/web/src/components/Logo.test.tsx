import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "../../test/render";
import lockupDark from "../assets/brand/lockup-dark.svg";
import lockupLight from "../assets/brand/lockup.svg";
import markDark from "../assets/brand/mark-dark.svg";
import markLight from "../assets/brand/mark.svg";
import { Logo } from "./Logo";

describe("Logo", () => {
  it("renders the lockup as an image named Offerbound", () => {
    renderWithProviders(<Logo />);
    const img = screen.getByRole("img", { name: "Offerbound" });
    expect(img).toHaveAttribute("alt", "Offerbound");
    expect(img).toHaveAttribute("src", lockupLight);
  });

  it("renders the mark when asked, with the same accessible name", () => {
    renderWithProviders(<Logo variant="mark" height={28} />);
    const img = screen.getByRole("img", { name: "Offerbound" });
    expect(img).toHaveAttribute("src", markLight);
    expect(img).toHaveAttribute("height", "28");
    expect(img).toHaveAttribute("width", "28");
  });

  it("follows the theme mode: light and dark use different artwork", () => {
    expect(lockupDark).not.toBe(lockupLight);
    expect(markDark).not.toBe(markLight);
    const light = renderWithProviders(<Logo />, { mode: "light" });
    expect(screen.getByRole("img", { name: "Offerbound" })).toHaveAttribute("src", lockupLight);
    light.unmount();
    const dark = renderWithProviders(<Logo variant="mark" />, { mode: "dark" });
    expect(screen.getByRole("img", { name: "Offerbound" })).toHaveAttribute("src", markDark);
    dark.unmount();
  });

  it("mode overrides the theme for surfaces that are always dark", () => {
    renderWithProviders(<Logo mode="dark" />, { mode: "light" });
    expect(screen.getByRole("img", { name: "Offerbound" })).toHaveAttribute("src", lockupDark);
  });

  it("a decorative logo has an empty alt and no accessible name", () => {
    renderWithProviders(<Logo decorative />);
    expect(screen.queryByRole("img", { name: "Offerbound" })).not.toBeInTheDocument();
    expect(document.querySelector("img")).toHaveAttribute("alt", "");
  });
});
