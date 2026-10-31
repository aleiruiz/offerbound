import {
  ApplicationPatchSchema,
  WorkModeSchema,
  type ApplicationDetail,
  type ApplicationPatch,
  type WorkMode,
} from "@offerbound/contracts";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";
import { useState, type FormEvent } from "react";
import { ApiClientError } from "../api/client";
import { isApiError, useTimezone, useUpdateApplication } from "../api/hooks";
import { localDayKey, localMidnightIso } from "../lib/format";
import { usePhone } from "../lib/link-sx";
import {
  CoreFields,
  REQUIRED_COMPANY,
  REQUIRED_ROLE,
  jobLinkError,
  type CoreErrors,
} from "./ApplicationFields";
import { useUndoSnackbar } from "./UndoSnackbar";
import { t } from "../i18n";

const TITLE_ID = "edit-application-title";

const WORK_MODE_LABEL: Record<WorkMode, string> = {
  get remote() {
    return t("Remote");
  },
  get hybrid() {
    return t("Hybrid");
  },
  get onsite() {
    return t("On-site");
  },
  get unknown() {
    return t("Not set");
  },
};

type Errors = CoreErrors & Partial<Record<"appliedAt" | "country" | "locationText", string>>;

interface Values {
  company: string;
  role: string;
  jobUrl: string;
  locationText: string;
  workMode: WorkMode;
  country: string;
  compensationText: string;
  sponsorshipText: string;
  appliedDay: string;
}

function valuesOf(detail: ApplicationDetail, timezone: string): Values {
  return {
    company: detail.company.name,
    role: detail.title,
    jobUrl: detail.jobUrl ?? "",
    locationText: detail.locationText ?? "",
    workMode: detail.workMode,
    country: detail.country ?? "",
    compensationText: detail.compensationText ?? "",
    sponsorshipText: detail.sponsorshipText ?? "",
    appliedDay: detail.appliedAt ? localDayKey(detail.appliedAt, timezone) : "",
  };
}

const orNull = (text: string): string | null => (text.trim() === "" ? null : text.trim());

/** Only the fields the owner changed, so a field someone else changed meanwhile is left alone. */
function changes(
  before: Values,
  now: Values,
  timezone: string,
): { patch: Omit<ApplicationPatch, "version">; errors: Errors } {
  const patch: Omit<ApplicationPatch, "version"> = {};
  const errors: Errors = {};
  if (now.company.trim() !== before.company) {
    if (now.company.trim() === "") errors.companyName = t(REQUIRED_COMPANY);
    else patch.companyName = now.company.trim();
  }
  if (now.role.trim() !== before.role) {
    if (now.role.trim() === "") errors.title = t(REQUIRED_ROLE);
    else patch.title = now.role.trim();
  }
  if (now.jobUrl.trim() !== before.jobUrl) {
    const error = jobLinkError(now.jobUrl);
    if (error) errors.jobUrl = error;
    else patch.jobUrl = orNull(now.jobUrl);
  }
  if (now.locationText.trim() !== before.locationText)
    patch.locationText = orNull(now.locationText);
  if (now.workMode !== before.workMode) patch.workMode = now.workMode;
  if (now.country.trim() !== before.country) patch.country = orNull(now.country);
  if (now.compensationText.trim() !== before.compensationText) {
    patch.compensationText = orNull(now.compensationText);
  }
  if (now.sponsorshipText.trim() !== before.sponsorshipText) {
    patch.sponsorshipText = orNull(now.sponsorshipText);
  }
  if (now.appliedDay !== before.appliedDay) {
    const appliedAt = now.appliedDay === "" ? null : localMidnightIso(now.appliedDay, timezone);
    if (now.appliedDay !== "" && appliedAt === null) errors.appliedAt = t("Enter a valid date");
    else patch.appliedAt = appliedAt;
  }
  return { patch, errors };
}

function Form({ detail, onClose }: { detail: ApplicationDetail; onClose: () => void }) {
  const timezone = useTimezone();
  const snackbar = useUndoSnackbar();
  // What the form opened with; `detail` itself moves on if the record is fetched again.
  const [before] = useState(() => valuesOf(detail, timezone));
  const [values, setValues] = useState<Values>(before);
  const [errors, setErrors] = useState<Errors>({});
  const [conflict, setConflict] = useState(false);
  const set = (change: Partial<Values>) => setValues((v) => ({ ...v, ...change }));

  const update = useUpdateApplication({
    onSuccess: () => {
      snackbar.show(t("Saved changes"));
      onClose();
    },
    onError: (error) => {
      if (isApiError(error, "version_conflict")) {
        setConflict(true);
      } else if (error instanceof ApiClientError && Object.keys(error.fields).length > 0) {
        setConflict(false);
        setErrors(error.fields);
      }
    },
  });

  const { patch, errors: found } = changes(before, values, timezone);
  const dirty = Object.keys(patch).length > 0 || Object.keys(found).length > 0;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setErrors(found);
    if (Object.keys(found).length > 0 || Object.keys(patch).length === 0) return;
    const parsed = ApplicationPatchSchema.safeParse({ ...patch, version: detail.version });
    if (!parsed.success) {
      setErrors({ companyName: t("Check the details and try again") });
      return;
    }
    setConflict(false);
    update.mutate({ application: detail, patch });
  };

  return (
    <Box component="form" noValidate onSubmit={submit} sx={{ display: "contents" }}>
      <DialogTitle id={TITLE_ID}>{t("Edit details")}</DialogTitle>
      <DialogContent
        sx={{ display: "flex", flexDirection: "column", gap: 2, pt: "8px !important" }}
      >
        {conflict ? (
          <Alert severity="info">
            {t(
              "Changes were made elsewhere. The latest version is shown behind this window; check your changes and save again.",
            )}
          </Alert>
        ) : null}
        {update.isError &&
        !isApiError(update.error, "version_conflict") &&
        !isApiError(update.error, "validation_failed") ? (
          <Alert severity="error">
            {`${t("Couldn't save the changes.")} ${update.error instanceof ApiClientError ? t(update.error.message) : t("Check your connection and try again.")}`}
          </Alert>
        ) : null}
        <CoreFields
          values={{ company: values.company, role: values.role, jobUrl: values.jobUrl }}
          errors={errors}
          onChange={(c) =>
            set({
              ...(c.company !== undefined ? { company: c.company } : {}),
              ...(c.role !== undefined ? { role: c.role } : {}),
              ...(c.jobUrl !== undefined ? { jobUrl: c.jobUrl } : {}),
            })
          }
          autoFocus
        />
        <TextField
          label={t("Location")}
          value={values.locationText}
          onChange={(e) => set({ locationText: e.target.value })}
          fullWidth
        />
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 2 }}>
          <TextField
            select
            label={t("Work mode")}
            value={values.workMode}
            onChange={(e) => set({ workMode: WorkModeSchema.parse(e.target.value) })}
            sx={{ flex: "1 1 180px" }}
          >
            {WorkModeSchema.options.map((mode) => (
              <MenuItem key={mode} value={mode}>
                {WORK_MODE_LABEL[mode]}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            label={t("Country")}
            value={values.country}
            onChange={(e) => set({ country: e.target.value })}
            sx={{ flex: "1 1 180px" }}
          />
        </Box>
        <TextField
          label={t("Compensation")}
          value={values.compensationText}
          onChange={(e) => set({ compensationText: e.target.value })}
          fullWidth
        />
        <TextField
          label={t("Sponsorship")}
          value={values.sponsorshipText}
          onChange={(e) => set({ sponsorshipText: e.target.value })}
          fullWidth
        />
        <TextField
          label={t("Applied date")}
          type="date"
          value={values.appliedDay}
          onChange={(e) => set({ appliedDay: e.target.value })}
          error={Boolean(errors.appliedAt)}
          helperText={errors.appliedAt}
          slotProps={{ inputLabel: { shrink: true } }}
        />
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={update.isPending}>
          {t("Cancel")}
        </Button>
        <Button type="submit" variant="contained" disabled={!dirty || update.isPending}>
          {t("Save changes")}
        </Button>
      </DialogActions>
    </Box>
  );
}

/**
 * *Edit details* (AC-6.3): every `ApplicationPatch` field the page does not edit in place. Sends
 * only what changed, with the record's `version`; a `409 version_conflict` keeps the dialog open
 * with the typed values, the record fetched again, and the next save on the fresh version.
 */
export function EditApplicationDialog({
  open,
  detail,
  onClose,
}: {
  open: boolean;
  detail: ApplicationDetail;
  onClose: () => void;
}) {
  const phone = usePhone();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullScreen={phone}
      fullWidth
      maxWidth="sm"
      aria-labelledby={TITLE_ID}
    >
      <Form detail={detail} onClose={onClose} />
    </Dialog>
  );
}
