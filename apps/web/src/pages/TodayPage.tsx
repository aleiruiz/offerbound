import SearchOutlined from "@mui/icons-material/SearchOutlined";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Link from "@mui/material/Link";
import Paper from "@mui/material/Paper";
import Skeleton from "@mui/material/Skeleton";
import Typography from "@mui/material/Typography";
import type {
  ApplicationSummary,
  InterviewWithApplication,
  Lead,
  ReviewItem,
  Settings,
  Today,
} from "@offerbound/contracts";
import { useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useMemo, type ReactNode } from "react";
import { Link as RouterLink } from "react-router";
import { ApiClientError } from "../api/client";
import {
  useLogDailyActivity,
  useMarkFollowedUp,
  useNavCounts,
  useRunSearch,
  useSetLeadStatus,
  useSettings,
  useSyncStatus,
  useTimezone,
  useToday,
} from "../api/hooks";
import { FirstSyncCard } from "../components/FirstSyncCard";
import { FollowUpRow } from "../components/FollowUpRow";
import { INTERVIEW_KIND } from "../components/InterviewRow";
import { LeadRow } from "../components/LeadRow";
import { PipelineRoute } from "../components/PipelineRoute";
import { ErrorState } from "../components/States";
import { FlagChip } from "../components/StatusChip";
import { TargetMeter } from "../components/TargetMeter";
import { useUndoSnackbar } from "../components/UndoSnackbar";
import { formatDate, formatLongDay, formatShortDate, formatTime, zoneCity } from "../lib/format";
import { usePipelineMovement } from "../lib/pipeline-movement";
import { isHttpUrl } from "../lib/url";

/**
 * Today (DESIGN_SPEC §5.1; AC-13.1 to 13.4): the pipeline, today's targets, follow-ups due, what
 * needs review, the top new leads and the next 7 days. `GET /today` answers for all of it, so when
 * it fails every section says so with its own *Try again*; the header stays.
 */

const SEARCH_RUNNING = "A search is already running";
/** TECHNICAL_SPEC §11: a 409 version_conflict says the record changed elsewhere. */
const CHANGED_ELSEWHERE = "Changes were made elsewhere. Today has been refreshed.";

function isVersionConflict(error: unknown): boolean {
  return error instanceof ApiClientError && error.code === "version_conflict";
}

// ---------------------------------------------------------------------------------------------
// Section frame, skeletons and the three states

type TodayQuery = ReturnType<typeof useToday>;

function Section({
  title,
  children,
  count,
  action,
  note,
  noteAfter,
}: {
  title: string;
  children: ReactNode;
  /** A signal chip beside the title. */
  count?: number;
  /** A link or caption at the end of the header. */
  action?: ReactNode;
  /** A caption under the header's title. */
  note?: ReactNode;
  /** A caption at the foot of the section. */
  noteAfter?: ReactNode;
}) {
  const id = `today-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <Paper component="section" variant="outlined" aria-labelledby={id}>
      <Box
        sx={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 1,
          px: 2.5,
          py: 2,
        }}
      >
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25 }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <Typography id={id} variant="h5" component="h2" sx={{ fontWeight: 700 }}>
              {title}
            </Typography>
            {count !== undefined && count > 0 ? (
              <FlagChip tone="signal" label={String(count)} aria-label={`${count} items`} />
            ) : null}
          </Box>
          {note ? (
            <Typography variant="caption" color="text.secondary" component="p">
              {note}
            </Typography>
          ) : null}
        </Box>
        {action}
      </Box>
      {children}
      {noteAfter ? (
        <Typography
          variant="caption"
          color="text.secondary"
          component="p"
          sx={{ px: 2.5, pt: 1.5, pb: 2, borderTop: 1, borderColor: "divider" }}
        >
          {noteAfter}
        </Typography>
      ) : null}
    </Paper>
  );
}

function SkeletonBody({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Box
      role="status"
      aria-busy="true"
      aria-label={`Loading ${title.toLowerCase()}`}
      sx={{ px: 2.5, pb: 2.5 }}
    >
      {children}
    </Box>
  );
}

function RowsSkeleton({ title, rows = 2 }: { title: string; rows?: number }) {
  return (
    <SkeletonBody title={title}>
      {Array.from({ length: rows }, (_, i) => (
        <Box
          key={i}
          sx={{
            display: "flex",
            flexDirection: "column",
            gap: 1,
            py: 1.5,
            borderTop: 1,
            borderColor: "divider",
          }}
        >
          <Skeleton variant="rounded" width={`${48 + ((i * 17) % 24)}%`} height={14} />
          <Skeleton variant="rounded" width={`${68 + ((i * 11) % 20)}%`} height={12} />
        </Box>
      ))}
    </SkeletonBody>
  );
}

function RouteSkeleton() {
  return (
    <SkeletonBody title="Pipeline">
      <Box sx={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 1 }}>
        {Array.from({ length: 5 }, (_, i) => (
          <Box
            key={i}
            sx={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}
          >
            <Skeleton variant="circular" width={24} height={24} />
            <Skeleton variant="rounded" width={32} height={28} />
            <Skeleton variant="rounded" width={64} height={14} />
          </Box>
        ))}
      </Box>
    </SkeletonBody>
  );
}

function MetersSkeleton() {
  return (
    <SkeletonBody title="Today's targets">
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(180px, 100%), 1fr))",
          gap: "20px 24px",
        }}
      >
        {Array.from({ length: 5 }, (_, i) => (
          <Box key={i} sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <Skeleton variant="rounded" width={90} height={14} />
            <Skeleton variant="rounded" width={70} height={32} />
            <Skeleton variant="rounded" height={6} />
          </Box>
        ))}
      </Box>
    </SkeletonBody>
  );
}

/** What a section shows: its skeleton, its error with *Try again*, or its content. */
function Body({
  query,
  what,
  skeleton,
  children,
}: {
  query: TodayQuery;
  /** Noun phrase for the error: "the pipeline". */
  what: string;
  skeleton: ReactNode;
  children: (today: Today) => ReactNode;
}) {
  if (query.data) return <>{children(query.data)}</>;
  if (query.isError) {
    return (
      <Box sx={{ px: 2.5, pb: 2.5 }}>
        <ErrorState what={what} error={query.error} onRetry={() => void query.refetch()} />
      </Box>
    );
  }
  return <>{skeleton}</>;
}

function EmptyLine({ children }: { children: ReactNode }) {
  return (
    <Typography
      variant="body2"
      color="text.secondary"
      sx={{ px: 2.5, pb: 2.5, pt: 0.5 }}
      component="p"
    >
      {children}
    </Typography>
  );
}

/**
 * Text links under 600px are at least 44px tall (DESIGN_SPEC §9.4); the theme only handles
 * buttons. `extra` adds to the link's own style.
 */
function useLinkSx(extra: Record<string, unknown> = {}) {
  const theme = useTheme();
  const phone = useMediaQuery(theme.breakpoints.down("sm"), { noSsr: true });
  return {
    fontSize: 14,
    fontWeight: 600,
    textDecoration: "none",
    ...(phone ? { display: "inline-flex", alignItems: "center", minHeight: 44 } : {}),
    ...extra,
  };
}

// ---------------------------------------------------------------------------------------------
// Pipeline

/** A rate is a fraction from 0 to 1 (answered ÷ applications); anything else is clamped. */
function percent(rate: number): string {
  return `${Math.round(Math.min(1, Math.max(0, rate)) * 100)}%`;
}

function PipelineBody({ today }: { today: Today }) {
  const { byStatus, responseRate, interviewRate } = today.pipeline;
  const movement = usePipelineMovement(byStatus);
  const total = Object.values(byStatus).reduce((sum, n) => sum + n, 0);
  if (total === 0) {
    return (
      <EmptyLine>
        No applications yet.{" "}
        <Link component={RouterLink} to="/settings/import">
          Import your spreadsheet
        </Link>{" "}
        or{" "}
        <Link component={RouterLink} to="/settings/gmail">
          start syncing Gmail
        </Link>
        , and they show up here.
      </EmptyLine>
    );
  }
  return (
    <Box sx={{ px: 2.5, pb: 2.5 }}>
      <PipelineRoute byStatus={byStatus} movement={movement} />
      <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 2 }}>
        {`${total === 1 ? "1 application" : `${total} applications`}. Response rate ${percent(responseRate)}. Reached screening or later ${percent(interviewRate)}.`}
      </Typography>
    </Box>
  );
}

// ---------------------------------------------------------------------------------------------
// Today's targets

function TargetsBody({ today }: { today: Today }) {
  const log = useLogDailyActivity();
  const linkSx = useLinkSx();
  const snackbar = useUndoSnackbar();
  const { counts, targets } = today;

  const record = (kind: "outreach" | "prep_minutes", amount: number, message: string) =>
    log.mutate({ kind, amount }, { onSuccess: () => snackbar.show(message) });

  return (
    <Box sx={{ px: 2.5, pb: 2.5, display: "flex", flexDirection: "column", gap: 2 }}>
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(180px, 100%), 1fr))",
          gap: "20px 24px",
        }}
      >
        <TargetMeter
          label="Applications"
          value={counts.applications}
          min={targets.applications.min}
          max={targets.applications.max}
          caption={
            counts.applications >= targets.applications.min ? undefined : (
              <Link component={RouterLink} to="/leads?tab=shortlisted" sx={linkSx}>
                Pick from shortlisted
              </Link>
            )
          }
        />
        <TargetMeter
          label="New leads"
          value={counts.newLeads}
          min={targets.leads.min}
          max={targets.leads.max}
        />
        <TargetMeter
          label="Outreach"
          value={counts.outreach}
          min={targets.outreach.min}
          actions={
            <Button
              size="small"
              variant="outlined"
              disabled={log.isPending}
              onClick={() => record("outreach", 1, "Logged 1 outreach message")}
            >
              +1 message
            </Button>
          }
        />
        <TargetMeter
          label="Follow-ups"
          value={counts.followUps}
          min={targets.followUps.min}
          max={targets.followUps.max}
          caption={
            counts.followUps >= targets.followUps.min ? undefined : "Counted from your sent mail"
          }
        />
        <TargetMeter
          label="Interview prep"
          value={counts.prepMinutes}
          min={targets.prepMinutes.min}
          unit="min"
          actions={[15, 30, 60].map((minutes) => (
            <Button
              key={minutes}
              size="small"
              variant="outlined"
              aria-label={`+${minutes} minutes`}
              disabled={log.isPending}
              onClick={() =>
                record("prep_minutes", minutes, `Logged ${minutes} minutes of interview prep`)
              }
            >
              {`+${minutes}`}
            </Button>
          ))}
        />
      </Box>
      {log.isError ? (
        <Alert severity="error" role="alert">
          {`Couldn't log that. ${log.error instanceof ApiClientError ? log.error.message : "Check your connection and try again."}`}
        </Alert>
      ) : null}
    </Box>
  );
}

// ---------------------------------------------------------------------------------------------
// Follow-ups, review, leads

function FollowUps({
  today,
  timezone,
  now,
  followUpDays,
}: {
  today: Today;
  timezone: string;
  now: Date;
  /** Undefined until settings have loaded: the sentence then leaves the number out. */
  followUpDays: number | undefined;
}) {
  const mark = useMarkFollowedUp();
  const snackbar = useUndoSnackbar();
  const apps = today.followUpsDue;

  if (apps.length === 0) {
    return (
      <EmptyLine>
        {followUpDays === undefined
          ? "No follow-ups due."
          : `No follow-ups due. Applications without a reply for ${followUpDays} days show up here.`}
      </EmptyLine>
    );
  }
  const onMark = (application: ApplicationSummary) =>
    mark.mutate(application, {
      onSuccess: () => snackbar.show("Marked as followed up"),
      onError: () => snackbar.show("Couldn't mark it as followed up. Try again."),
    });
  return (
    <Box component="ul" sx={{ m: 0, p: 0 }}>
      {apps.map((application) => (
        <FollowUpRow
          key={application.id}
          application={application}
          timezone={timezone}
          now={now}
          onMarkFollowedUp={onMark}
        />
      ))}
    </Box>
  );
}

function reviewCaption(item: ReviewItem, timezone: string): string {
  const parts: string[] = [];
  if (item.message) {
    const subject = item.message.subject ? `, "${item.message.subject}"` : "";
    parts.push(`Email ${formatShortDate(item.message.internalDate, timezone)}${subject}.`);
  }
  const summary = item.proposal.operations[0]?.summary;
  if (summary) parts.push(summary);
  if (item.confidence !== null) parts.push(`Confidence ${Math.round(item.confidence * 100)}%.`);
  return parts.join(" ");
}

function ReviewList({ today, timezone }: { today: Today; timezone: string }) {
  if (today.review.open === 0 && today.review.first.length === 0) {
    return (
      <EmptyLine>
        Nothing to review. Changes Offerbound is sure about are applied on their own.
      </EmptyLine>
    );
  }
  return (
    <Box component="ul" sx={{ m: 0, p: 0 }}>
      {today.review.first.map((item) => (
        <Box
          key={item.id}
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
            <Typography sx={{ fontWeight: 600 }}>{item.proposal.description}</Typography>
            <Typography variant="caption" color="text.secondary" component="p">
              {reviewCaption(item, timezone)}
            </Typography>
          </Box>
          <Button
            component={RouterLink}
            to="/review"
            size="small"
            variant="outlined"
            aria-label={`Review: ${item.proposal.description}`}
          >
            Review
          </Button>
        </Box>
      ))}
    </Box>
  );
}

function TopLeads({
  today,
  timezone,
  now,
  settings,
}: {
  today: Today;
  timezone: string;
  now: Date;
  settings: Settings | undefined;
}) {
  const setStatus = useSetLeadStatus();
  const snackbar = useUndoSnackbar();

  if (today.topLeads.length === 0) {
    const search = settings?.search;
    return (
      <EmptyLine>
        {!search
          ? "No new leads."
          : !search.enabled
            ? "No new leads. The daily search is off; use Run search now to look for leads."
            : `No new leads. The next search runs at ${search.runTime}.`}
      </EmptyLine>
    );
  }

  const act = (lead: Lead, status: "shortlisted" | "dismissed") =>
    setStatus.mutate(
      { lead, status },
      {
        onSuccess: (updated) =>
          snackbar.show(
            `${status === "shortlisted" ? "Shortlisted" : "Dismissed"} ${lead.company.name}`,
            async () => {
              await setStatus.mutateAsync({ lead: updated, status: "new" });
            },
          ),
        onError: (error) =>
          snackbar.show(
            isVersionConflict(error)
              ? CHANGED_ELSEWHERE
              : `Couldn't ${status === "shortlisted" ? "shortlist" : "dismiss"} ${lead.company.name}. Try again.`,
          ),
      },
    );

  return (
    <Box component="ul" sx={{ m: 0, p: 0 }}>
      {today.topLeads.map((lead) => (
        <LeadRow
          key={lead.id}
          lead={lead}
          timezone={timezone}
          now={now}
          onShortlist={(l) => act(l, "shortlisted")}
          onDismiss={(l) => act(l, "dismissed")}
        />
      ))}
    </Box>
  );
}

// ---------------------------------------------------------------------------------------------
// Next 7 days

function AgendaItem({
  interview,
  timezone,
}: {
  interview: InterviewWithApplication;
  timezone: string;
}) {
  const { application } = interview;
  const toSchedule = interview.startsAt === null;
  const caption = `${application.company.name}, ${application.title}`;
  const link = useLinkSx({ alignSelf: "flex-start" });

  return (
    <Box
      component="li"
      sx={(theme) => ({
        listStyle: "none",
        px: 2.5,
        py: 1.75,
        borderTop: 1,
        borderColor: "divider",
        display: "flex",
        flexDirection: "column",
        gap: 0.75,
        ...(toSchedule ? { bgcolor: theme.palette.tokens.signalTint } : {}),
      })}
    >
      {interview.startsAt ? (
        <>
          <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
            {formatDate(interview.startsAt, timezone)}
          </Typography>
          <Typography>
            <Box component="span" sx={{ fontWeight: 700 }}>
              {interview.endsAt
                ? `${formatTime(interview.startsAt, timezone)}–${formatTime(interview.endsAt, timezone)}`
                : formatTime(interview.startsAt, timezone)}
            </Box>{" "}
            {INTERVIEW_KIND[interview.kind]}
          </Typography>
        </>
      ) : (
        <>
          <Typography
            variant="caption"
            sx={{ fontWeight: 600, color: "warning.main" }}
            component="p"
          >
            To schedule
          </Typography>
          <Typography>{INTERVIEW_KIND[interview.kind]}</Typography>
        </>
      )}
      <Link
        component={RouterLink}
        to={`/applications/${application.id}`}
        variant="caption"
        color="text.secondary"
        underline="hover"
        sx={useLinkSx({ fontSize: 13, fontWeight: 400, textDecoration: undefined })}
      >
        {caption}
      </Link>
      {isHttpUrl(interview.meetingUrl) ? (
        <Link
          href={interview.meetingUrl}
          target="_blank"
          rel="noopener noreferrer"
          sx={link}
          underline="none"
        >
          Join video call
        </Link>
      ) : null}
      {toSchedule && isHttpUrl(interview.schedulingUrl) ? (
        <Link
          href={interview.schedulingUrl}
          target="_blank"
          rel="noopener noreferrer"
          sx={{ ...link, color: "warning.main" }}
          underline="none"
        >
          Pick a time
        </Link>
      ) : null}
    </Box>
  );
}

function Agenda({ today, timezone }: { today: Today; timezone: string }) {
  const items = today.upcomingInterviews.filter((i) => i.status !== "cancelled");
  if (items.length === 0) return <EmptyLine>No interviews in the next 7 days.</EmptyLine>;
  return (
    <Box component="ul" sx={{ m: 0, p: 0 }}>
      {items.map((interview) => (
        <AgendaItem key={interview.id} interview={interview} timezone={timezone} />
      ))}
    </Box>
  );
}

// ---------------------------------------------------------------------------------------------
// Page

export function TodayPage() {
  const today = useToday();
  const timezone = useTimezone();
  const settings = useSettings();
  const sync = useSyncStatus();
  const runSearch = useRunSearch();
  const snackbar = useUndoSnackbar();
  // One "now" per answer, so relative sentences ("no reply for 9 days") stay still between polls.
  const now = useMemo(() => new Date(), [today.dataUpdatedAt]);

  // Owner-set values: not stated until settings have loaded.
  const followUpDays = settings.data?.timers.followUpDays;
  const abandonDays = settings.data?.timers.abandonDays;
  const newLeads = useNavCounts().data?.newLeads;
  const linkSx = useLinkSx();
  const firstSync = sync.data;

  const startSearch = () =>
    runSearch.mutate(undefined, {
      onSuccess: () => snackbar.show("Search started"),
      onError: (error) =>
        snackbar.show(
          error instanceof ApiClientError && error.code === "already_running"
            ? SEARCH_RUNNING
            : "Couldn't start the search. Try again.",
        ),
    });

  const dateLine = today.data
    ? (formatLongDay(today.data.date) ?? formatDate(now, timezone))
    : null;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <Box
        component="header"
        sx={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: 2,
        }}
      >
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
          <Typography variant="h4" component="h1">
            Today
          </Typography>
          {dateLine ? (
            <Typography variant="caption" color="text.secondary" component="p">
              {dateLine}
            </Typography>
          ) : (
            <Skeleton variant="text" width={160} />
          )}
        </Box>
        <Button
          variant="outlined"
          startIcon={<SearchOutlined />}
          disabled={runSearch.isPending}
          onClick={startSearch}
        >
          Run search now
        </Button>
      </Box>

      {firstSync?.started && firstSync.backfill.state === "running" ? (
        <FirstSyncCard
          listed={firstSync.backfill.listed}
          processed={firstSync.backfill.processed}
        />
      ) : null}
      {firstSync?.started && firstSync.backfill.state === "failed" ? (
        <Alert severity="warning">
          <Box component="span" sx={{ fontWeight: 700 }}>
            The first sync stopped before it finished.
          </Box>{" "}
          Use Sync now to try again.
        </Alert>
      ) : null}

      <Section title="Pipeline">
        <Body query={today} what="the pipeline" skeleton={<RouteSkeleton />}>
          {(data) => <PipelineBody today={data} />}
        </Body>
      </Section>

      <Section
        title="Today's targets"
        note={`Counts reset at midnight, ${zoneCity(timezone)} time`}
      >
        <Body query={today} what="today's targets" skeleton={<MetersSkeleton />}>
          {(data) => <TargetsBody today={data} />}
        </Body>
      </Section>

      <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: 3 }}>
        <Box
          sx={{ flex: "2 1 520px", minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}
        >
          <Section
            title="Follow-ups due"
            count={today.data?.followUpsDue.length}
            note={
              followUpDays === undefined
                ? undefined
                : `No reply from the company for ${followUpDays} days or more`
            }
            noteAfter={
              today.data && today.data.followUpsDue.length > 0 && abandonDays !== undefined
                ? `After ${abandonDays} days without a reply, an application is marked Abandoned. A reply reopens it.`
                : undefined
            }
          >
            <Body
              query={today}
              what="follow-ups"
              skeleton={<RowsSkeleton title="Follow-ups due" />}
            >
              {(data) => (
                <FollowUps today={data} timezone={timezone} now={now} followUpDays={followUpDays} />
              )}
            </Body>
          </Section>

          <Section
            title="Needs your review"
            count={today.data?.review.open}
            action={
              <Link component={RouterLink} to="/review" sx={linkSx}>
                Open review queue
              </Link>
            }
          >
            <Body
              query={today}
              what="what needs review"
              skeleton={<RowsSkeleton title="Needs your review" />}
            >
              {(data) => <ReviewList today={data} timezone={timezone} />}
            </Body>
          </Section>

          <Section
            title="Top new leads"
            action={
              <Link component={RouterLink} to="/leads" sx={linkSx}>
                {newLeads === undefined ? "See all new leads" : `See all ${newLeads}`}
              </Link>
            }
          >
            <Body
              query={today}
              what="new leads"
              skeleton={<RowsSkeleton title="Top new leads" rows={3} />}
            >
              {(data) => (
                <TopLeads today={data} timezone={timezone} now={now} settings={settings.data} />
              )}
            </Body>
          </Section>
        </Box>

        <Box component="aside" sx={{ flex: "1 1 320px", minWidth: 0 }}>
          <Section
            title="Next 7 days"
            action={
              <Link component={RouterLink} to="/interviews" sx={linkSx}>
                All interviews
              </Link>
            }
          >
            <Body
              query={today}
              what="interviews"
              skeleton={<RowsSkeleton title="Next 7 days" rows={3} />}
            >
              {(data) => <Agenda today={data} timezone={timezone} />}
            </Body>
          </Section>
        </Box>
      </Box>
    </Box>
  );
}
