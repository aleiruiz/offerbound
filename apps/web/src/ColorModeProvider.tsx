import CssBaseline from "@mui/material/CssBaseline";
import { ThemeProvider } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { createOfferboundTheme, type ThemeMode } from "./theme";

export type ThemePreference = "system" | "light" | "dark";

export const THEME_STORAGE_KEY = "ob.theme";

/** The stored preference: `light` or `dark` when `ob.theme` says so, otherwise `system`. */
export function readStoredPreference(): ThemePreference {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function writeStoredPreference(preference: ThemePreference): void {
  try {
    if (preference === "system") window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // storage is blocked: the choice lasts until the page is closed
  }
}

interface ColorModeValue {
  preference: ThemePreference;
  mode: ThemeMode;
  setPreference: (preference: ThemePreference) => void;
}

const ColorModeContext = createContext<ColorModeValue | null>(null);

/** Settings reads and changes the theme choice through this hook (T8.9). */
export function useColorMode(): ColorModeValue {
  const value = useContext(ColorModeContext);
  if (!value) throw new Error("useColorMode must be used inside ColorModeProvider");
  return value;
}

export function ColorModeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStoredPreference);
  const systemDark = useMediaQuery("(prefers-color-scheme: dark)", { noSsr: true });
  // DESIGN_SPEC §4: below 600px controls are size medium with 44px targets.
  const touch = useMediaQuery("(max-width: 599.95px)", { noSsr: true });
  const mode: ThemeMode = preference === "system" ? (systemDark ? "dark" : "light") : preference;

  const setPreference = useCallback((next: ThemePreference) => {
    writeStoredPreference(next);
    setPreferenceState(next);
  }, []);

  const theme = useMemo(() => createOfferboundTheme(mode, { touch }), [mode, touch]);
  const value = useMemo(
    () => ({ preference, mode, setPreference }),
    [preference, mode, setPreference],
  );

  return (
    <ColorModeContext.Provider value={value}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </ThemeProvider>
    </ColorModeContext.Provider>
  );
}
