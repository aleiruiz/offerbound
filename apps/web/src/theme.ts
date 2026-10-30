import { createTheme, type Shadows, type Theme } from "@mui/material/styles";
import type { ApplicationStatus } from "@offerbound/contracts";

export type ThemeMode = "light" | "dark";

export interface StatusColor {
  main: string;
  tint: string;
}

/** Tokens without a standard MUI palette key (docs/design/tokens.json). */
export interface OfferboundTokens {
  surfaceSunken: string;
  lineControl: string;
  routeTint: string;
  signalTint: string;
  stopTint: string;
}

declare module "@mui/material/styles" {
  interface Palette {
    status: Record<ApplicationStatus, StatusColor>;
    tokens: OfferboundTokens;
  }
  interface PaletteOptions {
    status?: Record<ApplicationStatus, StatusColor>;
    tokens?: OfferboundTokens;
  }
}

// Values: docs/design/tokens.json and DESIGN_SPEC §2.2.
const light = {
  bg: "#f4f6f3",
  surface: "#ffffff",
  surfaceSunken: "#ecf0ec",
  ink: "#16202e",
  inkMuted: "#4d5866",
  line: "#dce1dc",
  lineControl: "#7a8580",
  route: "#0a7356",
  routeDark: "#075a43",
  onRoute: "#ffffff",
  routeTint: "#e2f1eb",
  signal: "#8f5400",
  signalTint: "#fcefd8",
  stop: "#b3261e",
  stopTint: "#fbe8e6",
  shadow: "0 8px 24px rgba(22,32,46,0.16)",
  status: {
    applied: { main: "#2f55a4", tint: "#e7edf9" },
    screening: { main: "#6a46a8", tint: "#f0eaf8" },
    assessment: { main: "#00687a", tint: "#dff1f4" },
    interviewing: { main: "#0a7356", tint: "#e2f1eb" },
    offer: { main: "#755600", tint: "#faf1d3" },
    accepted: { main: "#0b5e2e", tint: "#dcf1e3" },
    rejected: { main: "#9b2c22", tint: "#fbe8e6" },
    withdrawn: { main: "#545e6a", tint: "#eceff2" },
    abandoned: { main: "#545e6a", tint: "#eceff2" },
  },
} as const;

const dark = {
  bg: "#0e151c",
  surface: "#151e27",
  surfaceSunken: "#1b2631",
  ink: "#e7ece9",
  inkMuted: "#a7b1ad",
  line: "#26313b",
  lineControl: "#6e7b85",
  route: "#4fd1a5",
  routeDark: "#3bb58b",
  onRoute: "#05281d",
  routeTint: "#12352b",
  signal: "#f2b24c",
  signalTint: "#3a2a0e",
  stop: "#ff8a80",
  stopTint: "#3d1a18",
  shadow: "0 8px 24px rgba(0,0,0,0.55)",
  status: {
    applied: { main: "#9db8f5", tint: "#1c2a47" },
    screening: { main: "#c7aef5", tint: "#2c2147" },
    assessment: { main: "#6fd3e3", tint: "#0f3036" },
    interviewing: { main: "#4fd1a5", tint: "#12352b" },
    offer: { main: "#ebcb5c", tint: "#362c0a" },
    accepted: { main: "#7ddb9e", tint: "#133322" },
    rejected: { main: "#f5a097", tint: "#3d1a18" },
    withdrawn: { main: "#b4bcc5", tint: "#232d37" },
    abandoned: { main: "#b4bcc5", tint: "#232d37" },
  },
} as const;

const fontFamily = 'Overpass, "Segoe UI", system-ui, sans-serif';

const label = { fontSize: "14px", lineHeight: "20px", fontWeight: 600 } as const;

export function createOfferboundTheme(mode: ThemeMode): Theme {
  const t = mode === "light" ? light : dark;
  // Everything that floats shares one shadow; in-page sections are outlined and have none.
  const shadows = ["none", ...Array<string>(24).fill(t.shadow)] as Shadows;

  return createTheme({
    palette: {
      mode,
      primary: { main: t.route, dark: t.routeDark, contrastText: t.onRoute },
      warning: { main: t.signal },
      error: { main: t.stop },
      background: { default: t.bg, paper: t.surface },
      text: { primary: t.ink, secondary: t.inkMuted },
      divider: t.line,
      status: t.status,
      tokens: {
        surfaceSunken: t.surfaceSunken,
        lineControl: t.lineControl,
        routeTint: t.routeTint,
        signalTint: t.signalTint,
        stopTint: t.stopTint,
      },
    },
    shape: { borderRadius: 6 },
    spacing: 8,
    shadows,
    typography: {
      fontFamily,
      h3: {
        fontSize: "32px",
        lineHeight: "36px",
        fontWeight: 800,
        fontVariantNumeric: "tabular-nums",
      },
      h4: { fontSize: "24px", lineHeight: "32px", fontWeight: 700 },
      h6: { fontSize: "18px", lineHeight: "24px", fontWeight: 700 },
      body1: { fontSize: "15px", lineHeight: "22px", fontWeight: 400 },
      body2: { fontSize: "14px", lineHeight: "20px", fontWeight: 400 },
      subtitle2: label,
      button: { ...label, textTransform: "none" },
      caption: { fontSize: "13px", lineHeight: "18px", fontWeight: 400 },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          ":focus-visible": { outline: `2px solid ${t.route}`, outlineOffset: "2px" },
          "table, [role='progressbar'], [role='meter']": { fontVariantNumeric: "tabular-nums" },
        },
      },
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: {
          root: { textTransform: "none" },
          outlined: { borderColor: t.lineControl },
        },
      },
      MuiPaper: {
        defaultProps: { elevation: 0 },
        styleOverrides: {
          root: ({ ownerState }) => ({
            backgroundImage: "none",
            ...(ownerState.variant !== "outlined" && ownerState.elevation === 0
              ? { border: `1px solid ${t.line}` }
              : {}),
          }),
        },
      },
      MuiAppBar: { defaultProps: { elevation: 0 } },
      MuiChip: {
        defaultProps: { size: "small" },
        styleOverrides: { root: { borderRadius: 4, fontWeight: 600 } },
      },
      MuiTextField: { defaultProps: { size: "small", variant: "outlined" } },
      MuiSelect: { defaultProps: { size: "small", variant: "outlined" } },
      MuiOutlinedInput: {
        styleOverrides: {
          root: { borderRadius: 4 },
          notchedOutline: { borderColor: t.lineControl },
        },
      },
      MuiTableCell: {
        styleOverrides: {
          root: { fontVariantNumeric: "tabular-nums" },
          head: { ...label, backgroundColor: t.surfaceSunken, color: t.inkMuted },
        },
      },
      MuiTabs: { styleOverrides: { indicator: { backgroundColor: t.route } } },
      MuiTab: { styleOverrides: { root: { textTransform: "none" } } },
      MuiTooltip: { defaultProps: { arrow: true } },
      MuiDialog: { styleOverrides: { paper: { borderRadius: 12 } } },
      MuiDrawer: { styleOverrides: { paper: { backgroundColor: t.surface } } },
      MuiSnackbarContent: { styleOverrides: { root: { backgroundColor: t.ink, color: t.bg } } },
      MuiAlert: {
        styleOverrides: {
          root: ({ ownerState }) => {
            if (ownerState.variant && ownerState.variant !== "standard") return {};
            const severity = ownerState.color ?? ownerState.severity;
            if (severity === "warning") {
              return {
                backgroundColor: t.signalTint,
                color: t.ink,
                "& .MuiAlert-icon": { color: t.signal },
              };
            }
            if (severity === "error") {
              return {
                backgroundColor: t.stopTint,
                color: t.ink,
                "& .MuiAlert-icon": { color: t.stop },
              };
            }
            return {};
          },
        },
      },
    },
  });
}
