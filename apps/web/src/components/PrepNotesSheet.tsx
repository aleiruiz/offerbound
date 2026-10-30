import type { InterviewWithApplication } from "@offerbound/contracts";
import CloseOutlined from "@mui/icons-material/CloseOutlined";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useState } from "react";
import { isConflict, useUpdateInterview } from "../api/hooks";
import { DEFAULT_TIMEZONE, formatDate, formatTime } from "../lib/format";
import { INTERVIEW_KIND } from "./InterviewRow";
import { useUndoSnackbar } from "./UndoSnackbar";

const TITLE_ID = "prep-notes-title";

const CHANGED_ELSEWHERE =
  "Changes were made elsewhere. The interview has been refreshed. Check your notes and save again.";

function whenOf(interview: InterviewWithApplication, timezone: string): string {
  return interview.startsAt
    ? `${formatDate(interview.startsAt, timezone)}, ${formatTime(interview.startsAt, timezone)}`
    : "No time yet";
}

function Form({
  interview,
  timezone,
  onClose,
}: {
  /** The interview as the list holds it now, so a refetch brings the fresh `version`. */
  interview: InterviewWithApplication;
  timezone: string;
  onClose: () => void;
}) {
  const snackbar = useUndoSnackbar();
  const [text, setText] = useState(interview.notes ?? "");
  const [conflict, setConflict] = useState(false);

  const update = useUpdateInterview({
    onSuccess: () => {
      snackbar.show("Saved prep notes");
      onClose();
    },
    onError: (error) => setConflict(isConflict(error)),
  });

  const unchanged = text === (interview.notes ?? "");
  const save = () => {
    setConflict(false);
    update.mutate({ interview, patch: { notes: text.trim() === "" ? null : text } });
  };
  const { application } = interview;

  return (
    <Box
      component="form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!unchanged && !update.isPending) save();
      }}
      sx={{ p: 2.5, display: "flex", flexDirection: "column", gap: 2 }}
    >
      <Box
        sx={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 1 }}
      >
        <Box>
          <Typography id={TITLE_ID} variant="h6" component="h2">
            Prep notes
          </Typography>
          <Typography variant="caption" color="text.secondary" component="p">
            {`${application.company.name}, ${application.title}. ${INTERVIEW_KIND[interview.kind]}, ${whenOf(interview, timezone)}.`}
          </Typography>
        </Box>
        <IconButton aria-label="Close" onClick={onClose} edge="end">
          <CloseOutlined fontSize="small" />
        </IconButton>
      </Box>

      {conflict ? <Alert severity="warning">{CHANGED_ELSEWHERE}</Alert> : null}
      {update.isError && !conflict ? (
        <Alert severity="error">Couldn't save your notes. Try again.</Alert>
      ) : null}

      <TextField
        label="Prep notes"
        value={text}
        onChange={(e) => setText(e.target.value)}
        multiline
        minRows={8}
        fullWidth
        autoFocus
      />

      <Box sx={{ display: "flex", justifyContent: "flex-end", gap: 1 }}>
        <Button onClick={onClose} disabled={update.isPending}>
          Cancel
        </Button>
        <Button type="submit" variant="contained" disabled={unchanged || update.isPending}>
          Save notes
        </Button>
      </Box>
    </Box>
  );
}

/**
 * A side sheet (bottom sheet on phones) with one interview's prep notes (DESIGN_SPEC §5.6, AC-8.5).
 * Nothing is saved until *Save notes*; closing the sheet drops what was typed.
 */
export function PrepNotesSheet({
  interview,
  onClose,
  timezone = DEFAULT_TIMEZONE,
}: {
  /** The interview to edit; `null` keeps the sheet closed. */
  interview: InterviewWithApplication | null;
  onClose: () => void;
  timezone?: string;
}) {
  const theme = useTheme();
  const phone = useMediaQuery(theme.breakpoints.down("sm"), { noSsr: true });
  return (
    <Drawer
      anchor={phone ? "bottom" : "right"}
      open={interview !== null}
      onClose={onClose}
      slotProps={{
        paper: {
          role: "dialog",
          "aria-modal": true,
          "aria-labelledby": TITLE_ID,
          sx: {
            width: phone ? "auto" : "min(560px, 100vw)",
            maxHeight: phone ? "90vh" : "none",
            borderTopLeftRadius: phone ? 12 : 0,
            borderTopRightRadius: phone ? 12 : 0,
          },
        },
      }}
    >
      {interview ? (
        <Form key={interview.id} interview={interview} timezone={timezone} onClose={onClose} />
      ) : null}
    </Drawer>
  );
}
