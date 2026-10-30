import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import { useSyncStatus } from "../api/hooks";
import { GOOGLE_START_PATH } from "../api/paths";

/**
 * The warning under the top bar on every page when Google stopped Offerbound's access
 * (`needs_reauth`) or the Gmail permission is missing (`missing_scope`): AC-2.6, DESIGN_SPEC §7.
 * Reconnecting is a full page load, because the server answers with a redirect to Google.
 */
export function ReconnectBanner() {
  const status = useSyncStatus();
  const connection = status.data?.connection;
  if (connection !== "needs_reauth" && connection !== "missing_scope") return null;

  const reason =
    connection === "missing_scope"
      ? "Offerbound doesn't have permission to read your email, so new email isn't being read."
      : "Google stopped Offerbound's access, so new email isn't being read.";

  return (
    <Alert
      severity="warning"
      role="alert"
      sx={{ mb: 2, alignItems: "center", "& .MuiAlert-message": { flex: 1 } }}
      action={
        <Button
          component="a"
          href={GOOGLE_START_PATH}
          variant="outlined"
          color="warning"
          size="small"
        >
          Reconnect Gmail
        </Button>
      }
    >
      <Typography variant="body2" component="p">
        <Typography component="span" variant="body2" sx={{ fontWeight: 700 }}>
          Gmail needs reconnecting.
        </Typography>{" "}
        {reason} Your records are safe.
      </Typography>
    </Alert>
  );
}
