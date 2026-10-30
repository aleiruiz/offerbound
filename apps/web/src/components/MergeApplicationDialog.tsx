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
import { t } from "../i18n";

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

  // Without a search the picker offers the most recently active applications.
  const search = useApplications({ status: [], followUpDue: false, q, sort: "last_activity" });
  const candidates = useMemo(
    () => (search.data?.pages.flatMap((p) => p.items) ?? []).filter((a) => a.id !== source.id),
    [search.data, source.id],
  );

  const merge = useMergeApplication({
    onSuccess: (target) => {
      snackbar.show(t("Merged into {company}", { company: target.company.name }));
      onMerged(target);
      onClose();
    },
  });

  return (
    <>
      <DialogTitle id={TITLE_ID}>{t("Merge into another application")}</DialogTitle>
      <DialogContent
        sx={{ display: "flex", flexDirection: "column", gap: 2, pt: "8px !important" }}
      >
        <Typography variant="body2" color="text.secondary">
          {t(
            "Emails, interviews and timeline entries of {company} move to the application you pick, and {company} is deleted from the list.",
            { company: source.company.name },
          )}
        </Typography>
        <TextField
          label={t("Find an application")}
          type="search"
          placeholder={t("Company or role")}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setIntoId("");
          }}
          autoFocus
          fullWidth
        />
        {search.isError ? (
          <ErrorState
            what={t("applications")}
            error={search.error}
            onRetry={() => void search.refetch()}
          />
        ) : search.isPending ? (
          <Typography variant="body2" color="text.secondary" role="status">
            {t("Searching")}
          </Typography>
        ) : candidates.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            {t("No other application matches.")}
          </Typography>
        ) : (
          <RadioGroup
            aria-label={t("Application to merge into")}
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
            {`${t("Couldn't merge the applications.")} ${merge.error instanceof ApiClientError ? t(merge.error.message) : t("Check your connection and try again.")}`}
          </Alert>
        ) : null}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={merge.isPending}>
          {t("Cancel")}
        </Button>
        <Button
          variant="contained"
          disabled={intoId === "" || merge.isPending}
          onClick={() => merge.mutate({ id: source.id, intoId })}
        >
          {t("Merge")}
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
