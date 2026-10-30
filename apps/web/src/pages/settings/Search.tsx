import CheckOutlined from "@mui/icons-material/CheckOutlined";
import CloseOutlined from "@mui/icons-material/CloseOutlined";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import Skeleton from "@mui/material/Skeleton";
import Switch from "@mui/material/Switch";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import {
  BRIEF_MAX_CHARS,
  type SearchRun,
  type SearchSettings,
  type Seniority,
  type Settings,
  type Track,
} from "@offerbound/contracts";
import { useState } from "react";
import { ApiClientError } from "../../api/client";
import { isApiError, useRunSearch, useSearchRuns, useTimezone } from "../../api/hooks";
import { FilterChip } from "../../components/FilterChip";
import { ErrorState } from "../../components/States";
import { formatCount, formatDateTime, formatUsd, zoneCity } from "../../lib/format";
import {
  IntField,
  SaveBar,
  SectionPaper,
  SettingsGate,
  ToneChip,
  useSettingsSave,
  wholeNumberError,
  type Tone,
} from "./shared";
import { DemoLock } from "../../lib/demo";

/**
 * Settings, Job search (DESIGN_SPEC §5.7, AC-10.1, AC-10.5): the daily search, its brief, tracks and
 * excluded levels, and below it the last 14 runs.
 */

const LEVELS: { value: Seniority; label: string }[] = [
  { value: "junior", label: "Junior" },
  { value: "mid", label: "Mid" },
  { value: "senior", label: "Senior" },
  { value: "staff_plus", label: "Staff and above" },
  { value: "lead", label: "Hands-on lead" },
  { value: "manager", label: "Managers who don't code" },
];

const PRIORITIES: { value: Track["priority"]; label: string }[] = [
  { value: 1, label: "1, highest" },
  { value: 2, label: "2" },
  { value: 3, label: "3" },
];

const RUN_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function Search() {
  return (
    <>
      <SettingsGate>{(settings) => <JobSearchForm settings={settings} />}</SettingsGate>
      <RecentRuns />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// The form

interface Draft {
  brief: string;
  tracks: Track[];
  excluded: Seniority[];
  min: number | null;
  max: number | null;
  runTime: string;
  enabled: boolean;
}

function toDraft(search: SearchSettings): Draft {
  return {
    brief: search.brief,
    tracks: search.tracks,
    excluded: search.excludedSeniorities,
    min: search.leadTarget.min,
    max: search.leadTarget.max,
    runTime: search.runTime,
    enabled: search.enabled,
  };
}

/** Messages keyed like the API's `fields`, so the server's can take their place. */
function validate(draft: Draft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (draft.brief.length > BRIEF_MAX_CHARS) {
    errors["search.brief"] = `Keep the brief to ${formatCount(BRIEF_MAX_CHARS)} characters`;
  }
  if (!RUN_TIME.test(draft.runTime)) errors["search.runTime"] = "Use HH:mm, for example 07:00";
  const minError = wholeNumberError(draft.min);
  const maxError = wholeNumberError(draft.max);
  if (minError) errors["search.leadTarget.min"] = minError;
  else if ((draft.min ?? 0) < 0) errors["search.leadTarget.min"] = "Use 0 or more";
  if (maxError) errors["search.leadTarget.max"] = maxError;
  else if (!minError && (draft.max ?? 0) < (draft.min ?? 0)) {
    errors["search.leadTarget.max"] = "Must be at least the minimum";
  }
  const seen = new Set<string>();
  draft.tracks.forEach((track, index) => {
    const key = track.key.trim();
    if (key === "") errors[`search.tracks.${index}.key`] = "Enter a key";
    else if (seen.has(key)) errors[`search.tracks.${index}.key`] = "Track keys must be unique";
    seen.add(key);
    if (track.label.trim() === "") errors[`search.tracks.${index}.label`] = "Enter a name";
  });
  return errors;
}

function JobSearchForm({ settings }: { settings: Settings }) {
  const timezone = useTimezone();
  const [draft, setDraft] = useState<Draft>(() => toDraft(settings.search));
  const [attempted, setAttempted] = useState(false);
  const save = useSettingsSave(draft);
  const [runNote, setRunNote] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const run = useRunSearch({
    onSuccess: () =>
      setRunNote({
        tone: "info",
        text: "Search started. New leads appear in Leads when it finishes.",
      }),
    onError: (error) =>
      setRunNote({
        tone: "error",
        text: isApiError(error, "already_running")
          ? "A search is already running."
          : `Couldn't start the search. ${error instanceof ApiClientError ? error.message : "Try again."}`,
      }),
  });

  const update = (patch: Partial<Draft>) => setDraft((previous) => ({ ...previous, ...patch }));
  const clientErrors = attempted ? validate(draft) : {};
  const briefTooLong = draft.brief.length > BRIEF_MAX_CHARS;
  // The brief's length is checked as it is typed; the rest when Save changes is pressed.
  const message = (key: string): string | undefined =>
    clientErrors[key] ??
    save.fields[key] ??
    (key === "search.brief" && briefTooLong ? "" : undefined);

  const submit = () => {
    setAttempted(true);
    const errors = validate(draft);
    if (Object.keys(errors).length > 0) return;
    const search: SearchSettings = {
      brief: draft.brief,
      tracks: draft.tracks.map((t) => ({ ...t, key: t.key.trim(), label: t.label.trim() })),
      excludedSeniorities: draft.excluded,
      leadTarget: { min: draft.min ?? 0, max: draft.max ?? 0 },
      runTime: draft.runTime,
      enabled: draft.enabled,
    };
    save.submit({ ...settings, search });
  };

  const setTrack = (index: number, patch: Partial<Track>) =>
    update({ tracks: draft.tracks.map((t, i) => (i === index ? { ...t, ...patch } : t)) });
  const toggleLevel = (level: Seniority) => {
    const next = draft.excluded.includes(level)
      ? draft.excluded.filter((l) => l !== level)
      : [...draft.excluded, level];
    // Keep the saved list in the order the chips are shown.
    const rank = (l: Seniority) => {
      const index = LEVELS.findIndex((entry) => entry.value === l);
      return index === -1 ? LEVELS.length : index;
    };
    update({ excluded: next.sort((a, b) => rank(a) - rank(b)) });
  };
  const addTrack = () => {
    const used = new Set(draft.tracks.map((t) => t.key));
    const key = ["A", "B", "C", "D", "E", "F"].find((k) => !used.has(k)) ?? "";
    update({ tracks: [...draft.tracks, { key, label: "", priority: 3 }] });
  };

  return (
    <SectionPaper
      id="job-search-heading"
      title="Job search"
      caption="Runs with OpenAI web search and your CV. Results go to Leads."
    >
      <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: "16px 28px" }}>
        <FormControlLabel
          sx={{ mt: 0.5 }}
          control={
            <Switch checked={draft.enabled} onChange={(_, enabled) => update({ enabled })} />
          }
          label="Run every day"
        />
        <TextField
          type="time"
          label="At"
          value={draft.runTime}
          onChange={(event) => update({ runTime: event.target.value })}
          error={Boolean(message("search.runTime"))}
          helperText={message("search.runTime")}
          slotProps={{ inputLabel: { shrink: true } }}
          sx={{ width: 150 }}
        />
        <Box component="fieldset" sx={fieldset}>
          <Typography component="legend" variant="subtitle2" sx={{ mb: 1 }}>
            New leads per day
          </Typography>
          <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1 }}>
            <IntField
              label="At least"
              value={draft.min}
              min={0}
              onChange={(min) => update({ min })}
              error={message("search.leadTarget.min")}
              width={104}
            />
            <Typography color="text.secondary" sx={{ pt: 1 }}>
              to
            </Typography>
            <IntField
              label="At most"
              value={draft.max}
              min={0}
              onChange={(max) => update({ max })}
              error={message("search.leadTarget.max")}
              width={104}
            />
          </Box>
        </Box>
      </Box>
      <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: -1.5 }}>
        {`${zoneCity(timezone)} time. The search stops early rather than padding the list to reach the target.`}
      </Typography>

      <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
        <Typography component="label" htmlFor="search-brief" variant="subtitle2">
          Search brief
        </Typography>
        <Typography variant="caption" color="text.secondary" component="p">
          Describe the roles, places, pay and exclusions you want. Your duplicate rules don't need
          to be here: Offerbound never shows a company you've already seen.
        </Typography>
        <DemoLock reason="text" block>
          <TextField
            id="search-brief"
            multiline
            minRows={8}
            fullWidth
            value={draft.brief}
            onChange={(event) => update({ brief: event.target.value })}
            error={Boolean(message("search.brief")) || briefTooLong}
            helperText={message("search.brief") || undefined}
            slotProps={{ htmlInput: { "aria-label": "Search brief" } }}
          />
        </DemoLock>
        <Typography variant="caption" color="text.secondary" sx={{ textAlign: "right" }}>
          {`${formatCount(draft.brief.length)} of ${formatCount(BRIEF_MAX_CHARS)} characters${
            briefTooLong ? ". Shorten it to save." : ""
          }`}
        </Typography>
      </Box>

      <Box component="fieldset" sx={{ ...fieldset, gap: 1.25 }}>
        <Typography component="legend" variant="subtitle2">
          Tracks
        </Typography>
        <Typography variant="caption" color="text.secondary" component="p">
          Each lead is put on one track. Leads are sorted by track priority, then fit.
        </Typography>
        <TableContainer sx={{ border: 1, borderColor: "divider", borderRadius: 1 }}>
          <Table sx={{ minWidth: 520 }}>
            <TableHead>
              <TableRow>
                <TableCell scope="col" sx={{ width: 96 }}>
                  Key
                </TableCell>
                <TableCell scope="col">Name</TableCell>
                <TableCell scope="col" sx={{ width: 150 }}>
                  Priority
                </TableCell>
                <TableCell scope="col" sx={{ width: 64 }}>
                  <Box component="span" sx={visuallyHidden}>
                    Remove
                  </Box>
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {draft.tracks.map((track, index) => (
                <TableRow key={index}>
                  <TableCell sx={{ verticalAlign: "top" }}>
                    <TextField
                      value={track.key}
                      onChange={(event) => setTrack(index, { key: event.target.value })}
                      error={Boolean(message(`search.tracks.${index}.key`))}
                      helperText={message(`search.tracks.${index}.key`)}
                      slotProps={{ htmlInput: { "aria-label": "Track key" } }}
                      sx={{ width: 80 }}
                    />
                  </TableCell>
                  <TableCell sx={{ verticalAlign: "top" }}>
                    <TextField
                      fullWidth
                      value={track.label}
                      onChange={(event) => setTrack(index, { label: event.target.value })}
                      error={Boolean(message(`search.tracks.${index}.label`))}
                      helperText={message(`search.tracks.${index}.label`)}
                      slotProps={{ htmlInput: { "aria-label": "Track name" } }}
                    />
                  </TableCell>
                  <TableCell sx={{ verticalAlign: "top" }}>
                    <TextField
                      select
                      value={String(track.priority)}
                      onChange={(event) =>
                        setTrack(index, {
                          priority: Number(event.target.value) as Track["priority"],
                        })
                      }
                      slotProps={{
                        select: { native: true },
                        htmlInput: { "aria-label": "Track priority" },
                      }}
                      sx={{ width: 132 }}
                    >
                      {PRIORITIES.map((p) => (
                        <option key={p.value} value={String(p.value)}>
                          {p.label}
                        </option>
                      ))}
                    </TextField>
                  </TableCell>
                  <TableCell sx={{ verticalAlign: "top" }}>
                    <IconButton
                      aria-label={`Remove track ${track.key || index + 1}`}
                      onClick={() => update({ tracks: draft.tracks.filter((_, i) => i !== index) })}
                    >
                      <CloseOutlined fontSize="small" />
                    </IconButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
        <Box>
          <Button onClick={addTrack}>Add track</Button>
        </Box>
      </Box>

      <Box component="fieldset" sx={{ ...fieldset, gap: 1.25 }}>
        <Typography component="legend" variant="subtitle2">
          Never show these levels
        </Typography>
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1 }}>
          {LEVELS.map((level) => {
            const pressed = draft.excluded.includes(level.value);
            return (
              <FilterChip
                key={level.value}
                label={level.label}
                pressed={pressed}
                onToggle={() => toggleLevel(level.value)}
                icon={pressed ? <CheckOutlined /> : undefined}
              />
            );
          })}
        </Box>
      </Box>

      <Box aria-live="polite" role="status">
        {runNote ? (
          <Alert severity={runNote.tone === "error" ? "error" : "info"}>{runNote.text}</Alert>
        ) : null}
      </Box>

      <SaveBar
        save={save}
        onSave={submit}
        disabled={briefTooLong}
        leading={
          <Button
            variant="outlined"
            disabled={run.isPending}
            onClick={() => {
              setRunNote(null);
              run.mutate();
            }}
          >
            Run search now
          </Button>
        }
      />
    </SectionPaper>
  );
}

const fieldset = {
  border: 0,
  m: 0,
  p: 0,
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
} as const;

const visuallyHidden = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
} as const;

// ---------------------------------------------------------------------------------------------
// Recent runs (AC-10.5)

const RUN_RESULT: Record<SearchRun["status"], { label: string; tone: Tone }> = {
  succeeded: { label: "Done", tone: "route" },
  partial: { label: "Below target", tone: "signal" },
  failed: { label: "Failed", tone: "stop" },
  running: { label: "Running", tone: "neutral" },
};

function RecentRuns() {
  const timezone = useTimezone();
  const runs = useSearchRuns();

  return (
    <SectionPaper id="runs-heading" title="Recent runs" caption="Last 14 runs">
      {runs.isPending ? (
        <Skeleton variant="rounded" height={120} aria-label="Loading recent runs" />
      ) : runs.isError ? (
        <ErrorState what="the recent runs" error={runs.error} onRetry={() => void runs.refetch()} />
      ) : runs.data.length === 0 ? (
        <Typography color="text.secondary">No search has run yet.</Typography>
      ) : (
        <TableContainer sx={{ border: 1, borderColor: "divider", borderRadius: 1 }}>
          <Table sx={{ minWidth: 720 }}>
            <TableHead>
              <TableRow>
                <TableCell scope="col">Started</TableCell>
                <TableCell scope="col">Result</TableCell>
                <TableCell scope="col" align="right">
                  New leads
                </TableCell>
                <TableCell scope="col" align="right">
                  Suppressed
                </TableCell>
                <TableCell scope="col" align="right">
                  Duplicates
                </TableCell>
                <TableCell scope="col" align="right">
                  Closed postings
                </TableCell>
                <TableCell scope="col" align="right">
                  Web searches
                </TableCell>
                <TableCell scope="col" align="right">
                  Cost
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {runs.data.slice(0, 14).map((run) => {
                const result = RUN_RESULT[run.status];
                return (
                  <TableRow key={run.id}>
                    <TableCell sx={{ verticalAlign: "top" }}>
                      <Typography variant="body2" component="span" sx={{ display: "block" }}>
                        {formatDateTime(run.startedAt, timezone)}
                      </Typography>
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        component="span"
                        sx={{ display: "block" }}
                      >
                        {run.trigger === "manual" ? "Run by you" : "Scheduled"}
                      </Typography>
                    </TableCell>
                    <TableCell sx={{ verticalAlign: "top" }}>
                      <ToneChip tone={result.tone} label={result.label} />
                      {run.error ? (
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          component="p"
                          sx={{ mt: 0.5, maxWidth: 360 }}
                        >
                          {run.error}
                        </Typography>
                      ) : null}
                    </TableCell>
                    <TableCell align="right">{formatCount(run.accepted)}</TableCell>
                    <TableCell align="right">{formatCount(run.suppressed)}</TableCell>
                    <TableCell align="right">{formatCount(run.duplicates)}</TableCell>
                    <TableCell align="right">{formatCount(run.dead)}</TableCell>
                    <TableCell align="right">{formatCount(run.webSearchCalls)}</TableCell>
                    <TableCell align="right">
                      {run.costMicros === null ? "Unknown" : formatUsd(run.costMicros)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </SectionPaper>
  );
}
