import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import SyncOutlined from "@mui/icons-material/SyncOutlined";
import { useEffect } from "react";
import { ApiClientError } from "../api/client";
import { useSyncGmail, useSyncStatus } from "../api/hooks";
import { formatRelative } from "../lib/format";
import { DEMO_REASON, DemoLock, useIsDemo } from "../lib/demo";
import { t } from "../i18n";

const visuallyHidden = {
  position: "absolute",
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
} as const;

export type SyncLayout = "footer" | "rail" | "bar";

type Tone = "ok" | "attention" | "error" | "idle";

interface Summary {
  text: string;
  tone: Tone;
  /** Whether *Sync now* can do anything: Gmail is connected and Google still allows access. */
  canSync: boolean;
}

/** "2 minutes ago" is "2 min ago" in the narrow footer. */
function shortRelative(iso: string, now: Date): string {
  return formatRelative(iso, now)
    .replace(/ minutes? ago$/, " min ago")
    .replace(/ minutos?$/, " min");
}

type SyncAttempt = "none" | "running" | "failed";

/** Why the last *Sync now* did not start one: a sync is already under way, or it failed. */
function attemptOf(error: unknown): SyncAttempt {
  if (error === null) return "none";
  return error instanceof ApiClientError && error.code === "already_running" ? "running" : "failed";
}

function summarize(
  status: ReturnType<typeof useSyncStatus>,
  attempt: SyncAttempt,
  now: Date,
): Summary {
  const data = status.data;
  if (!data) {
    return status.isError
      ? { text: t("Gmail status unavailable"), tone: "error", canSync: false }
      : { text: t("Checking Gmail"), tone: "idle", canSync: false };
  }
  switch (data.connection) {
    case "not_connected":
      return { text: t("Gmail not connected"), tone: "idle", canSync: false };
    case "disconnected":
      return { text: t("Gmail disconnected"), tone: "idle", canSync: false };
    case "needs_reauth":
    case "missing_scope":
      return { text: t("Gmail needs reconnecting"), tone: "attention", canSync: false };
    case "active":
      break;
  }
  if (data.backfill.state === "running") {
    return {
      text: t("Gmail first sync: {processed} of {listed}", {
        processed: data.backfill.processed,
        listed: data.backfill.listed,
      }),
      tone: "ok",
      canSync: true,
    };
  }
  // Only these plain states give way to the outcome of the last *Sync now*.
  if (attempt === "running") {
    return { text: t("Gmail is syncing now"), tone: "ok", canSync: false };
  }
  if (attempt === "failed") {
    return { text: t("Couldn't start a sync. Try again."), tone: "error", canSync: true };
  }
  if (data.lastError !== null) {
    return { text: t("Gmail last sync failed"), tone: "error", canSync: true };
  }
  if (data.lastSyncAt === null) {
    return { text: t("Gmail connected, not synced yet"), tone: "idle", canSync: true };
  }
  return {
    text: t("Gmail synced {when}", { when: shortRelative(data.lastSyncAt, now) }),
    tone: "ok",
    canSync: true,
  };
}

function Dot({ tone }: { tone: Tone }) {
  return (
    <Box
      aria-hidden="true"
      sx={{
        width: 8,
        height: 8,
        borderRadius: "4px",
        flexShrink: 0,
        bgcolor:
          tone === "ok"
            ? "primary.main"
            : tone === "attention"
              ? "warning.main"
              : tone === "error"
                ? "error.main"
                : "text.secondary",
      }}
    />
  );
}

/**
 * Gmail sync status with *Sync now* (AC-2.5, DESIGN_SPEC §3 and §6.5): a dot and a sentence in an
 * `aria-live="polite"` region. `footer` is the drawer footer, `rail` the 72px rail (text for
 * assistive technology, a tooltip on the dot) and `bar` the phone top bar.
 */
export function SyncStatus({ layout }: { layout: SyncLayout }) {
  const status = useSyncStatus();
  const demo = useIsDemo();
  const sync = useSyncGmail();
  // Read so the sentence ("2 min ago") is re-rendered after every poll, even for unchanged data.
  void status.dataUpdatedAt;
  // The outcome of the last *Sync now* describes the status it was sent against: when the status
  // changes (structural sharing keeps `data` the same object while it is unchanged) it is stale.
  const resetSync = sync.reset;
  useEffect(() => {
    resetSync();
  }, [status.data, resetSync]);
  const summary = summarize(status, attemptOf(sync.error), new Date());
  const disabled = !summary.canSync || sync.isPending;
  const syncNow = () => sync.mutate();

  if (layout === "footer") {
    return (
      <Box sx={{ px: 1.5, py: 1.5, display: "flex", flexDirection: "column", gap: 1 }}>
        <Box
          sx={{ display: "flex", alignItems: "center", gap: 1 }}
          role="status"
          aria-live="polite"
        >
          <Dot tone={summary.tone} />
          <Typography variant="caption" color="text.secondary">
            {summary.text}
          </Typography>
        </Box>
        {status.data?.connection === "not_connected" ? null : (
          <DemoLock reason="gmail">
            <Button
              variant="text"
              size="small"
              startIcon={<SyncOutlined sx={{ fontSize: 16 }} />}
              onClick={syncNow}
              disabled={disabled}
              sx={{ alignSelf: "flex-start", ml: -1, height: 30 }}
            >
              {t("Sync now")}
            </Button>
          </DemoLock>
        )}
      </Box>
    );
  }

  const control = (
    <Tooltip title={demo ? t(DEMO_REASON.gmail) : t("Sync now")}>
      <span>
        <IconButton
          aria-label={t("Sync now")}
          color="primary"
          onClick={syncNow}
          disabled={disabled || demo}
          sx={{ width: 44, height: 44 }}
        >
          <SyncOutlined sx={{ fontSize: 20 }} />
        </IconButton>
      </span>
    </Tooltip>
  );

  if (layout === "rail") {
    return (
      <Box sx={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 0.5 }}>
        <Tooltip title={summary.text} placement="right" describeChild>
          <Box role="status" aria-live="polite" sx={{ position: "relative", p: 1 }}>
            <Dot tone={summary.tone} />
            <Box component="span" sx={visuallyHidden}>
              {summary.text}
            </Box>
          </Box>
        </Tooltip>
        {status.data?.connection === "not_connected" ? null : control}
      </Box>
    );
  }

  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0 }}>
      <Box
        role="status"
        aria-live="polite"
        sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0 }}
      >
        <Dot tone={summary.tone} />
        <Typography variant="caption" color="text.secondary" noWrap>
          {summary.text}
        </Typography>
      </Box>
      {status.data?.connection === "not_connected" ? null : control}
    </Box>
  );
}
