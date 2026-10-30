import type { InterviewKind, InterviewWithApplication } from "@offerbound/contracts";
import VideocamOutlined from "@mui/icons-material/VideocamOutlined";
import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import { DEFAULT_TIMEZONE, formatTime, localDayKey } from "../lib/format";
import { useLinkSx } from "../lib/link-sx";
import { isHttpUrl } from "../lib/url";
import { RowActions } from "./RowActions";
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
  /** Marks the row the keyboard is on (`aria-current`). */
  focused?: boolean;
  /** Props from `useListKeyboard().getRowProps(i)`. */
  rowProps?: object;
}

/** One interview (DESIGN_SPEC §6.5): the time column, kind, company and role, people, call link, actions. */
export function InterviewRow({
  interview,
  timezone = DEFAULT_TIMEZONE,
  now,
  onPrepNotes,
  focused,
  rowProps,
}: InterviewRowProps) {
  const linkSx = useLinkSx({
    display: "inline-flex",
    alignItems: "center",
    gap: 0.75,
    alignSelf: "flex-start",
  });
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
      {...rowProps}
      {...(focused ? { "aria-current": "true" } : {})}
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
        "&[aria-current='true']": {
          bgcolor: (theme) => theme.palette.tokens.surfaceSunken,
          outline: (theme) => `2px solid ${theme.palette.primary.main}`,
          outlineOffset: -2,
        },
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
        {interview.location ? (
          <Typography variant="caption" color="text.secondary" component="p">
            {interview.location}
          </Typography>
        ) : null}
        {isHttpUrl(interview.meetingUrl) ? (
          <Link
            href={interview.meetingUrl}
            target="_blank"
            rel="noopener noreferrer"
            underline="none"
            sx={linkSx}
          >
            <VideocamOutlined fontSize="small" />
            Join video call
          </Link>
        ) : null}
      </Box>
      <RowActions
        actions={[
          ...(!scheduled && isHttpUrl(interview.schedulingUrl)
            ? [
                {
                  key: "pick",
                  label: "Pick a time",
                  kind: "outlined" as const,
                  href: interview.schedulingUrl,
                },
              ]
            : []),
          ...(onPrepNotes
            ? [
                {
                  key: "prep",
                  label: "Prep notes",
                  kind: "outlined" as const,
                  onClick: () => onPrepNotes(interview),
                },
              ]
            : []),
          {
            key: "open",
            label: "Open application",
            kind: "text" as const,
            to: `/applications/${application.id}`,
          },
        ]}
      />
    </Box>
  );
}
