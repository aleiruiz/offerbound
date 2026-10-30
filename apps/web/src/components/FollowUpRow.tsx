import type { ApplicationSummary } from "@offerbound/contracts";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { RowActions } from "./RowActions";
import { DEFAULT_TIMEZONE, formatShortDate } from "../lib/format";
import { t, tn } from "../i18n";

const DAY_MS = 86_400_000;

function days(from: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(from).getTime()) / DAY_MS));
}

function plural(n: number): string {
  return tn(n, "1 day", "{count} days");
}

/** "Applied Oct 20, no reply for 9 days." in plain words (DESIGN_SPEC §6.5). */
export function followUpReason(app: ApplicationSummary, tz: string, now: Date): string {
  if (app.lastCompanyActivityAt) {
    return t("Last reply from the company {date}, {days} ago.", {
      date: formatShortDate(app.lastCompanyActivityAt, tz),
      days: plural(days(app.lastCompanyActivityAt, now)),
    });
  }
  if (app.appliedAt) {
    return t("Applied {date}, no reply for {days}.", {
      date: formatShortDate(app.appliedAt, tz),
      days: plural(days(app.appliedAt, now)),
    });
  }
  return t("No reply from the company yet.");
}

export interface FollowUpRowProps {
  application: ApplicationSummary;
  onMarkFollowedUp: (application: ApplicationSummary) => void;
  timezone?: string;
  now?: Date;
}

/** A follow-up due: company, role and the reason, with *Mark followed up* and *Open*. */
export function FollowUpRow({
  application,
  onMarkFollowedUp,
  timezone = DEFAULT_TIMEZONE,
  now,
}: FollowUpRowProps) {
  return (
    <Box
      component="li"
      sx={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "12px 16px",
        px: 2.5,
        py: 1.75,
        listStyle: "none",
        borderTop: 1,
        borderColor: "divider",
      }}
    >
      <Box sx={{ flex: "1 1 260px", minWidth: 0 }}>
        <Typography sx={{ fontWeight: 600 }}>{application.company.name}</Typography>
        <Typography variant="caption" color="text.secondary" component="p">
          {`${application.title}. ${followUpReason(application, timezone, now ?? new Date())}`}
        </Typography>
      </Box>
      <RowActions
        actions={[
          {
            key: "followed",
            label: t("Mark followed up"),
            kind: "outlined",
            onClick: () => onMarkFollowedUp(application),
          },
          { key: "open", label: t("Open"), kind: "text", to: `/applications/${application.id}` },
        ]}
      />
    </Box>
  );
}
