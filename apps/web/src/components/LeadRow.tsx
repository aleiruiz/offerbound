import type { Lead, LeadSource, SuppressedReason, Verification } from "@offerbound/contracts";
import CloseOutlined from "@mui/icons-material/CloseOutlined";
import EventBusyOutlined from "@mui/icons-material/EventBusyOutlined";
import MailOutlineOutlined from "@mui/icons-material/MailOutlineOutlined";
import OpenInNewOutlined from "@mui/icons-material/OpenInNewOutlined";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import {
  DEFAULT_TIMEZONE,
  formatCompensation,
  formatShortDate,
  formatTime,
  localDayKey,
} from "../lib/format";
import { isHttpUrl } from "../lib/url";
import { RowActions, type RowAction } from "./RowActions";
import { FlagChip } from "./StatusChip";
import { t } from "../i18n";

const WORK_MODE: Record<Lead["workMode"], string | null> = {
  get remote() {
    return t("Remote");
  },
  get hybrid() {
    return t("Hybrid");
  },
  get onsite() {
    return t("On-site");
  },
  unknown: null,
};

const VERIFICATION: Record<Verification, { label: string; tone: "route" | "neutral" }> = {
  verified: {
    get label() {
      return t("Verified posting");
    },
    tone: "route",
  },
  unverified: {
    get label() {
      return t("Unverified posting");
    },
    tone: "neutral",
  },
  unverifiable: {
    get label() {
      return t("LinkedIn only, not checked");
    },
    tone: "neutral",
  },
  pending: {
    get label() {
      return t("Checking posting");
    },
    tone: "neutral",
  },
};

const SUPPRESSED: Record<SuppressedReason, string> = {
  get company_already_seen() {
    return t("Company already seen");
  },
  get same_company_in_batch() {
    return t("Another lead at this company ranked higher");
  },
  get excluded_seniority() {
    return t("Seniority you excluded");
  },
  get ineligible() {
    return t("Not eligible");
  },
};

/** The dismissed reason of *No longer available*, and of a posting the link check found closed. */
export const POSTING_CLOSED = "posting_closed";

/** The reasons the system (or *No longer available*) gives a dismissed lead; others are not shown. */
const DISMISSED: Record<string, string> = {
  get posting_closed() {
    return t("Posting closed");
  },
  get expired() {
    return t("Posting expired");
  },
};

const SOURCE: Record<LeadSource, string> = {
  get search_agent() {
    return t("Found by the search");
  },
  get gmail_alert() {
    return t("Found in a job alert email");
  },
  get gmail_recruiter() {
    return t("From a recruiter email");
  },
  get sheet_import() {
    return t("From your spreadsheet");
  },
  get paste_report() {
    return t("From a pasted report");
  },
  get manual() {
    return t("Added by you");
  },
};

export interface LeadRowProps {
  lead: Lead;
  timezone?: string;
  /** The current time, for "at 07:04" versus "on Oct 27". Defaults to now. */
  now?: Date;
  /** Track key to label, from the settings. A key with no label is shown as it is. */
  trackLabels?: Record<string, string>;
  /** Marks the row the keyboard is on (`aria-current`). */
  focused?: boolean;
  /** Props from `useListKeyboard().getRowProps(i)`. */
  rowProps?: object;
  onShortlist?: (lead: Lead) => void;
  onMarkApplied?: (lead: Lead) => void;
  onDismiss?: (lead: Lead) => void;
  /** Dismisses the lead because its posting is closed. */
  onMarkClosed?: (lead: Lead) => void;
  onReconsider?: (lead: Lead) => void;
  /** Found since the owner's previous visit: a New chip first and the signal tint on the row. */
  isNew?: boolean;
  /** Shown for leads that came from an email. */
  onViewEmail?: (lead: Lead) => void;
}

function sourceCaption(lead: Lead, tz: string, now: Date): string {
  const label = SOURCE[lead.source];
  const when =
    localDayKey(lead.foundAt, tz) === localDayKey(now, tz)
      ? t("{source} at {time}.", { source: label, time: formatTime(lead.foundAt, tz) })
      : t("{source} on {date}.", { source: label, date: formatShortDate(lead.foundAt, tz) });
  return when;
}

/** One lead (DESIGN_SPEC §6.4). Render rows inside one outlined Paper `<ul>`; dividers separate them. */
export function LeadRow({
  lead,
  timezone = DEFAULT_TIMEZONE,
  now,
  trackLabels,
  focused,
  rowProps,
  onShortlist,
  onMarkApplied,
  onDismiss,
  onMarkClosed,
  onReconsider,
  isNew,
  onViewEmail,
}: LeadRowProps) {
  const compensation = formatCompensation(lead.compensation);
  const compensationLabel = compensation ?? lead.compensationText;
  const workMode = WORK_MODE[lead.workMode];
  const verification = VERIFICATION[lead.verification];
  const open = lead.status === "new" || lead.status === "shortlisted";
  const caption = [
    lead.gaps.length > 0 ? t("Gaps: {gaps}.", { gaps: lead.gaps.join(", ") }) : null,
    sourceCaption(lead, timezone, now ?? new Date()),
  ]
    .filter(Boolean)
    .join(" ");

  const actions: RowAction[] = [];
  if (lead.status === "new" && onShortlist) {
    actions.push({
      key: "shortlist",
      label: t("Shortlist"),
      kind: "outlined",
      onClick: () => onShortlist(lead),
    });
  }
  if (open && onMarkApplied) {
    actions.push({
      key: "applied",
      label: t("Mark applied"),
      kind: "text",
      onClick: () => onMarkApplied(lead),
    });
  }
  if (!open && lead.status !== "applied" && onReconsider) {
    actions.push({
      key: "reconsider",
      label: t("Reconsider"),
      kind: "outlined",
      onClick: () => onReconsider(lead),
    });
  }
  if (lead.status === "applied" && lead.applicationId) {
    actions.push({
      key: "application",
      label: t("Open application"),
      kind: "text",
      to: `/applications/${lead.applicationId}`,
    });
  }
  if (open && onMarkClosed) {
    actions.push({
      key: "closed",
      label: t("No longer available"),
      kind: "icon",
      icon: <EventBusyOutlined fontSize="small" />,
      onClick: () => onMarkClosed(lead),
    });
  }
  if (open && onDismiss) {
    actions.push({
      key: "dismiss",
      label: t("Dismiss lead"),
      kind: "icon",
      icon: <CloseOutlined fontSize="small" />,
      onClick: () => onDismiss(lead),
    });
  }
  if (onViewEmail && (lead.source === "gmail_recruiter" || lead.source === "gmail_alert")) {
    actions.push({
      key: "email",
      label: t("View source email"),
      kind: "icon",
      icon: <MailOutlineOutlined fontSize="small" />,
      onClick: () => onViewEmail(lead),
    });
  }
  if (isHttpUrl(lead.jobUrl)) {
    actions.push({
      key: "posting",
      label: t("Open job posting"),
      kind: "icon",
      icon: <OpenInNewOutlined fontSize="small" />,
      href: lead.jobUrl,
    });
  }

  return (
    <Box
      component="li"
      {...rowProps}
      {...(focused ? { "aria-current": "true" } : {})}
      sx={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "flex-start",
        gap: "12px 16px",
        px: 2.5,
        py: 1.75,
        listStyle: "none",
        "&:not(:first-of-type)": { borderTop: 1, borderColor: "divider" },
        ...(isNew ? { bgcolor: (theme) => theme.palette.tokens.signalTint } : {}),
        "&[aria-current='true']": {
          bgcolor: (theme) => theme.palette.tokens.surfaceSunken,
          outline: (theme) => `2px solid ${theme.palette.primary.main}`,
          outlineOffset: -2,
        },
      }}
    >
      <Box sx={{ width: 48, textAlign: "center", flex: "0 0 auto" }}>
        <Typography sx={{ fontSize: 24, lineHeight: "28px", fontWeight: 800 }}>
          {lead.fitScore ?? "–"}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {t("fit")}
        </Typography>
      </Box>

      <Box
        sx={{ flex: "1 1 320px", minWidth: 0, display: "flex", flexDirection: "column", gap: 0.75 }}
      >
        <Typography component="p">
          <Box component="span" sx={{ fontWeight: 600 }}>
            {lead.company.name}
          </Box>{" "}
          <Box component="span" sx={{ color: "text.secondary" }}>
            {lead.title}
          </Box>
        </Typography>
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.75 }}>
          {isNew ? <FlagChip tone="signal" variant="outlined" label={t("New")} /> : null}
          {lead.track ? (
            <FlagChip tone="neutral" label={trackLabels?.[lead.track] ?? lead.track} />
          ) : null}
          {workMode ? <FlagChip tone="neutral" label={workMode} /> : null}
          <FlagChip tone={verification.tone} label={verification.label} />
          {compensationLabel ? <FlagChip tone="neutral" label={compensationLabel} /> : null}
          {compensation && lead.compensation.isEstimate ? (
            <FlagChip tone="signal" label={t("Estimate")} />
          ) : null}
          {lead.companySeenBefore ? (
            <FlagChip tone="signal" label={t("Company seen before")} />
          ) : null}
          {lead.status === "dismissed" &&
          lead.dismissedReason &&
          Object.hasOwn(DISMISSED, lead.dismissedReason) ? (
            <FlagChip tone="neutral" label={DISMISSED[lead.dismissedReason]!} />
          ) : null}
          {lead.suppressedReason ? (
            <FlagChip tone="neutral" label={SUPPRESSED[lead.suppressedReason]} />
          ) : null}
        </Box>
        {lead.fitReason ? <Typography>{lead.fitReason}</Typography> : null}
        <Typography variant="caption" color="text.secondary">
          {caption}
        </Typography>
      </Box>

      <RowActions actions={actions} />
    </Box>
  );
}
