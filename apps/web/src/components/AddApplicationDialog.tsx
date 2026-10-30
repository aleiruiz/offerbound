import {
  ApplicationCreateSchema,
  ApplicationStatusSchema,
  type ApplicationCreate,
  type ApplicationStatus,
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
import { useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useState, type FormEvent } from "react";
import { ApiClientError } from "../api/client";
import { useCreateApplication, useTimezone } from "../api/hooks";
import { localDayKey, localMidnightIso } from "../lib/format";
import { CoreFields, REQUIRED_COMPANY, REQUIRED_ROLE, jobLinkError } from "./ApplicationFields";
import { STATUS_LABEL } from "./StatusChip";
import { useUndoSnackbar } from "./UndoSnackbar";

type Field = "companyName" | "title" | "jobUrl" | "status" | "appliedAt" | "notes";
type FieldErrors = Partial<Record<Field, string>>;

const TITLE_ID = "add-application-title";

function Form({ onClose }: { onClose: () => void }) {
  const timezone = useTimezone();
  const snackbar = useUndoSnackbar();
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [jobUrl, setJobUrl] = useState("");
  const [status, setStatus] = useState<ApplicationStatus>("applied");
  const [appliedDay, setAppliedDay] = useState(() => localDayKey(new Date(), timezone));
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});

  const create = useCreateApplication({
    onSuccess: (detail) => {
      snackbar.show(`Added ${detail.company.name}`);
      onClose();
    },
    onError: (error) => {
      if (error instanceof ApiClientError && Object.keys(error.fields).length > 0) {
        setErrors(error.fields);
      }
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next: FieldErrors = {};
    const companyName = company.trim();
    const title = role.trim();
    const link = jobUrl.trim();
    if (companyName === "") next.companyName = REQUIRED_COMPANY;
    if (title === "") next.title = REQUIRED_ROLE;
    const linkError = jobLinkError(link);
    if (linkError) next.jobUrl = linkError;
    const appliedAt = appliedDay === "" ? null : localMidnightIso(appliedDay, timezone);
    if (appliedDay !== "" && appliedAt === null) next.appliedAt = "Enter a valid date";
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    const body: ApplicationCreate = {
      companyName,
      title,
      jobUrl: link === "" ? null : link,
      status,
      appliedAt,
      notes: notes.trim() === "" ? null : notes,
    };
    const parsed = ApplicationCreateSchema.safeParse(body);
    if (!parsed.success) {
      setErrors({ companyName: "Check the details and try again" });
      return;
    }
    create.mutate(parsed.data);
  };

  return (
    <Box component="form" noValidate onSubmit={submit} sx={{ display: "contents" }}>
      <DialogTitle id={TITLE_ID}>Add application</DialogTitle>
      <DialogContent
        sx={{ display: "flex", flexDirection: "column", gap: 2, pt: "8px !important" }}
      >
        {create.isError &&
        !(create.error instanceof ApiClientError && create.error.code === "validation_failed") ? (
          <Alert severity="error">
            {`Couldn't add the application. ${create.error instanceof ApiClientError ? create.error.message : "Check your connection and try again."}`}
          </Alert>
        ) : null}
        <CoreFields
          values={{ company, role, jobUrl }}
          errors={errors}
          onChange={(c) => {
            if (c.company !== undefined) setCompany(c.company);
            if (c.role !== undefined) setRole(c.role);
            if (c.jobUrl !== undefined) setJobUrl(c.jobUrl);
          }}
          autoFocus
        />
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 2 }}>
          <TextField
            select
            label="Status"
            value={status}
            onChange={(e) => setStatus(ApplicationStatusSchema.parse(e.target.value))}
            error={Boolean(errors.status)}
            helperText={errors.status}
            sx={{ flex: "1 1 180px" }}
          >
            {ApplicationStatusSchema.options.map((s) => (
              <MenuItem key={s} value={s}>
                {STATUS_LABEL[s]}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            label="Applied date"
            type="date"
            value={appliedDay}
            onChange={(e) => setAppliedDay(e.target.value)}
            error={Boolean(errors.appliedAt)}
            helperText={errors.appliedAt}
            slotProps={{ inputLabel: { shrink: true } }}
            sx={{ flex: "1 1 180px" }}
          />
        </Box>
        <TextField
          label="Notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          error={Boolean(errors.notes)}
          helperText={errors.notes}
          multiline
          minRows={3}
          fullWidth
        />
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={create.isPending}>
          Cancel
        </Button>
        <Button type="submit" variant="contained" disabled={create.isPending}>
          Add application
        </Button>
      </DialogActions>
    </Box>
  );
}

/** *Add application* (AC-6.3): company, role, job link, status, applied date and notes. */
export function AddApplicationDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const theme = useTheme();
  const phone = useMediaQuery(theme.breakpoints.down("sm"), { noSsr: true });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullScreen={phone}
      fullWidth
      maxWidth="sm"
      aria-labelledby={TITLE_ID}
    >
      <Form onClose={onClose} />
    </Dialog>
  );
}
