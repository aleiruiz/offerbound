import { useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";

/**
 * Text links under 600px are at least 44px tall (DESIGN_SPEC §9.4); the theme only handles
 * buttons. `extra` adds to the link's own style. Call it at the top of a component.
 */
export function useLinkSx(extra: Record<string, unknown> = {}) {
  const theme = useTheme();
  const phone = useMediaQuery(theme.breakpoints.down("sm"), { noSsr: true });
  return {
    fontSize: 14,
    fontWeight: 600,
    textDecoration: "none",
    ...(phone ? { display: "inline-flex", alignItems: "center", minHeight: 44 } : {}),
    ...extra,
  };
}

/** True below 600px, where every target is at least 44px (DESIGN_SPEC §9.4). */
export function usePhone(): boolean {
  const theme = useTheme();
  return useMediaQuery(theme.breakpoints.down("sm"), { noSsr: true });
}
