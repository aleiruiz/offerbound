import type { InterviewKind, InterviewWithApplication } from "@offerbound/contracts";
import VideocamOutlined from "@mui/icons-material/VideocamOutlined";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import { Link as RouterLink } from "react-router";
import { DEFAULT_TIMEZONE, formatTime, localDayKey } from "../lib/format";
import { isHttpUrl } from "../lib/url";
import { FlagChip } from "./StatusChip";

export const INTERVIEW_KIND: Record<InterviewKind, string> = {
  recruiter_screen: "Recruiter screen",
  hiring_manager: "Hiring manager interview",
  technical: "Technical interview",
  system_design: "System design",
  behavioral: "Behavioral interview",
  take_home_review: "Take-home review",
  onsite_loop: "Onsite loop",
  other: "Interview",
};

const DAY_MS = 86_400_000;

function list(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function dayChip(startsAt: string, tz: string, now: Date): string | null {
  const day = localDayKey(startsAt, tz);
  if (day === localDayKey(now, tz)) return "Today";
  if (day === localDayKey(new Date(now.getTime() + DAY_MS), tz)) return "Tomorrow";
  return null;
}

export interface InterviewRowProps {
  interview: InterviewWithApplication;
  timezone?: string;
  now?: Date;
  /** Shown as a *Prep notes* button when given. */
  onPrepNotes?: (interview: InterviewWithApplication) => void;
}

/** One interview (DESIGN_SPEC §6.5): the time column, kind, company and role, people, call link, actions. */
export function InterviewRow({
  interview,
  timezone = DEFAULT_TIMEZONE,
  now,
  onPrepNotes,
}: InterviewRowProps) {
  const current = now ?? new Date();
  const { application } = interview;
  const scheduled = interview.startsAt !== null;
  const time = interview.startsAt
    ? interview.endsAt
      ? `${formatTime(interview.startsAt, timezone)}–${formatTime(interview.endsAt, timezone)}`
      : formatTime(interview.startsAt, timezone)
    : "No time yet";
  const chip =
    interview.status === "cancelled"
      ? "Cancelled"
      : interview.status === "completed"
        ? "Done"
        : interview.startsAt
          ? dayChip(interview.startsAt, timezone, current)
          : null;
  const people = interview.interviewers.length > 0 ? ` With ${list(interview.interviewers)}.` : "";

  return (
    <Box
      component="li"
      sx={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "flex-start",
        gap: "12px 24px",
        px: 2.5,
        py: 2,
        listStyle: "none",
        borderTop: 1,
        borderColor: "divider",
      }}
    >
      <Typography
        variant="h6"
        component="span"
        sx={{ flex: "0 0 132px", color: scheduled ? "text.primary" : "warning.main" }}
      >
        {time}
      </Typography>
      <Box
        sx={{ flex: "1 1 320px", minWidth: 0, display: "flex", flexDirection: "column", gap: 0.75 }}
      >
        <Typography component="div">
          <Box component="span" sx={{ fontWeight: 600 }}>
            {INTERVIEW_KIND[interview.kind]}
          </Box>
          {chip ? (
            <Box component="span" sx={{ ml: 0.5 }}>
              <FlagChip
                tone={chip === "Cancelled" || chip === "Done" ? "neutral" : "route"}
                label={chip}
              />
            </Box>
          ) : null}
        </Typography>
        <Typography variant="caption" color="text.secondary" component="p">
          {`${application.company.name}, ${application.title}.${people}`}
        </Typography>
        {isHttpUrl(interview.meetingUrl) ? (
          <Link
            href={interview.meetingUrl}
            target="_blank"
            rel="noopener noreferrer"
            underline="none"
            variant="subtitle2"
            sx={{
              display: "inline-flex",
              alignItems: "center",
              gap: 0.75,
              alignSelf: "flex-start",
            }}
          >
            <VideocamOutlined fontSize="small" />
            Join video call
          </Link>
        ) : null}
      </Box>
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
        {!scheduled && isHttpUrl(interview.schedulingUrl) ? (
          <Button
            size="small"
            variant="outlined"
            component="a"
            href={interview.schedulingUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Pick a time
          </Button>
        ) : null}
        {onPrepNotes ? (
          <Button size="small" variant="outlined" onClick={() => onPrepNotes(interview)}>
            Prep notes
          </Button>
        ) : null}
        <Button size="small" component={RouterLink} to={`/applications/${application.id}`}>
          Open application
        </Button>
      </Box>
    </Box>
  );
}
