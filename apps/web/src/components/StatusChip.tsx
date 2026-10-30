import type { ApplicationStatus } from "@offerbound/contracts";
import Chip, { type ChipProps } from "@mui/material/Chip";

export const STATUS_LABEL: Record<ApplicationStatus, string> = {
  applied: "Applied",
  screening: "Screening",
  assessment: "Assessment",
  interviewing: "Interviewing",
  offer: "Offer",
  accepted: "Accepted",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
  abandoned: "Abandoned",
};

/** DESIGN_SPEC §6.1: the soft status pair, always with the word. Abandoned is dashed (DS-5). */
export function StatusChip({
  status,
  label,
  ...rest
}: { status: ApplicationStatus; label?: string } & Omit<ChipProps, "label" | "color" | "sx">) {
  return (
    <Chip
      {...rest}
      label={label ?? STATUS_LABEL[status]}
      data-status={status}
      sx={(theme) => ({
        bgcolor: theme.palette.status[status].tint,
        color: theme.palette.status[status].main,
        ...(status === "abandoned"
          ? { border: `1px dashed ${theme.palette.status.abandoned.main}` }
          : {}),
      })}
    />
  );
}

export type FlagTone = "signal" | "route" | "neutral";

/**
 * The same chip shape for flags (DESIGN_SPEC §6.1): `signal` for things that need the owner
 * (Follow-up due, To schedule, Estimate, Company seen before), `route` for Verified posting,
 * `neutral` for everything else.
 */
export function FlagChip({
  tone,
  label,
  ...rest
}: { tone: FlagTone; label: string } & Omit<ChipProps, "label" | "color">) {
  return (
    <Chip
      {...rest}
      label={label}
      data-tone={tone}
      sx={(theme) => {
        const pair =
          tone === "signal"
            ? { bg: theme.palette.tokens.signalTint, fg: theme.palette.warning.main }
            : tone === "route"
              ? { bg: theme.palette.tokens.routeTint, fg: theme.palette.primary.main }
              : {
                  bg: theme.palette.status.withdrawn.tint,
                  fg: theme.palette.status.withdrawn.main,
                };
        return { bgcolor: pair.bg, color: pair.fg };
      }}
    />
  );
}
