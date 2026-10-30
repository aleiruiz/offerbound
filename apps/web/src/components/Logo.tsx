import Box from "@mui/material/Box";
import { useTheme } from "@mui/material/styles";
import type { CSSProperties } from "react";
import lockupDark from "../assets/brand/lockup-dark.svg";
import lockupLight from "../assets/brand/lockup.svg";
import markDark from "../assets/brand/mark-dark.svg";
import markLight from "../assets/brand/mark.svg";
import type { ThemeMode } from "../theme";

export interface LogoProps {
  /** `lockup` is the mark with the outlined name; `mark` is the symbol alone. */
  variant?: "lockup" | "mark";
  /** Rendered height in px; the width follows the artwork's aspect ratio. */
  height?: number;
  /** Forces a variant for surfaces that ignore the theme (the sign-in panel is always dark). */
  mode?: ThemeMode;
  /** Use `alt=""` when the brand name is already announced next to the logo. */
  decorative?: boolean;
  /** Layout tweaks only (margin, width); the artwork keeps its aspect ratio. */
  style?: CSSProperties;
}

// Both artworks are static SVGs from brand/logo-concepts/b-destino. The "dark" files are the
// variants drawn for dark surfaces (lighter ink and green), not dark-coloured logos.
const ART = {
  lockup: { light: lockupLight, dark: lockupDark, ratio: 292 / 64 },
  mark: { light: markLight, dark: markDark, ratio: 1 },
} as const;

/** The Offerbound logo. It follows the MUI theme mode unless `mode` says otherwise. */
export function Logo({
  variant = "lockup",
  height = 32,
  mode,
  decorative = false,
  style,
}: LogoProps) {
  const themeMode = useTheme().palette.mode;
  const art = ART[variant];
  const src = art[mode ?? themeMode];
  return (
    <Box
      component="img"
      src={src}
      alt={decorative ? "" : "Offerbound"}
      width={Math.round(height * art.ratio)}
      height={height}
      draggable={false}
      sx={{ display: "block", flexShrink: 0, maxWidth: "100%" }}
      style={style}
    />
  );
}
