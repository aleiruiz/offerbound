import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Paper from "@mui/material/Paper";
import Skeleton from "@mui/material/Skeleton";
import Typography from "@mui/material/Typography";
import type { ReactNode } from "react";
import { ApiClientError } from "../api/client";
import { t } from "../i18n";

/**
 * The empty, loading and error states of DESIGN_SPEC §7. Copy: say what happened and what to do,
 * never apologise, and name the next action in an empty state.
 */

export function EmptyState({
  title,
  body,
  actions,
}: {
  title: string;
  body?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <Paper variant="outlined" sx={{ p: 3, display: "flex", flexDirection: "column", gap: 1.5 }}>
      <Typography variant="h6" component="p">
        {title}
      </Typography>
      {body ? (
        <Typography variant="body2" color="text.secondary">
          {body}
        </Typography>
      ) : null}
      {actions ? <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1 }}>{actions}</Box> : null}
    </Paper>
  );
}

/** Skeleton rows shaped like a list of leads or applications: score block, two text lines. */
export function ListSkeleton({ label, rows = 5 }: { label: string; rows?: number }) {
  return (
    <Paper
      variant="outlined"
      role="status"
      aria-busy="true"
      aria-label={label}
      sx={{ overflow: "hidden" }}
    >
      {Array.from({ length: rows }, (_, i) => (
        <Box
          key={i}
          data-skeleton-row=""
          sx={{
            display: "flex",
            gap: 2,
            px: 2.25,
            py: 2,
            ...(i > 0 ? { borderTop: 1, borderColor: "divider" } : {}),
          }}
        >
          <Skeleton variant="rounded" width={40} height={36} animation="wave" />
          <Box sx={{ flex: 1, display: "flex", flexDirection: "column", gap: 1 }}>
            <Skeleton variant="rounded" width={`${52 + ((i * 13) % 30)}%`} height={14} />
            <Skeleton variant="rounded" width={`${70 + ((i * 7) % 20)}%`} height={12} />
          </Box>
        </Box>
      ))}
    </Paper>
  );
}

function reasonOf(error: unknown): string {
  if (error instanceof ApiClientError) return t(error.message);
  return t("Offerbound couldn't reach the server. Check your connection.");
}

/** An inline error where the data would be, with *Try again* when there is something to retry. */
export function ErrorState({
  what,
  error,
  onRetry,
}: {
  /** What failed to load, as a translated noun phrase: `t("leads")`, `t("the email")`. */
  what: string;
  error?: unknown;
  onRetry?: () => void;
}) {
  return (
    <Alert
      severity="error"
      action={
        onRetry ? (
          <Button color="error" variant="outlined" size="small" onClick={onRetry}>
            {t("Try again")}
          </Button>
        ) : undefined
      }
    >
      <Box component="span" sx={{ fontWeight: 700, color: "error.main" }}>
        {t("Couldn't load {what}.", { what })}
      </Box>{" "}
      {reasonOf(error)}
    </Alert>
  );
}
