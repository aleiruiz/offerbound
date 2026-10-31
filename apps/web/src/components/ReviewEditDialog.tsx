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
import { isConflict, useResolveReviewItem } from "../api/hooks";
import { isHttpUrl } from "../lib/url";
import { useUndoSnackbar } from "./UndoSnackbar";
import { msg, t } from "../i18n";

const TITLE_ID = "review-edit-title";

/** What each kind of email is called to the owner. */
const CATEGORIES: { value: EmailCategory; label: string }[] = [
  {
    value: "application_confirmation",
    get label() {
      return t("Application received");
    },
  },
  {
    value: "rejection",
    get label() {
      return t("Rejection");
    },
  },
  {
    value: "interview_invite",
    get label() {
      return t("Interview invitation");
    },
  },
  {
    value: "interview_reschedule",
    get label() {
      return t("Interview rescheduled");
    },
  },
  {
    value: "interview_cancellation",
    get label() {
      return t("Interview cancelled");
    },
  },
  {
    value: "assessment",
    get label() {
      return t("Assessment request");
    },
  },
  {
    value: "offer",
    get label() {
      return t("Offer");
    },
  },
  {
    value: "recruiter_outreach",
    get label() {
      return t("Recruiter message");
    },
  },
  {
    value: "job_alert",
    get label() {
      return t("Job alert");
    },
  },
  {
    value: "status_update_other",
    get label() {
      return t("Other update on an application");
    },
  },
  {
    value: "candidate_outbound",
    get label() {
      return t("Email you sent");
    },
  },
  {
    value: "not_job_related",
    get label() {
      return t("Not about a job");
    },
  },
];

const CHANGED_ELSEWHERE = msg("Changes were made elsewhere. Review has been refreshed.");

function Form({
  item,
  onClose,
  onResolved,
}: {
  item: Pick<ReviewItem, "id" | "kind">;
  onClose: () => void;
  onResolved: (id: string) => void;
}) {
  const snackbar = useUndoSnackbar();
  const [category, setCategory] = useState<EmailCategory | "">("");
  const [jobUrl, setJobUrl] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);

  const resolve = useResolveReviewItem({
    onSuccess: () => {
      snackbar.show(t("Applied your edits"));
      onClose();
      onResolved(item.id);
    },
    onError: (error) => {
      // Changed elsewhere (a 409 with any code): the lists were fetched again, so leave the dialog.
      if (isConflict(error)) {
        snackbar.show(t(CHANGED_ELSEWHERE));
        onClose();
      }
    },
  });

  const url = jobUrl.trim();
  const edited = category !== "" || url !== "";

  const submit = () => {
    if (url !== "" && !isHttpUrl(url)) {
      setUrlError(t("Enter a link that starts with http:// or https://"));
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
      <DialogTitle id={TITLE_ID}>{t("Edit and apply")}</DialogTitle>
      <DialogContent
        sx={{ display: "flex", flexDirection: "column", gap: 2, pt: "8px !important" }}
      >
        <Typography variant="body2" color="text.secondary">
          {t(
            "Change what Offerbound read from the email, then apply it. Leave a field empty to keep what was read.",
          )}
        </Typography>
        <TextField
          select
          label={t("What the email is")}
          value={category}
          onChange={(e) => setCategory(e.target.value as EmailCategory | "")}
          fullWidth
        >
          <MenuItem value="">{t("Keep what was read")}</MenuItem>
          {CATEGORIES.map((c) => (
            <MenuItem key={c.value} value={c.value}>
              {c.label}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          label={t("Job link")}
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
        {resolve.isError && !isConflict(resolve.error) ? (
          <Alert severity="error">
            {`${t("Couldn't save your choice.")} ${resolve.error instanceof ApiClientError ? t(resolve.error.message) : t("Check your connection and try again.")}`}
          </Alert>
        ) : null}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={resolve.isPending}>
          {t("Cancel")}
        </Button>
        <Button variant="contained" disabled={!edited || resolve.isPending} onClick={submit}>
          {t("Apply with edits")}
        </Button>
      </DialogActions>
    </>
  );
}

/** *Edit and apply* (AC-5.2) for an item the automation was not sure about. */
export function ReviewEditDialog({
  item,
  onClose,
  onResolved,
}: {
  /** The item being edited; `null` keeps the dialog closed. */
  item: Pick<ReviewItem, "id" | "kind"> | null;
  onClose: () => void;
  /** Called once the edited item has been applied. */
  onResolved: (id: string) => void;
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
      {item ? <Form item={item} onClose={onClose} onResolved={onResolved} /> : null}
    </Dialog>
  );
}
