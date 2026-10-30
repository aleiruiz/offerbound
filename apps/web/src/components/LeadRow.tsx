import type { Lead, LeadSource, SuppressedReason, Verification } from "@offerbound/contracts";
import CloseOutlined from "@mui/icons-material/CloseOutlined";
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

const WORK_MODE: Record<Lead["workMode"], string | null> = {
  remote: "Remote",
  hybrid: "Hybrid",
  onsite: "On-site",
  unknown: null,
};

const VERIFICATION: Record<Verification, { label: string; tone: "route" | "neutral" }> = {
  verified: { label: "Verified posting", tone: "route" },
  unverified: { label: "Unverified posting", tone: "neutral" },
  unverifiable: { label: "LinkedIn only, not checked", tone: "neutral" },
  pending: { label: "Checking posting", tone: "neutral" },
};

const SUPPRESSED: Record<SuppressedReason, string> = {
  company_already_seen: "Company already seen",
  same_company_in_batch: "Another lead at this company ranked higher",
  excluded_seniority: "Seniority you excluded",
  ineligible: "Not eligible",
};

const SOURCE: Record<LeadSource, string> = {
  search_agent: "Found by the search",
  gmail_alert: "Found in a job alert email",
  gmail_recruiter: "From a recruiter email",
  sheet_import: "From your spreadsheet",
  paste_report: "From a pasted report",
  manual: "Added by you",
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
  onReconsider?: (lead: Lead) => void;
  /** Shown for leads that came from an email. */
  onViewEmail?: (lead: Lead) => void;
}

function sourceCaption(lead: Lead, tz: string, now: Date): string {
  const label = SOURCE[lead.source];
  const when =
    localDayKey(lead.foundAt, tz) === localDayKey(now, tz)
      ? `at ${formatTime(lead.foundAt, tz)}`
      : `on ${formatShortDate(lead.foundAt, tz)}`;
  return `${label} ${when}.`;
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
  onReconsider,
  onViewEmail,
}: LeadRowProps) {
  const compensation = formatCompensation(lead.compensation);
  const compensationLabel = compensation ?? lead.compensationText;
  const workMode = WORK_MODE[lead.workMode];
  const verification = VERIFICATION[lead.verification];
  const open = lead.status === "new" || lead.status === "shortlisted";
  const caption = [
    lead.gaps.length > 0 ? `Gaps: ${lead.gaps.join(", ")}.` : null,
    sourceCaption(lead, timezone, now ?? new Date()),
  ]
    .filter(Boolean)
    .join(" ");

  const actions: RowAction[] = [];
  if (lead.status === "new" && onShortlist) {
    actions.push({
      key: "shortlist",
      label: "Shortlist",
      kind: "outlined",
      onClick: () => onShortlist(lead),
    });
  }
  if (open && onMarkApplied) {
    actions.push({
      key: "applied",
      label: "Mark applied",
      kind: "text",
      onClick: () => onMarkApplied(lead),
    });
  }
  if (!open && lead.status !== "applied" && onReconsider) {
    actions.push({
      key: "reconsider",
      label: "Reconsider",
      kind: "outlined",
      onClick: () => onReconsider(lead),
    });
  }
  if (lead.status === "applied" && lead.applicationId) {
    actions.push({
      key: "application",
      label: "Open application",
      kind: "text",
      to: `/applications/${lead.applicationId}`,
    });
  }
  if (open && onDismiss) {
    actions.push({
      key: "dismiss",
      label: "Dismiss lead",
      kind: "icon",
      icon: <CloseOutlined fontSize="small" />,
      onClick: () => onDismiss(lead),
    });
  }
  if (onViewEmail && (lead.source === "gmail_recruiter" || lead.source === "gmail_alert")) {
    actions.push({
      key: "email",
      label: "View source email",
      kind: "icon",
      icon: <MailOutlineOutlined fontSize="small" />,
      onClick: () => onViewEmail(lead),
    });
  }
  if (isHttpUrl(lead.jobUrl)) {
    actions.push({
      key: "posting",
      label: "Open job posting",
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
          fit
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
          {lead.track ? (
            <FlagChip tone="neutral" label={trackLabels?.[lead.track] ?? lead.track} />
          ) : null}
          {workMode ? <FlagChip tone="neutral" label={workMode} /> : null}
          <FlagChip tone={verification.tone} label={verification.label} />
          {compensationLabel ? <FlagChip tone="neutral" label={compensationLabel} /> : null}
          {compensation && lead.compensation.isEstimate ? (
            <FlagChip tone="signal" label="Estimate" />
          ) : null}
          {lead.companySeenBefore ? <FlagChip tone="signal" label="Company seen before" /> : null}
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
