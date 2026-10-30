import {
  ApplicationStatusSchema,
  type ApplicationDetail,
  type ApplicationSource,
  type ApplicationStatus,
  type Interview,
  type MessageSummary,
  type WorkMode,
} from "@offerbound/contracts";
import MoreVertOutlined from "@mui/icons-material/MoreVertOutlined";
import OpenInNewOutlined from "@mui/icons-material/OpenInNewOutlined";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Link from "@mui/material/Link";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Skeleton from "@mui/material/Skeleton";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Link as RouterLink, useNavigate, useParams } from "react-router";
import { ApiClientError } from "../api/client";
import {
  isApiError,
  queryKeys,
  useApplication,
  useTimezone,
  useUndoEvent,
  useUpdateApplication,
} from "../api/hooks";
import { EmailSheet } from "../components/EmailSheet";
import { INTERVIEW_KIND } from "../components/InterviewRow";
import { MergeApplicationDialog } from "../components/MergeApplicationDialog";
import { ErrorState } from "../components/States";
import { FlagChip, STATUS_LABEL, StatusChip } from "../components/StatusChip";
import { Timeline } from "../components/Timeline";
import { useUndoSnackbar } from "../components/UndoSnackbar";
import { formatDate, formatDateTime, formatShortDate, formatTime, zoneCity } from "../lib/format";
import { isHttpUrl } from "../lib/url";

/**
 * Application detail (DESIGN_SPEC §5.3; AC-4.2 to 4.4, AC-6.2, AC-6.3): company, status, the next
 * interview, the timeline with *Undo* and *View email*, the details and autosaved notes.
 */

const NOTES_AUTOSAVE_MS = 800;
const CHANGED_ELSEWHERE = "Changes were made elsewhere. The latest version is shown.";

const WORK_MODE: Record<WorkMode, string | null> = {
  remote: "Remote",
  hybrid: "Hybrid",
  onsite: "On-site",
  unknown: null,
};

const SOURCE: Record<ApplicationSource, string> = {
  sheet_import: "Imported from your spreadsheet",
  gmail: "Created from an email",
  lead_conversion: "Lead from the search",
  manual: "Added by you",
};

// ---------------------------------------------------------------------------------------------
// Pieces

const headingSx = { fontSize: 18, lineHeight: "24px", fontWeight: 700 } as const;

function Card({
  title,
  action,
  children,
  titleNode,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  /** Replaces the plain title text, for a heading that is also a field label. */
  titleNode?: ReactNode;
}) {
  const id = useId();
  return (
    <Paper
      component="section"
      variant="outlined"
      aria-labelledby={id}
      sx={{ p: 2.5, display: "flex", flexDirection: "column", gap: 1.5 }}
    >
      <Box
        sx={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 1,
        }}
      >
        <Typography id={id} variant="h5" component="h2" sx={headingSx}>
          {titleNode ?? title}
        </Typography>
        {action}
      </Box>
      {children}
    </Paper>
  );
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <Box>
      <Typography
        component="dt"
        variant="caption"
        color="text.secondary"
        sx={{ fontWeight: 600, display: "block" }}
      >
        {term}
      </Typography>
      <Typography component="dd" sx={{ m: 0, overflowWrap: "anywhere" }}>
        {children}
      </Typography>
    </Box>
  );
}

function NotSet() {
  return (
    <Typography component="span" color="text.secondary">
      Not set
    </Typography>
  );
}

/** "jobs.example/kestrel-pay/7f3c…" for a long posting address. */
function shortUrl(url: string): string {
  try {
    const { host, pathname } = new URL(url);
    const text = `${host}${pathname === "/" ? "" : pathname}`;
    return text.length > 44 ? `${text.slice(0, 43)}…` : text;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------------------------
// Next interview

function nextInterview(interviews: Interview[], now: Date): Interview | null {
  const upcoming = interviews
    .filter((i) => i.status === "scheduled" && i.startsAt !== null && new Date(i.startsAt) >= now)
    .sort((a, b) => new Date(a.startsAt ?? 0).getTime() - new Date(b.startsAt ?? 0).getTime());
  return upcoming[0] ?? interviews.find((i) => i.status === "to_schedule") ?? null;
}

function range(startsAt: string, endsAt: string | null, tz: string): string {
  return endsAt
    ? `${formatTime(startsAt, tz)}–${formatTime(endsAt, tz)}`
    : formatTime(startsAt, tz);
}

/** "Monterrey time. Invite sent for 12:00–13:00 New York." when the invite named another zone. */
function zoneNote(interview: Interview, tz: string): string {
  const own = `${zoneCity(tz)} time.`;
  const hint = interview.timezoneHint;
  if (!interview.startsAt || !hint || hint === tz) return own;
  try {
    return `${own} Invite sent for ${range(interview.startsAt, interview.endsAt, hint)} ${zoneCity(hint)}.`;
  } catch {
    return own; // not a zone this browser knows
  }
}

function NextInterview({ interviews, timezone }: { interviews: Interview[]; timezone: string }) {
  const now = useMemo(() => new Date(), [interviews]);
  const interview = nextInterview(interviews, now);
  return (
    <Card title="Next interview">
      {interview === null ? (
        <Typography color="text.secondary">No interview scheduled.</Typography>
      ) : (
        <>
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: "16px 32px" }}>
            <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25 }}>
              <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
                {INTERVIEW_KIND[interview.kind]}
              </Typography>
              {interview.startsAt ? (
                <>
                  <Typography sx={{ fontSize: 18, lineHeight: "24px", fontWeight: 700 }}>
                    {`${formatDate(interview.startsAt, timezone)}, ${range(interview.startsAt, interview.endsAt, timezone)}`}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {zoneNote(interview, timezone)}
                  </Typography>
                </>
              ) : (
                <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                  <FlagChip tone="signal" label="To schedule" />
                  {isHttpUrl(interview.schedulingUrl) ? (
                    <Link
                      href={interview.schedulingUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      underline="none"
                      sx={{ fontWeight: 600 }}
                    >
                      Pick a time
                    </Link>
                  ) : null}
                </Box>
              )}
            </Box>
            {interview.interviewers.length > 0 || isHttpUrl(interview.meetingUrl) ? (
              <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25 }}>
                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
                  Interviewers
                </Typography>
                {interview.interviewers.length > 0 ? (
                  <Typography>{interview.interviewers.join(", ")}</Typography>
                ) : null}
                {isHttpUrl(interview.meetingUrl) ? (
                  <Link
                    href={interview.meetingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    underline="none"
                    sx={{ fontWeight: 600 }}
                  >
                    Join video call
                  </Link>
                ) : null}
              </Box>
            ) : null}
          </Box>
          {interview.notes ? (
            <Box>
              <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
                Prep notes
              </Typography>
              <Typography sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {interview.notes}
              </Typography>
            </Box>
          ) : null}
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Emails

function senderOf(message: MessageSummary): string {
  return message.fromName?.trim() || message.fromEmail || "Unknown sender";
}

function Emails({
  messages,
  timezone,
  onView,
}: {
  messages: MessageSummary[];
  timezone: string;
  onView: (messageId: string) => void;
}) {
  if (messages.length === 0) return null;
  return (
    <Card title="Emails">
      <Box component="ul" sx={{ m: 0, p: 0, listStyle: "none" }}>
        {messages.map((message, i) => (
          <Box
            key={message.id}
            component="li"
            sx={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "8px 16px",
              py: 1.5,
              ...(i > 0 ? { borderTop: 1, borderColor: "divider" } : {}),
            }}
          >
            <Box sx={{ flex: "1 1 260px", minWidth: 0 }}>
              <Typography sx={{ fontWeight: 600 }}>{message.subject ?? "No subject"}</Typography>
              <Typography variant="caption" color="text.secondary" component="p">
                {`${senderOf(message)}, ${formatDateTime(message.internalDate, timezone)}`}
              </Typography>
              {message.summary ? (
                <Typography variant="body2" color="text.secondary">
                  {message.summary}
                </Typography>
              ) : null}
            </Box>
            <Button size="small" onClick={() => onView(message.id)}>
              View email
            </Button>
          </Box>
        ))}
      </Box>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Details and notes

function Details({ detail, timezone }: { detail: ApplicationDetail; timezone: string }) {
  const posting = isHttpUrl(detail.jobUrl) ? detail.jobUrl : null;
  return (
    <Card title="Details">
      <Box component="dl" sx={{ m: 0, display: "flex", flexDirection: "column", gap: 1.5 }}>
        <Fact term="Job posting">
          {posting ? (
            <Link href={posting} target="_blank" rel="noopener noreferrer" underline="none">
              {shortUrl(posting)}
            </Link>
          ) : (
            <NotSet />
          )}
        </Fact>
        <Fact term="Location">{detail.locationText ?? <NotSet />}</Fact>
        {detail.country ? <Fact term="Country">{detail.country}</Fact> : null}
        <Fact term="Compensation">{detail.compensationText ?? <NotSet />}</Fact>
        {detail.sponsorshipText ? <Fact term="Sponsorship">{detail.sponsorshipText}</Fact> : null}
        <Fact term="Applied">
          {detail.appliedAt ? formatShortDate(detail.appliedAt, timezone) : <NotSet />}
        </Fact>
        <Fact term="Last reply from company">
          {detail.lastCompanyActivityAt ? (
            formatShortDate(detail.lastCompanyActivityAt, timezone)
          ) : (
            <Typography component="span" color="text.secondary">
              No reply yet
            </Typography>
          )}
        </Fact>
        <Fact term="Source">{SOURCE[detail.source]}</Fact>
      </Box>
    </Card>
  );
}

type NotesStatus = "idle" | "saved" | "failed";

/**
 * Notes, saved 800 ms after typing stops (AC-6.2). A `409 version_conflict` fetches the record
 * again first. If the notes were left alone elsewhere, what was typed is saved on the fresh
 * version; if they were edited elsewhere, the fresh notes are shown rather than overwritten.
 */
function Notes({ detail, onConflict }: { detail: ApplicationDetail; onConflict: () => void }) {
  const queryClient = useQueryClient();
  const serverNotes = detail.notes ?? "";
  const [text, setText] = useState(serverNotes);
  const [status, setStatus] = useState<NotesStatus>("idle");
  /** What the server is known to hold. */
  const saved = useRef(serverNotes);
  const latest = useRef(detail);
  const fieldId = useId();

  useEffect(() => {
    latest.current = detail;
  });

  // Notes that changed on the server (an undo, a refetch) replace the field unless there is unsaved typing.
  useEffect(() => {
    if (serverNotes !== saved.current && text === saved.current) {
      saved.current = serverNotes;
      setText(serverNotes);
    }
  }, [serverNotes, text]);

  const update = useUpdateApplication({
    onSuccess: (_detail, { patch }) => {
      saved.current = patch.notes ?? "";
      setStatus("saved");
    },
    onError: (error) => {
      if (isApiError(error, "version_conflict")) {
        onConflict();
        const fresh = queryClient.getQueryData<ApplicationDetail>(queryKeys.application(detail.id));
        const freshNotes = fresh?.notes ?? "";
        if (fresh && freshNotes !== saved.current) {
          saved.current = freshNotes;
          setText(freshNotes);
        }
        // otherwise the effect below saves the typing again, now on the fresh version
      } else {
        setStatus("failed");
      }
    },
  });

  const { isPending, mutate } = update;
  useEffect(() => {
    if (text === saved.current || isPending || status === "failed") return;
    const timer = setTimeout(
      () =>
        mutate({
          application: latest.current,
          patch: { notes: text === "" ? null : text },
        }),
      NOTES_AUTOSAVE_MS,
    );
    return () => clearTimeout(timer);
  }, [text, isPending, status, detail.version, mutate]);

  return (
    <Card title="Notes" titleNode={<label htmlFor={fieldId}>Notes</label>}>
      <TextField
        id={fieldId}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setStatus("idle");
        }}
        multiline
        minRows={5}
        fullWidth
      />
      <Typography variant="caption" color="text.secondary" role="status" aria-live="polite">
        {isPending
          ? "Saving…"
          : status === "failed"
            ? "Couldn't save your notes. Keep typing to try again."
            : status === "saved"
              ? "Saved"
              : "Saved automatically"}
      </Typography>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// States

function DetailSkeleton() {
  return (
    <Box
      role="status"
      aria-busy="true"
      aria-label="Loading application"
      sx={{ display: "flex", flexDirection: "column", gap: 3 }}
    >
      <Skeleton variant="rounded" width={180} height={16} />
      <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
        <Skeleton variant="rounded" width="40%" height={32} />
        <Skeleton variant="rounded" width="30%" height={22} />
      </Box>
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
        <Paper variant="outlined" sx={{ flex: "2 1 520px", p: 2.5 }}>
          {Array.from({ length: 4 }, (_, i) => (
            <Box key={i} sx={{ display: "flex", gap: 2, py: 1.5 }}>
              <Skeleton variant="circular" width={20} height={20} />
              <Box sx={{ flex: 1, display: "flex", flexDirection: "column", gap: 1 }}>
                <Skeleton variant="rounded" width="20%" height={12} />
                <Skeleton variant="rounded" width={`${60 + ((i * 9) % 30)}%`} height={14} />
              </Box>
            </Box>
          ))}
        </Paper>
        <Paper variant="outlined" sx={{ flex: "1 1 300px", p: 2.5 }}>
          <Skeleton variant="rounded" height={120} />
        </Paper>
      </Box>
    </Box>
  );
}

function BackToApplications() {
  return (
    <Button
      component={RouterLink}
      to="/applications"
      variant="outlined"
      sx={{ alignSelf: "flex-start" }}
    >
      Back to applications
    </Button>
  );
}

function NotFound({ error }: { error: unknown }) {
  const missing = error instanceof ApiClientError && error.status === 404;
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2, maxWidth: 560 }}>
      <Typography variant="h4" component="h1">
        Application not found
      </Typography>
      <Typography color="text.secondary">
        {missing
          ? "It may have been merged into another application or removed. Check the link, or go back to the list."
          : "Go back to the list and open it again."}
      </Typography>
      <BackToApplications />
    </Box>
  );
}

// ---------------------------------------------------------------------------------------------
// Page

function Detail({ detail }: { detail: ApplicationDetail }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const timezone = useTimezone();
  const snackbar = useUndoSnackbar();
  const [openEmail, setOpenEmail] = useState<string | null>(null);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [merging, setMerging] = useState(false);
  const [conflict, setConflict] = useState(false);
  const menuId = useId();
  const latest = useRef(detail);
  const statusBefore = useRef<ApplicationStatus>(detail.status);
  useEffect(() => {
    latest.current = detail;
  });

  const update = useUpdateApplication({
    onSuccess: (updated, { patch }) => {
      setConflict(false);
      if (patch.status === undefined) return;
      if (patch.status === "withdrawn") {
        const previous = statusBefore.current;
        snackbar.show("Marked as withdrawn", async () => {
          await restore.mutateAsync({
            application: latest.current,
            patch: { status: previous },
          });
        });
      } else {
        snackbar.show(`Status changed to ${STATUS_LABEL[updated.status]}`);
      }
    },
    onError: (error) => {
      if (isApiError(error, "version_conflict")) setConflict(true);
      else snackbar.show("Couldn't save the change. Try again.");
    },
  });
  // Puts a withdrawn application back; its failures are the snackbar's to report.
  const restore = useUpdateApplication();

  const undo = useUndoEvent({
    onSuccess: () => {
      setConflict(false);
      snackbar.show("Undone");
    },
    onError: (error) => {
      if (isApiError(error, "changed_since")) snackbar.show("Changed since — edit manually");
      else if (isApiError(error, "version_conflict")) setConflict(true);
      else snackbar.show("Couldn't undo this change. Try again.");
    },
  });

  const changeStatus = (status: ApplicationStatus) => {
    if (status === detail.status) return;
    statusBefore.current = detail.status;
    update.mutate({ application: detail, patch: { status } });
  };

  const posting = isHttpUrl(detail.jobUrl) ? detail.jobUrl : null;
  const workMode = WORK_MODE[detail.workMode];

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2.5 }}>
      <Typography component="nav" aria-label="Breadcrumb" variant="caption" color="text.secondary">
        <Link component={RouterLink} to="/applications" underline="none" sx={{ fontWeight: 600 }}>
          Applications
        </Link>
        {" / "}
        <span aria-current="page">{detail.company.name}</span>
      </Typography>

      <Box
        component="header"
        sx={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 2,
        }}
      >
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75, minWidth: 0 }}>
          <Typography variant="h4" component="h1" sx={{ overflowWrap: "anywhere" }}>
            {detail.company.name}
          </Typography>
          <Typography sx={{ fontSize: 18, lineHeight: "24px" }} color="text.secondary">
            {detail.title}
          </Typography>
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.75, mt: 0.5 }}>
            <StatusChip status={detail.status} />
            {detail.followUpDue ? <FlagChip tone="signal" label="Follow-up due" /> : null}
            {workMode ? <FlagChip tone="neutral" label={workMode} /> : null}
          </Box>
        </Box>
        <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 1 }}>
          <TextField
            select
            label="Status"
            value={detail.status}
            disabled={update.isPending}
            onChange={(e) => changeStatus(ApplicationStatusSchema.parse(e.target.value))}
            sx={{ minWidth: 168 }}
          >
            {ApplicationStatusSchema.options.map((s) => (
              <MenuItem key={s} value={s}>
                {STATUS_LABEL[s]}
              </MenuItem>
            ))}
          </TextField>
          {posting ? (
            <Button
              component="a"
              href={posting}
              target="_blank"
              rel="noopener noreferrer"
              variant="outlined"
              startIcon={<OpenInNewOutlined />}
            >
              Open posting
            </Button>
          ) : null}
          <IconButton
            aria-label="More actions"
            aria-haspopup="menu"
            aria-controls={menu ? menuId : undefined}
            aria-expanded={menu ? true : undefined}
            onClick={(e) => setMenu(e.currentTarget)}
          >
            <MoreVertOutlined />
          </IconButton>
          <Menu id={menuId} anchorEl={menu} open={menu !== null} onClose={() => setMenu(null)}>
            <MenuItem
              sx={{ minHeight: 44 }}
              onClick={() => {
                setMenu(null);
                setMerging(true);
              }}
            >
              Merge into…
            </MenuItem>
            <MenuItem
              sx={{ minHeight: 44 }}
              disabled={detail.status === "withdrawn"}
              onClick={() => {
                setMenu(null);
                changeStatus("withdrawn");
              }}
            >
              Withdraw
            </MenuItem>
          </Menu>
        </Box>
      </Box>

      {conflict ? (
        <Alert severity="info" onClose={() => setConflict(false)}>
          {CHANGED_ELSEWHERE}
        </Alert>
      ) : null}

      <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: 3 }}>
        <Box
          sx={{ flex: "2 1 520px", minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}
        >
          <NextInterview interviews={detail.interviews} timezone={timezone} />
          <Card
            title="Timeline"
            action={
              <Typography variant="caption" color="text.secondary">
                Filled stop: automatic change. Ring: email. Square: your action.
              </Typography>
            }
          >
            <Timeline
              events={detail.timeline}
              timezone={timezone}
              onUndo={(eventId) => {
                if (!undo.isPending) undo.mutate(eventId);
              }}
              onViewEmail={setOpenEmail}
            />
          </Card>
          <Emails messages={detail.messages} timezone={timezone} onView={setOpenEmail} />
        </Box>
        <Box
          component="aside"
          sx={{ flex: "1 1 300px", minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}
        >
          <Details detail={detail} timezone={timezone} />
          <Notes detail={detail} onConflict={() => setConflict(true)} />
        </Box>
      </Box>

      <EmailSheet messageId={openEmail} onClose={() => setOpenEmail(null)} timezone={timezone} />
      <MergeApplicationDialog
        open={merging}
        source={detail}
        onClose={() => setMerging(false)}
        onMerged={(target) => {
          queryClient.removeQueries({ queryKey: queryKeys.application(detail.id), exact: true });
          void navigate(`/applications/${encodeURIComponent(target.id)}`);
        }}
      />
    </Box>
  );
}

export function ApplicationDetailPage() {
  const { id = "" } = useParams();
  const query = useApplication(id);

  if (query.data) return <Detail key={query.data.id} detail={query.data} />;
  if (query.isPending) return <DetailSkeleton />;
  if (query.error instanceof ApiClientError && query.error.status === 404) {
    return <NotFound error={query.error} />;
  }
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2, maxWidth: 560 }}>
      <Typography variant="h4" component="h1">
        Application
      </Typography>
      <ErrorState what="the application" error={query.error} onRetry={() => void query.refetch()} />
      <BackToApplications />
    </Box>
  );
}
