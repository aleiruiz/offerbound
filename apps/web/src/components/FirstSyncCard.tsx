import Box from "@mui/material/Box";
import LinearProgress from "@mui/material/LinearProgress";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import { formatCount } from "../lib/format";
import { t } from "../i18n";

/**
 * The first-sync progress card (DESIGN_SPEC §7, States board): shown on Today, and in Settings,
 * Gmail, while the first read of the mailbox runs.
 */
export function FirstSyncCard({ listed, processed }: { listed: number; processed: number }) {
  const percent = listed > 0 ? Math.min(100, Math.round((processed / listed) * 100)) : 0;
  return (
    <Paper
      variant="outlined"
      role="status"
      aria-live="polite"
      sx={{ p: 2.25, display: "flex", flexDirection: "column", gap: 1.25 }}
    >
      <Typography sx={{ fontWeight: 600 }}>{t("Reading your email")}</Typography>
      {listed > 0 ? (
        <LinearProgress
          variant="determinate"
          value={percent}
          aria-label={t("First sync")}
          sx={{ height: 6, borderRadius: "3px" }}
        />
      ) : (
        <LinearProgress aria-label={t("First sync")} sx={{ height: 6, borderRadius: "3px" }} />
      )}
      <Box component="p" sx={{ m: 0 }}>
        <Typography variant="caption" color="text.secondary">
          {listed > 0
            ? t("{processed} of {listed} checked.", {
                processed: formatCount(processed),
                listed: formatCount(listed),
              })
            : t("Finding your email.")}{" "}
          {t("Applications update as emails are read; follow-up timers start when this finishes.")}
        </Typography>
      </Box>
    </Paper>
  );
}
