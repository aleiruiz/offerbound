import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import LinearProgress from "@mui/material/LinearProgress";
import Link from "@mui/material/Link";
import Paper from "@mui/material/Paper";
import Skeleton from "@mui/material/Skeleton";
import Typography from "@mui/material/Typography";
import type { SyncStatus } from "@offerbound/contracts";
import { useMemo, useState } from "react";
import { Link as RouterLink } from "react-router";
import { ApiClientError } from "../../api/client";
import { useDisconnectGmail, useMe, useSyncGmail, useSyncStatus } from "../../api/hooks";
import { GOOGLE_START_PATH } from "../../api/paths";
import { ErrorState } from "../../components/States";
import { formatCount, formatRelative } from "../../lib/format";
import { useLinkSx } from "../../lib/link-sx";
import { SectionPaper, ToneChip, type Tone } from "./shared";

/**
 * Settings, Gmail (DESIGN_SPEC §5.7, AC-2.5, AC-2.8): the connection, the last check, the first-sync
 * progress, the five counts of email waiting at each stage, and what Offerbound reads.
 */

const SYNC_MINUTES = 5;

const CONNECTION: Record<SyncStatus["connection"], { label: string; tone: Tone }> = {
  active: { label: "Connected", tone: "route" },
  needs_reauth: { label: "Needs reconnecting", tone: "signal" },
  missing_scope: { label: "Needs reconnecting", tone: "signal" },
  not_connected: { label: "Not connected", tone: "neutral" },
  disconnected: { label: "Disconnected", tone: "neutral" },
};

export function Gmail() {
  const status = useSyncStatus();
  if (status.isPending) {
    return (
      <Paper variant="outlined" aria-busy="true" sx={{ p: 3 }}>
        <Skeleton variant="text" width={160} height={32} />
        <Skeleton variant="rounded" height={140} sx={{ mt: 2 }} />
      </Paper>
    );
  }
  if (status.isError) {
    return (
      <ErrorState
        what="the Gmail status"
        error={status.error}
        onRetry={() => void status.refetch()}
      />
    );
  }
  return (
    <>
      <Connection status={status.data} readAt={status.dataUpdatedAt} />
      <WhatItReads />
    </>
  );
}

function Connection({ status, readAt }: { status: SyncStatus; readAt: number }) {
  const me = useMe();
  const sync = useSyncGmail();
  const [confirming, setConfirming] = useState(false);
  // "2 minutes ago" is measured from when the status was read.
  const now = useMemo(() => new Date(), [readAt]);

  const { label, tone } = CONNECTION[status.connection];
  const connected = status.connection === "active";
  const reconnect = status.connection === "needs_reauth" || status.connection === "missing_scope";
  const canDisconnect = connected || reconnect;
  const email = me.data?.email ?? null;
  const account = email ? `${email}, read-only access` : "Read-only access";

  return (
    <SectionPaper id="gmail-heading" title="Gmail">
      <Box sx={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 1.5 }}>
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
          <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1.25 }}>
            <ToneChip tone={tone} label={label} />
          </Box>
          {connected || reconnect ? <Typography>{account}</Typography> : null}
          <Typography variant="caption" color="text.secondary" component="p">
            {status.lastSyncAt
              ? `Last checked ${formatRelative(status.lastSyncAt, now)}. `
              : "Not checked yet. "}
            {`New email is checked every ${SYNC_MINUTES} minutes.`}
          </Typography>
          {status.lastError !== null ? (
            <Typography variant="caption" color="error" component="p">
              The last check didn't finish. Offerbound will try again.
            </Typography>
          ) : null}
        </Box>
        <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: 1 }}>
          {connected ? (
            <Button
              variant="outlined"
              startIcon={<SyncIcon />}
              disabled={sync.isPending}
              onClick={() => sync.mutate()}
            >
              Sync now
            </Button>
          ) : (
            <Button component="a" href={GOOGLE_START_PATH} variant="outlined">
              {reconnect ? "Reconnect Gmail" : "Connect Gmail"}
            </Button>
          )}
          {canDisconnect ? (
            <Button color="error" onClick={() => setConfirming(true)}>
              Disconnect Gmail
            </Button>
          ) : null}
        </Box>
      </Box>

      <Box role="status" aria-live="polite">
        {sync.isSuccess ? (
          <Typography variant="body2" color="text.secondary">
            Checking for new email now.
          </Typography>
        ) : sync.isError ? (
          <Typography variant="body2" color="error">
            {sync.error instanceof ApiClientError && sync.error.code === "already_running"
              ? "A check is already running."
              : "Couldn't start a check. Try again."}
          </Typography>
        ) : null}
      </Box>

      <FirstSync backfill={status.backfill} started={status.started} />
      <Counts queue={status.queue} />

      <DisconnectDialog open={confirming} onClose={() => setConfirming(false)} />
    </SectionPaper>
  );
}

function SyncIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 12a8 8 0 0 1-14.3 4.9M4 12a8 8 0 0 1 14.3-4.9M18 3v4h-4M6 21v-4h4" />
    </svg>
  );
}

function FirstSync({ backfill, started }: { backfill: SyncStatus["backfill"]; started: boolean }) {
  if (!started || backfill.state === "not_started") return null;
  const { state, listed, processed } = backfill;
  const percent =
    state === "done" ? 100 : listed > 0 ? Math.min(100, Math.round((processed / listed) * 100)) : 0;
  const title =
    state === "done"
      ? "First sync finished"
      : state === "failed"
        ? "First sync stopped"
        : "Reading your email";
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
      <Box sx={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 1 }}>
        <Typography variant="subtitle2" component="span">
          {title}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {listed > 0
            ? `${formatCount(processed)} of ${formatCount(listed)} checked`
            : "Finding your email"}
        </Typography>
      </Box>
      {listed > 0 || state === "done" ? (
        <LinearProgress
          variant="determinate"
          value={percent}
          aria-label="First sync progress"
          sx={{ height: 6, borderRadius: "3px" }}
        />
      ) : (
        <LinearProgress aria-label="First sync progress" sx={{ height: 6, borderRadius: "3px" }} />
      )}
      {state === "failed" ? (
        <Typography variant="caption" color="error" component="p">
          The first sync stopped before it finished. Use Sync now to try again.
        </Typography>
      ) : null}
    </Box>
  );
}

function Counts({ queue }: { queue: SyncStatus["queue"] }) {
  const reviewLink = useLinkSx({ textDecoration: "none" });
  const items: { key: string; count: number; label: string; kind?: "review" | "failed" }[] = [
    { key: "discovered", count: queue.discovered, label: "New, not checked yet" },
    { key: "jobRelated", count: queue.jobRelated, label: "Job emails being read" },
    { key: "extracted", count: queue.extracted, label: "Ready to update records" },
    {
      key: "needsReview",
      count: queue.needsReview,
      label: "Waiting for your review",
      kind: "review",
    },
    { key: "failed", count: queue.failed, label: "Couldn't be read", kind: "failed" },
  ];
  return (
    <Box
      component="ul"
      aria-label="Email waiting at each stage"
      sx={{
        listStyle: "none",
        m: 0,
        p: 0,
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(min(150px, 100%), 1fr))",
        border: 1,
        borderColor: "divider",
        borderRadius: 1,
        overflow: "hidden",
      }}
    >
      {items.map((item, index) => {
        const content = (
          <>
            <Typography
              component="span"
              sx={{
                fontSize: 28,
                lineHeight: "32px",
                fontWeight: 800,
                color: item.kind === "failed" && item.count > 0 ? "error.main" : undefined,
              }}
            >
              {formatCount(item.count)}
            </Typography>
            <Typography
              component="span"
              variant={item.kind === "review" ? "subtitle2" : "caption"}
              color={item.kind === "review" ? "primary" : "text.secondary"}
            >
              {item.label}
            </Typography>
          </>
        );
        return (
          <Box
            component="li"
            key={item.key}
            sx={{
              px: 2,
              py: 1.75,
              borderLeft: index === 0 ? 0 : 1,
              borderColor: "divider",
              display: "flex",
            }}
          >
            {item.kind === "review" ? (
              <Link
                component={RouterLink}
                to="/review"
                sx={{ ...reviewLink, display: "flex", flexDirection: "column", gap: 0.25 }}
              >
                {content}
              </Link>
            ) : (
              <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25 }}>{content}</Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

function DisconnectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const disconnect = useDisconnectGmail();
  const { isPending, isError, error, reset } = disconnect;

  const close = () => {
    if (isPending) return;
    reset();
    onClose();
  };

  return (
    <Dialog open={open} onClose={close} aria-labelledby="disconnect-title" fullWidth maxWidth="xs">
      <DialogTitle id="disconnect-title">Disconnect Gmail?</DialogTitle>
      <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <DialogContentText>
          This revokes Offerbound's access at Google, deletes the stored sign-in and stops reading
          email. Your applications, leads and interviews stay as they are.
        </DialogContentText>
        {isError ? (
          <Alert severity="error" role="alert">
            {`Couldn't disconnect Gmail. ${
              error instanceof ApiClientError
                ? error.message
                : "Check your connection and try again."
            }`}
          </Alert>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={close} disabled={isPending}>
          Cancel
        </Button>
        <Button
          color="error"
          variant="contained"
          disabled={isPending}
          onClick={() => disconnect.mutate(undefined, { onSuccess: () => onClose() })}
        >
          Disconnect Gmail
        </Button>
      </DialogActions>
    </Dialog>
  );
}

const READS = [
  "Emails from job sites, hiring systems like Ashby or Greenhouse, and companies you've applied to are read in full and sent to OpenAI to update your records.",
  "For any other email, only the sender, subject and the short preview Gmail shows are sent to OpenAI, to decide whether it's about your job search.",
  "Promotions and forum emails that don't come from a job source are skipped without being sent anywhere.",
  "Emails you send are only read when they go to a company or recruiter you're in touch with, to count follow-ups.",
  "For emails that aren't about your search, Offerbound keeps only the message id and date.",
];

function WhatItReads() {
  const link = useLinkSx();
  return (
    <SectionPaper id="reads-heading" title="What Offerbound reads">
      <Box
        component="ul"
        sx={{ m: 0, pl: 2.5, display: "flex", flexDirection: "column", gap: 1, maxWidth: 760 }}
      >
        {READS.map((text) => (
          <Typography key={text} component="li">
            {text}
          </Typography>
        ))}
      </Box>
      <Typography variant="caption" color="text.secondary" component="p">
        {"Add senders to ignore in Settings, "}
        <Link component={RouterLink} to="/settings/automation" sx={link}>
          Automation
        </Link>
        {"."}
      </Typography>
    </SectionPaper>
  );
}
