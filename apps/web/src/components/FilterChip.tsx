import Chip from "@mui/material/Chip";
import type { ReactElement } from "react";
import { usePhone } from "../lib/link-sx";

/**
 * A filter chip (DESIGN_SPEC §9.2): a toggle button with `aria-pressed`. Below 600px it is at least
 * 44px tall (§9.4).
 */
export function FilterChip({
  label,
  pressed,
  onToggle,
  icon,
}: {
  label: string;
  pressed: boolean;
  onToggle: () => void;
  /** A marker before the label, such as a status dot. */
  icon?: ReactElement;
}) {
  const phone = usePhone();
  return (
    <Chip
      onClick={onToggle}
      aria-pressed={pressed}
      variant="outlined"
      icon={icon}
      label={label}
      sx={(theme) => ({
        height: phone ? "auto" : 32,
        minHeight: phone ? 44 : undefined,
        borderRadius: phone ? "22px" : "16px",
        fontWeight: 600,
        fontSize: 14,
        px: icon ? 0 : 0.5,
        borderColor: pressed ? theme.palette.primary.main : theme.palette.text.secondary,
        color: pressed ? theme.palette.primary.main : theme.palette.text.primary,
        bgcolor: pressed ? theme.palette.tokens.routeTint : theme.palette.background.paper,
        "&:hover": {
          bgcolor: pressed ? theme.palette.tokens.routeTint : theme.palette.action.hover,
        },
      })}
    />
  );
}
