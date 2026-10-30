import {
  InterviewCreateSchema,
  InterviewKindSchema,
  type ApplicationSummary,
  type InterviewCreate,
  type InterviewKind,
} from "@offerbound/contracts";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControl from "@mui/material/FormControl";
import FormControlLabel from "@mui/material/FormControlLabel";
import FormHelperText from "@mui/material/FormHelperText";
import FormLabel from "@mui/material/FormLabel";
import MenuItem from "@mui/material/MenuItem";
import Radio from "@mui/material/Radio";
import RadioGroup from "@mui/material/RadioGroup";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ApiClientError } from "../api/client";
import { useApplications, useCreateInterview, useTimezone } from "../api/hooks";
import { localTimeIso } from "../lib/format";
import { BAD_LINK, jobLinkError } from "./ApplicationFields";
import { INTERVIEW_KIND } from "./InterviewRow";
import { ErrorState } from "./States";
import { STATUS_LABEL } from "./StatusChip";
import { useUndoSnackbar } from "./UndoSnackbar";

const TITLE_ID = "add-interview-title";
const SEARCH_DEBOUNCE_MS = 300;

type Field =
  | "application"
  | "kind"
  | "date"
  | "startTime"
  | "endTime"
  | "interviewers"
  | "meetingUrl"
  | "location"
  | "notes";
type FieldErrors = Partial<Record<Field, string>>;

const PICK_APPLICATION = "Pick the application this interview is for";

/**
 * The API names fields as the request body does; the dialog names them as it shows them. A server
 * field with no place in the dialog (`status`, say) maps to nothing, and the alert says it instead.
 */
const SERVER_FIELD: Record<string, Field> = {
  applicationId: "application",
  kind: "kind",
  startsAt: "startTime",
  endsAt: "endTime",
  interviewers: "interviewers",
  meetingUrl: "meetingUrl",
  location: "location",
  notes: "notes",
};

function dialogErrors(fields: Record<string, string>): FieldErrors {
  const mapped: FieldErrors = {};
  for (const [name, message] of Object.entries(fields)) {
    const field = SERVER_FIELD[name];
    if (field !== undefined) mapped[field] = message;
  }
  return mapped;
}

/** "Priya Natarajan,  Tom Salas, " becomes two names. */
function names(text: string): string[] {
  return text
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n !== "");
}

function Form({
  onClose,
  onPending,
}: {
  onClose: () => void;
  /** Tells the dialog whether the interview is being sent, so it cannot be dismissed meanwhile. */
  onPending: (pending: boolean) => void;
}) {
  const timezone = useTimezone();
  const snackbar = useUndoSnackbar();
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [application, setApplication] = useState<ApplicationSummary | null>(null);
  const [kind, setKind] = useState<InterviewKind>("other");
  const [date, setDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [interviewers, setInterviewers] = useState("");
  const [meetingUrl, setMeetingUrl] = useState("");
  const [location, setLocation] = useState("");
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  /** The server's answer put a message under at least one field. */
  const [fieldsShown, setFieldsShown] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  // With nothing typed the picker lists the applications with the latest activity.
  const applications = useApplications({
    status: [],
    followUpDue: false,
    q,
    sort: "last_activity",
  });
  const candidates = useMemo(
    () => applications.data?.pages.flatMap((p) => p.items) ?? [],
    [applications.data],
  );

  const create = useCreateInterview({
    onSuccess: (_interview, { applicationId }) => {
      const name = application?.id === applicationId ? application.company.name : null;
      snackbar.show(name ? `Added interview for ${name}` : "Added interview");
      onClose();
    },
    onError: (error) => {
      const mapped = error instanceof ApiClientError ? dialogErrors(error.fields) : {};
      setErrors(mapped);
      setFieldsShown(Object.keys(mapped).length > 0);
    },
  });
  const { isPending } = create;
  useEffect(() => {
    onPending(isPending);
    return () => onPending(false);
  }, [isPending, onPending]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setFieldsShown(false);
    const next: FieldErrors = {};
    if (application === null) next.application = PICK_APPLICATION;

    // Times are typed in the owner's zone; a date with no start time, or the reverse, is unfinished.
    const link = meetingUrl.trim();
    const linkError = jobLinkError(link);
    if (linkError) next.meetingUrl = BAD_LINK;
    let startsAt: string | null = null;
    let endsAt: string | null = null;
    if (date === "" && startTime === "" && endTime === "") {
      // no time yet: the interview is waiting to be scheduled
    } else if (startTime === "") {
      next.startTime = "Enter the start time";
    } else if (date === "") {
      next.date = "Pick the date";
    } else {
      startsAt = localTimeIso(date, startTime, timezone);
      if (startsAt === null) next.date = "Enter a valid date";
      if (endTime !== "") {
        endsAt = localTimeIso(date, endTime, timezone);
        if (endsAt === null) next.endTime = "Enter a valid time";
        else if (startsAt !== null && Date.parse(endsAt) <= Date.parse(startsAt)) {
          next.endTime = "The end must be after the start";
        }
      }
    }
    setErrors(next);
    if (Object.keys(next).length > 0 || application === null) return;

    const body: InterviewCreate = {
      kind,
      status: startsAt === null ? "to_schedule" : "scheduled",
      startsAt,
      endsAt,
      meetingUrl: link === "" ? null : link,
      location: location.trim() === "" ? null : location.trim(),
      interviewers: names(interviewers),
      notes: notes.trim() === "" ? null : notes,
    };
    const parsed = InterviewCreateSchema.safeParse(body);
    if (!parsed.success) {
      setErrors({ application: "Check the details and try again" });
      return;
    }
    create.mutate({ applicationId: application.id, body: parsed.data });
  };

  return (
    <Box component="form" noValidate onSubmit={submit} sx={{ display: "contents" }}>
      <DialogTitle id={TITLE_ID}>Add interview</DialogTitle>
      <DialogContent
        sx={{ display: "flex", flexDirection: "column", gap: 2, pt: "8px !important" }}
      >
        {create.isError && !fieldsShown ? (
          <Alert severity="error">
            {`Couldn't add the interview. ${create.error instanceof ApiClientError ? create.error.message : "Check your connection and try again."}`}
          </Alert>
        ) : null}

        <FormControl component="fieldset" error={Boolean(errors.application)} sx={{ gap: 1 }}>
          <FormLabel component="legend" sx={{ fontSize: 13, fontWeight: 600 }}>
            Which application is it for?
          </FormLabel>
          <TextField
            label="Find an application"
            type="search"
            placeholder="Company or role"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            fullWidth
          />
          {applications.isError ? (
            <ErrorState
              what="applications"
              error={applications.error}
              onRetry={() => void applications.refetch()}
            />
          ) : applications.isPending ? (
            <Typography variant="body2" color="text.secondary" role="status">
              Loading applications
            </Typography>
          ) : candidates.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              {q === "" ? "No applications yet. Add one first." : "No application matches."}
            </Typography>
          ) : (
            <RadioGroup
              aria-label="Application"
              value={application?.id ?? ""}
              onChange={(e) => {
                setApplication(candidates.find((a) => a.id === e.target.value) ?? null);
                setErrors((prev) => ({ ...prev, application: undefined }));
              }}
              sx={{ maxHeight: 240, flexWrap: "nowrap", overflowY: "auto" }}
            >
              {candidates.map((a) => (
                <FormControlLabel
                  key={a.id}
                  value={a.id}
                  control={<Radio />}
                  label={
                    <Box>
                      <Typography sx={{ fontWeight: 600 }}>{a.company.name}</Typography>
                      <Typography variant="caption" color="text.secondary" component="p">
                        {`${a.title}, ${STATUS_LABEL[a.status]}`}
                      </Typography>
                    </Box>
                  }
                  sx={{ alignItems: "flex-start", minHeight: 44, py: 0.5, m: 0 }}
                />
              ))}
            </RadioGroup>
          )}
          {errors.application ? <FormHelperText>{errors.application}</FormHelperText> : null}
        </FormControl>

        <TextField
          select
          label="Kind of interview"
          value={kind}
          onChange={(e) => setKind(InterviewKindSchema.parse(e.target.value))}
          error={Boolean(errors.kind)}
          helperText={errors.kind}
          fullWidth
        >
          {InterviewKindSchema.options.map((k) => (
            <MenuItem key={k} value={k}>
              {INTERVIEW_KIND[k]}
            </MenuItem>
          ))}
        </TextField>

        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 2 }}>
          <TextField
            label="Date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            error={Boolean(errors.date)}
            helperText={errors.date}
            slotProps={{ inputLabel: { shrink: true } }}
            sx={{ flex: "1 1 160px" }}
          />
          <TextField
            label="Start time"
            type="time"
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
            error={Boolean(errors.startTime)}
            helperText={errors.startTime}
            slotProps={{ inputLabel: { shrink: true } }}
            sx={{ flex: "1 1 120px" }}
          />
          <TextField
            label="End time"
            type="time"
            value={endTime}
            onChange={(e) => setEndTime(e.target.value)}
            error={Boolean(errors.endTime)}
            helperText={errors.endTime}
            slotProps={{ inputLabel: { shrink: true } }}
            sx={{ flex: "1 1 120px" }}
          />
        </Box>
        <Typography variant="caption" color="text.secondary" sx={{ mt: -1 }}>
          Leave the date and times empty if you haven't picked a time yet.
        </Typography>

        <TextField
          label="Interviewers"
          value={interviewers}
          onChange={(e) => setInterviewers(e.target.value)}
          error={Boolean(errors.interviewers)}
          helperText={errors.interviewers ?? "Separate names with commas"}
          fullWidth
        />
        <TextField
          label="Call link"
          type="url"
          value={meetingUrl}
          onChange={(e) => setMeetingUrl(e.target.value)}
          error={Boolean(errors.meetingUrl)}
          helperText={errors.meetingUrl}
          fullWidth
        />
        <TextField
          label="Location"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          error={Boolean(errors.location)}
          helperText={errors.location}
          fullWidth
        />
        <TextField
          label="Prep notes"
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
          Add interview
        </Button>
      </DialogActions>
    </Box>
  );
}

/** *Add interview* (AC-8.5): the application, the kind, when, who, the call link and prep notes. */
export function AddInterviewDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const theme = useTheme();
  const phone = useMediaQuery(theme.breakpoints.down("sm"), { noSsr: true });
  const [pending, setPending] = useState(false);
  return (
    <Dialog
      open={open}
      // Esc and a click outside wait while the interview is being sent, as Cancel does.
      onClose={pending ? undefined : onClose}
      fullScreen={phone}
      fullWidth
      maxWidth="sm"
      aria-labelledby={TITLE_ID}
    >
      <Form onClose={onClose} onPending={setPending} />
    </Dialog>
  );
}
