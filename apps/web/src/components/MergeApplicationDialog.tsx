import type { ApplicationSummary } from "@offerbound/contracts";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import Radio from "@mui/material/Radio";
import RadioGroup from "@mui/material/RadioGroup";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useEffect, useMemo, useState } from "react";
import { ApiClientError } from "../api/client";
import { useApplications, useMergeApplication } from "../api/hooks";
import { ErrorState } from "./States";
import { STATUS_LABEL } from "./StatusChip";
import { useUndoSnackbar } from "./UndoSnackbar";

const TITLE_ID = "merge-application-title";
const SEARCH_DEBOUNCE_MS = 300;

function Form({
  source,
  onClose,
  onMerged,
}: {
  source: Pick<ApplicationSummary, "id" | "company" | "title">;
  onClose: () => void;
  onMerged: (target: ApplicationSummary) => void;
}) {
  const snackbar = useUndoSnackbar();
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [intoId, setIntoId] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const search = useApplications(
    { status: [], followUpDue: false, q, sort: "last_activity" },
    { enabled: q !== "" },
  );
  const candidates = useMemo(
    () => (search.data?.pages.flatMap((p) => p.items) ?? []).filter((a) => a.id !== source.id),
    [search.data, source.id],
  );

  const merge = useMergeApplication({
    onSuccess: (target) => {
      snackbar.show(`Merged into ${target.company.name}`);
      onMerged(target);
      onClose();
    },
  });

  return (
    <>
      <DialogTitle id={TITLE_ID}>Merge into another application</DialogTitle>
      <DialogContent
        sx={{ display: "flex", flexDirection: "column", gap: 2, pt: "8px !important" }}
      >
        <Typography variant="body2" color="text.secondary">
          {`Emails, interviews and timeline entries of ${source.company.name} move to the application you pick, and ${source.company.name} is deleted from the list.`}
        </Typography>
        <TextField
          label="Find an application"
          type="search"
          placeholder="Company or role"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setIntoId("");
          }}
          autoFocus
          fullWidth
        />
        {q === "" ? null : search.isError ? (
          <ErrorState
            what="applications"
            error={search.error}
            onRetry={() => void search.refetch()}
          />
        ) : search.isPending ? (
          <Typography variant="body2" color="text.secondary" role="status">
            Searching
          </Typography>
        ) : candidates.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No other application matches.
          </Typography>
        ) : (
          <RadioGroup
            aria-label="Application to merge into"
            value={intoId}
            onChange={(e) => setIntoId(e.target.value)}
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
                sx={{ alignItems: "flex-start", py: 0.5 }}
              />
            ))}
          </RadioGroup>
        )}
        {merge.isError ? (
          <Alert severity="error">
            {`Couldn't merge the applications. ${merge.error instanceof ApiClientError ? merge.error.message : "Check your connection and try again."}`}
          </Alert>
        ) : null}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={merge.isPending}>
          Cancel
        </Button>
        <Button
          variant="contained"
          disabled={intoId === "" || merge.isPending}
          onClick={() => merge.mutate({ id: source.id, intoId })}
        >
          Merge
        </Button>
      </DialogActions>
    </>
  );
}

/** *Merge into…* (AC-6.5): pick the application that takes this one's emails, interviews and timeline. */
export function MergeApplicationDialog({
  open,
  source,
  onClose,
  onMerged,
}: {
  open: boolean;
  source: Pick<ApplicationSummary, "id" | "company" | "title">;
  onClose: () => void;
  onMerged: (target: ApplicationSummary) => void;
}) {
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
      <Form source={source} onClose={onClose} onMerged={onMerged} />
    </Dialog>
  );
}
