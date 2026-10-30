import Box from "@mui/material/Box";
import LinearProgress from "@mui/material/LinearProgress";
import Typography from "@mui/material/Typography";
import type { ReactNode } from "react";

export interface TargetMeterProps {
  label: string;
  value: number;
  /** The target; with `max` it is the low end of a range such as 8–12. */
  min: number;
  max?: number;
  /** "min" in "of 90 min". */
  unit?: string;
  /** Shown under the bar; defaults to "Target met" once `value` reaches `min`. */
  caption?: ReactNode;
  /** Quick-log buttons or a link. */
  actions?: ReactNode;
}

/** A daily target (DESIGN_SPEC §6.5): label, count in display type, the range, a 6px bar. */
export function TargetMeter({ label, value, min, max, unit, caption, actions }: TargetMeterProps) {
  const range = max !== undefined && max > min ? `${min}–${max}` : `${min}`;
  const percent = min > 0 ? Math.min(100, (value / min) * 100) : 100;
  const footer = caption ?? (value >= min ? "Target met" : null);
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
      <Typography variant="subtitle2" component="span">
        {label}
      </Typography>
      <Box component="span">
        <Typography variant="h3" component="span">
          {value}
        </Typography>{" "}
        <Typography variant="caption" color="text.secondary" component="span">
          {`of ${range}${unit ? ` ${unit}` : ""}`}
        </Typography>
      </Box>
      <LinearProgress
        variant="determinate"
        value={percent}
        aria-label={label}
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={min}
        sx={{ height: 6, borderRadius: "3px", bgcolor: "divider" }}
      />
      {footer ? (
        <Typography
          variant="caption"
          color="text.secondary"
          component="span"
          sx={{ fontWeight: 600 }}
        >
          {footer}
        </Typography>
      ) : null}
      {actions ? <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.75 }}>{actions}</Box> : null}
    </Box>
  );
}
