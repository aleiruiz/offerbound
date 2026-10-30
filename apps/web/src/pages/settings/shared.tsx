import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Paper from "@mui/material/Paper";
import Skeleton from "@mui/material/Skeleton";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { Settings } from "@offerbound/contracts";
import { useState, type ReactNode } from "react";
import { ApiClientError } from "../../api/client";
import { useSaveSettings, useSettings } from "../../api/hooks";
import { ErrorState } from "../../components/States";

/** Pieces shared by the Settings sections: the paper, the loading gate, saving and number fields. */

/** One section's card: an `h2` and the content. The page's `h1` is "Settings". */
export function SectionPaper({
  id,
  title,
  caption,
  children,
}: {
  id: string;
  title: string;
  /** A line beside the heading. */
  caption?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Paper
      component="section"
      variant="outlined"
      aria-labelledby={id}
      sx={{ p: { xs: 2, sm: 3 }, display: "flex", flexDirection: "column", gap: 2.5 }}
    >
      <Box
        sx={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 1,
        }}
      >
        <Typography id={id} variant="h6" component="h2" sx={{ fontWeight: 700 }}>
          {title}
        </Typography>
        {caption ? (
          <Typography variant="caption" color="text.secondary" component="p">
            {caption}
          </Typography>
        ) : null}
      </Box>
      {children}
    </Paper>
  );
}

/** Waits for `GET /settings` (a skeleton, or the error with *Try again*), then renders the section. */
export function SettingsGate({ children }: { children: (settings: Settings) => ReactNode }) {
  const settings = useSettings();
  if (settings.isPending) {
    return (
      <Paper variant="outlined" aria-busy="true" sx={{ p: 3 }}>
        <Skeleton variant="text" width={160} height={32} />
        <Skeleton variant="rounded" height={140} sx={{ mt: 2 }} />
      </Paper>
    );
  }
  if (settings.isError) {
    return (
      <ErrorState
        what="your settings"
        error={settings.error}
        onRetry={() => void settings.refetch()}
      />
    );
  }
  return <>{children(settings.data)}</>;
}

/**
 * Saves the full settings (`PUT /settings`). `saved` is true while the draft is the one that was
 * saved, so it goes away on the next edit. A 400 puts its messages in `fields`, keyed by the path
 * in the body (`timers.abandonDays`), for the fields to show.
 */
export function useSettingsSave(draft: unknown) {
  const mutation = useSaveSettings();
  const [savedDraft, setSavedDraft] = useState<unknown>(undefined);

  const error = mutation.error;
  const fields: Record<string, string> =
    error instanceof ApiClientError && error.code === "validation_failed" ? error.fields : {};
  const invalid = Object.keys(fields).length > 0;

  return {
    saved: savedDraft === draft,
    pending: mutation.isPending,
    fields,
    invalid,
    /** The failure that is not about a field, or null. */
    failure: mutation.isError && !invalid ? error : null,
    submit: (settings: Settings) => {
      mutation.mutate(settings, { onSuccess: () => setSavedDraft(draft) });
    },
  };
}

export type SettingsSave = ReturnType<typeof useSettingsSave>;

/** The buttons under a section's form, the saved note and what went wrong. */
export function SaveBar({
  save,
  onSave,
  disabled = false,
  leading,
}: {
  save: SettingsSave;
  onSave: () => void;
  disabled?: boolean;
  /** Buttons before *Save changes*, such as *Run search now*. */
  leading?: ReactNode;
}) {
  return (
    <>
      {save.failure ? (
        <Alert severity="error" role="alert">
          {`Couldn't save your settings. ${
            save.failure instanceof ApiClientError
              ? save.failure.message
              : "Check your connection and try again."
          }`}
        </Alert>
      ) : null}
      {save.invalid ? (
        <Alert severity="error" role="alert">
          Some values need fixing. The messages are under the fields.
          {save.fields["_"] ? ` ${save.fields["_"]}` : ""}
        </Alert>
      ) : null}
      <Box
        sx={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 1,
          pt: 2,
          borderTop: 1,
          borderColor: "divider",
        }}
      >
        <Typography
          role="status"
          aria-live="polite"
          variant="body2"
          color="text.secondary"
          sx={{ mr: "auto" }}
        >
          {save.saved ? "Changes saved" : ""}
        </Typography>
        {leading}
        <Button variant="contained" disabled={disabled || save.pending} onClick={onSave}>
          Save changes
        </Button>
      </Box>
    </>
  );
}

/**
 * A whole-number field. The value is `null` while the field is empty, so a half-typed number is
 * never turned into 0.
 */
export function IntField({
  label,
  value,
  onChange,
  error,
  min,
  max,
  width = 120,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
  error?: string | undefined;
  min?: number;
  max?: number;
  width?: number;
}) {
  return (
    <TextField
      type="number"
      label={label}
      value={value ?? ""}
      onChange={(event) => {
        const text = event.target.value;
        onChange(text === "" ? null : Number(text));
      }}
      error={Boolean(error)}
      helperText={error}
      slotProps={{ htmlInput: { min, max, step: 1, inputMode: "numeric" } }}
      sx={{ width }}
    />
  );
}

export const NOT_A_NUMBER = "Enter a whole number";

/** The message for a number that is missing or not whole, or undefined when it is a whole number. */
export function wholeNumberError(value: number | null): string | undefined {
  return value === null || !Number.isInteger(value) ? NOT_A_NUMBER : undefined;
}

export type Tone = "route" | "signal" | "stop" | "neutral";

/** A small status chip in a token pair, always with its word (never color alone). */
export function ToneChip({ tone, label }: { tone: Tone; label: string }) {
  return (
    <Chip
      size="small"
      label={label}
      data-tone={tone}
      sx={(theme) => {
        const pair =
          tone === "route"
            ? { bg: theme.palette.tokens.routeTint, fg: theme.palette.primary.main }
            : tone === "signal"
              ? { bg: theme.palette.tokens.signalTint, fg: theme.palette.warning.main }
              : tone === "stop"
                ? { bg: theme.palette.tokens.stopTint, fg: theme.palette.error.main }
                : {
                    bg: theme.palette.status.withdrawn.tint,
                    fg: theme.palette.status.withdrawn.main,
                  };
        return { bgcolor: pair.bg, color: pair.fg };
      }}
    />
  );
}
