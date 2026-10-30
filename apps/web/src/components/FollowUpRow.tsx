import type { ApplicationSummary } from "@offerbound/contracts";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import { Link as RouterLink } from "react-router";
import { DEFAULT_TIMEZONE, formatShortDate } from "../lib/format";

const DAY_MS = 86_400_000;

function days(from: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(from).getTime()) / DAY_MS));
}

function plural(n: number): string {
  return n === 1 ? "1 day" : `${n} days`;
}

/** "Applied Oct 20, no reply for 9 days." in plain words (DESIGN_SPEC §6.5). */
export function followUpReason(app: ApplicationSummary, tz: string, now: Date): string {
  if (app.lastCompanyActivityAt) {
    return `Last reply from the company ${formatShortDate(app.lastCompanyActivityAt, tz)}, ${plural(days(app.lastCompanyActivityAt, now))} ago.`;
  }
  if (app.appliedAt) {
    return `Applied ${formatShortDate(app.appliedAt, tz)}, no reply for ${plural(days(app.appliedAt, now))}.`;
  }
  return "No reply from the company yet.";
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
      <Box sx={{ display: "flex", gap: 0.5 }}>
        <Button size="small" variant="outlined" onClick={() => onMarkFollowedUp(application)}>
          Mark followed up
        </Button>
        <Button size="small" component={RouterLink} to={`/applications/${application.id}`}>
          Open
        </Button>
      </Box>
    </Box>
  );
}
