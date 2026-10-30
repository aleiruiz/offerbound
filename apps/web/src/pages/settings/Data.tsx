import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useState } from "react";
import { ApiClientError } from "../../api/client";
import { usePurgeEmailContent } from "../../api/hooks";
import { formatCount } from "../../lib/format";
import { SectionPaper } from "./shared";

/**
 * Settings, Data (AC-15.2): *Delete stored email content* behind a typed confirmation. The button
 * stays disabled until the field holds exactly `DELETE`. Records and timelines are not touched.
 */

const CONFIRM_WORD = "DELETE";

function resultText(count: number): string {
  if (count === 0) return "There was no stored email content to delete.";
  return `Deleted the stored content of ${formatCount(count)} ${count === 1 ? "email" : "emails"}.`;
}

export function Data() {
  const purge = usePurgeEmailContent();
  const [typed, setTyped] = useState("");

  const confirmed = typed === CONFIRM_WORD;

  const submit = () => {
    if (!confirmed) return;
    purge.mutate(undefined, { onSuccess: () => setTyped("") });
  };

  return (
    <SectionPaper id="data-heading" title="Data">
      <Typography>
        Offerbound keeps the text of the emails it reads, so you can check where a change came from.
        Your applications, leads, interviews and their timelines are separate records and stay as
        they are.
      </Typography>

      <Box
        component="form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        sx={{ display: "flex", flexDirection: "column", gap: 1.5, maxWidth: 560 }}
      >
        <Typography variant="subtitle2" component="h3">
          Delete stored email content
        </Typography>
        <Typography variant="body2" color="text.secondary">
          This clears the subject, sender, recipients, preview and body of every stored email.
          Timeline entries stay, but the email behind them no longer shows its text. Email that
          Offerbound reads later is stored as usual. This can't be undone.
        </Typography>
        <TextField
          label="Type DELETE to confirm"
          value={typed}
          onChange={(event) => {
            setTyped(event.target.value);
            // An earlier result or error is about the last request, not this confirmation.
            if (!purge.isPending) purge.reset();
          }}
          disabled={purge.isPending}
          autoComplete="off"
          slotProps={{ htmlInput: { spellCheck: false, autoCapitalize: "off" } }}
        />
        <Box>
          <Button
            type="submit"
            color="error"
            variant="contained"
            disabled={!confirmed || purge.isPending}
          >
            Delete stored email content
          </Button>
        </Box>
        {purge.isError ? (
          <Alert severity="error" role="alert">
            {`Couldn't delete the stored email content. ${
              purge.error instanceof ApiClientError
                ? purge.error.message
                : "Check your connection and try again."
            }`}
          </Alert>
        ) : null}
        <Box role="status" aria-live="polite">
          {purge.isSuccess ? (
            <Alert severity="success">{resultText(purge.data.messagesPurged)}</Alert>
          ) : null}
        </Box>
      </Box>
    </SectionPaper>
  );
}
