import type { EmailCategory, ReviewItem } from "@offerbound/contracts";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useState } from "react";
import { ApiClientError } from "../api/client";
import { isApiError, useResolveReviewItem } from "../api/hooks";
import { isHttpUrl } from "../lib/url";
import { useUndoSnackbar } from "./UndoSnackbar";

const TITLE_ID = "review-edit-title";

/** What each kind of email is called to the owner. */
const CATEGORIES: { value: EmailCategory; label: string }[] = [
  { value: "application_confirmation", label: "Application received" },
  { value: "rejection", label: "Rejection" },
  { value: "interview_invite", label: "Interview invitation" },
  { value: "interview_reschedule", label: "Interview rescheduled" },
  { value: "interview_cancellation", label: "Interview cancelled" },
  { value: "assessment", label: "Assessment request" },
  { value: "offer", label: "Offer" },
  { value: "recruiter_outreach", label: "Recruiter message" },
  { value: "job_alert", label: "Job alert" },
  { value: "status_update_other", label: "Other update on an application" },
  { value: "candidate_outbound", label: "Email you sent" },
  { value: "not_job_related", label: "Not about a job" },
];

const CHANGED_ELSEWHERE = "Changes were made elsewhere. Review has been refreshed.";

function Form({ item, onClose }: { item: Pick<ReviewItem, "id" | "kind">; onClose: () => void }) {
  const snackbar = useUndoSnackbar();
  const [category, setCategory] = useState<EmailCategory | "">("");
  const [jobUrl, setJobUrl] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);

  const resolve = useResolveReviewItem({
    onSuccess: () => {
      snackbar.show("Applied your edits");
      onClose();
    },
    onError: (error) => {
      if (isApiError(error, "version_conflict")) {
        snackbar.show(CHANGED_ELSEWHERE);
        onClose();
      }
    },
  });

  const url = jobUrl.trim();
  const edited = category !== "" || url !== "";

  const submit = () => {
    if (url !== "" && !isHttpUrl(url)) {
      setUrlError("Enter a link that starts with http:// or https://");
      return;
    }
    setUrlError(null);
    // Only what the owner changed is sent; everything else stays as it was read.
    resolve.mutate({
      item,
      resolve: {
        action: "edit_apply",
        edits: { ...(category !== "" ? { category } : {}), ...(url !== "" ? { jobUrl: url } : {}) },
      },
    });
  };

  return (
    <>
      <DialogTitle id={TITLE_ID}>Edit and apply</DialogTitle>
      <DialogContent
        sx={{ display: "flex", flexDirection: "column", gap: 2, pt: "8px !important" }}
      >
        <Typography variant="body2" color="text.secondary">
          Change what Offerbound read from the email, then apply it. Leave a field empty to keep
          what was read.
        </Typography>
        <TextField
          select
          label="What the email is"
          value={category}
          onChange={(e) => setCategory(e.target.value as EmailCategory | "")}
          fullWidth
        >
          <MenuItem value="">Keep what was read</MenuItem>
          {CATEGORIES.map((c) => (
            <MenuItem key={c.value} value={c.value}>
              {c.label}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          label="Job link"
          type="url"
          value={jobUrl}
          onChange={(e) => {
            setJobUrl(e.target.value);
            setUrlError(null);
          }}
          error={urlError !== null}
          helperText={urlError ?? undefined}
          fullWidth
        />
        {resolve.isError && !isApiError(resolve.error, "version_conflict") ? (
          <Alert severity="error">
            {`Couldn't save your choice. ${resolve.error instanceof ApiClientError ? resolve.error.message : "Check your connection and try again."}`}
          </Alert>
        ) : null}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={resolve.isPending}>
          Cancel
        </Button>
        <Button variant="contained" disabled={!edited || resolve.isPending} onClick={submit}>
          Apply with edits
        </Button>
      </DialogActions>
    </>
  );
}

/** *Edit and apply* (AC-5.2) for an item the automation was not sure about. */
export function ReviewEditDialog({
  item,
  onClose,
}: {
  /** The item being edited; `null` keeps the dialog closed. */
  item: Pick<ReviewItem, "id" | "kind"> | null;
  onClose: () => void;
}) {
  const theme = useTheme();
  const phone = useMediaQuery(theme.breakpoints.down("sm"), { noSsr: true });
  return (
    <Dialog
      open={item !== null}
      onClose={onClose}
      fullScreen={phone}
      fullWidth
      maxWidth="sm"
      aria-labelledby={TITLE_ID}
    >
      {item ? <Form item={item} onClose={onClose} /> : null}
    </Dialog>
  );
}
