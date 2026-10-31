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
import { DEMO_REASON, useIsDemo } from "../lib/demo";
import { t } from "../i18n";

export const INTERVIEW_KIND: Record<InterviewKind, string> = {
  get recruiter_screen() {
    return t("Recruiter screen");
  },
  get hiring_manager() {
    return t("Hiring manager interview");
  },
  get technical() {
    return t("Technical interview");
  },
  get system_design() {
    return t("System design");
  },
  get behavioral() {
    return t("Behavioral interview");
  },
  get take_home_review() {
    return t("Take-home review");
  },
  get onsite_loop() {
    return t("Onsite loop");
  },
  get other() {
    return t("Interview");
  },
};

const DAY_MS = 86_400_000;

function list(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return t("{names} and {last}", {
    names: names.slice(0, -1).join(", "),
    last: names[names.length - 1] as string,
  });
}

function dayChip(startsAt: string, tz: string, now: Date): string | null {
  const day = localDayKey(startsAt, tz);
  if (day === localDayKey(now, tz)) return t("Today");
  if (day === localDayKey(new Date(now.getTime() + DAY_MS), tz)) return t("Tomorrow");
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
  const demo = useIsDemo();
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
    : t("No time yet");
  const chip =
    interview.status === "cancelled"
      ? t("Cancelled")
      : interview.status === "completed"
        ? t("Done")
        : interview.startsAt
          ? dayChip(interview.startsAt, timezone, current)
          : null;
  const people =
    interview.interviewers.length > 0
      ? ` ${t("With {names}.", { names: list(interview.interviewers) })}`
      : "";

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
                tone={
                  interview.status === "cancelled" || interview.status === "completed"
                    ? "neutral"
                    : "route"
                }
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
            {t("Join video call")}
          </Link>
        ) : null}
      </Box>
      <RowActions
        actions={[
          ...(!scheduled && isHttpUrl(interview.schedulingUrl)
            ? [
                {
                  key: "pick",
                  label: t("Pick a time"),
                  kind: "outlined" as const,
                  href: interview.schedulingUrl,
                },
              ]
            : []),
          ...(onPrepNotes
            ? [
                {
                  key: "prep",
                  label: t("Prep notes"),
                  kind: "outlined" as const,
                  onClick: () => onPrepNotes(interview),
                  ...(demo ? { disabledReason: t(DEMO_REASON.notes) } : {}),
                },
              ]
            : []),
          {
            key: "open",
            label: t("Open application"),
            kind: "text" as const,
            to: `/applications/${application.id}`,
          },
        ]}
      />
    </Box>
  );
}
