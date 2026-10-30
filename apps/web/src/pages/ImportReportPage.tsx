import ContentCopyOutlined from "@mui/icons-material/ContentCopyOutlined";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import Link from "@mui/material/Link";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import {
  MAX_REPORT_CHARS,
  MAX_REPORT_ROWS,
  type ReportPreview,
  type ReportRowAnnotation,
} from "@offerbound/contracts";
import { useEffect, useRef, useState } from "react";
import { Link as RouterLink } from "react-router";
import { isApiError, useCommitReport, useFetchSeenCompanies, usePreviewReport } from "../api/hooks";
import { DemoLock } from "../lib/demo";
import { formatCount, plural } from "../lib/format";
import { useLinkSx } from "../lib/link-sx";

/**
 * Import a report (AC-9.4, AC-9.5, TECHNICAL_SPEC §7.6): paste a text report, read the preview
 * annotated with what intake would do with each row, keep the rows still checked. *Copy companies
 * already seen* puts the list to paste into the chat that writes the report.
 */

const ANNOTATION: Record<
  ReportRowAnnotation,
  { label: string; color: "success" | "default" | "warning" }
> = {
  new: { label: "New", color: "success" },
  duplicate: { label: "Already tracked", color: "default" },
  company_already_seen: { label: "Suppressed: company already seen", color: "warning" },
  excluded_seniority: { label: "Suppressed: seniority excluded", color: "warning" },
};

/** Commit discards a row Offerbound already has, even when it is sent, so it can't be checked. */
const canKeep = (annotation: ReportRowAnnotation) => annotation !== "duplicate";

const EXPIRED = "This preview expired or was already used. Paste the report again.";

function previewErrorMessage(error: unknown): string {
  if (isApiError(error, "too_large")) {
    return `That report is over ${formatCount(MAX_REPORT_CHARS)} characters. Paste a shorter one.`;
  }
  return "Couldn't read the report. Try again.";
}

// ---------------------------------------------------------------------------------------------
// Copy companies already seen

function SeenCompanies() {
  const fetchList = useFetchSeenCompanies();
  const [status, setStatus] = useState<"copied" | "empty" | "failed" | null>(null);
  // The list, shown selected when the browser would not copy it.
  const [fallback, setFallback] = useState<string | null>(null);
  const fallbackRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (fallback === null) return;
    fallbackRef.current?.focus();
    fallbackRef.current?.select();
  }, [fallback]);

  const copy = async () => {
    setStatus(null);
    setFallback(null);
    let text: string;
    try {
      text = await fetchList.mutateAsync();
    } catch {
      setStatus("failed");
      return;
    }
    if (text.trim() === "") {
      setStatus("empty");
      return;
    }
    try {
      // Missing on an insecure origin, and refused when the browser wants a fresh click.
      if (!navigator.clipboard?.writeText) throw new Error("No clipboard");
      await navigator.clipboard.writeText(text);
      setStatus("copied");
    } catch {
      setFallback(text);
    }
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1.25, alignItems: "flex-start" }}>
      <Typography sx={{ maxWidth: 680 }}>
        Ask for a report of roles, then paste this list into the same chat and ask it to leave those
        companies out. It holds every company you already know and the other names they go by.
      </Typography>
      <Button
        variant="outlined"
        startIcon={<ContentCopyOutlined />}
        disabled={fetchList.isPending}
        onClick={() => void copy()}
      >
        Copy companies already seen
      </Button>
      <Box role="status" aria-live="polite" sx={{ width: "100%" }}>
        {status === "copied" ? (
          <Typography variant="body2" color="text.secondary">
            Copied to the clipboard
          </Typography>
        ) : null}
        {status === "empty" ? (
          <Typography variant="body2" color="text.secondary">
            No companies yet. Once you have leads or applications they are listed here.
          </Typography>
        ) : null}
      </Box>
      {status === "failed" ? (
        <Alert severity="error" role="alert">
          Couldn't load the list. Try again.
        </Alert>
      ) : null}
      {fallback !== null ? (
        <TextField
          label="Companies already seen"
          value={fallback}
          multiline
          minRows={4}
          maxRows={12}
          fullWidth
          inputRef={fallbackRef}
          helperText="Your browser didn't allow copying. The list is selected: press Ctrl+C, or Cmd+C on a Mac."
          slotProps={{ input: { readOnly: true } }}
          sx={{ maxWidth: 680 }}
        />
      ) : null}
    </Box>
  );
}

// ---------------------------------------------------------------------------------------------
// Preview table

function PreviewTable({
  preview,
  kept,
  onToggle,
  onToggleAll,
}: {
  preview: ReportPreview;
  kept: ReadonlySet<string>;
  onToggle: (rowId: string) => void;
  onToggleAll: () => void;
}) {
  const selectable = preview.rows.filter((r) => canKeep(r.annotation));
  const all = selectable.length > 0 && selectable.every((r) => kept.has(r.rowId));
  return (
    <TableContainer sx={{ border: 1, borderColor: "divider", borderRadius: 1 }}>
      <Table sx={{ minWidth: 640 }} aria-label="Roles in the report">
        <TableHead>
          <TableRow>
            <TableCell padding="checkbox">
              <Checkbox
                checked={all}
                indeterminate={kept.size > 0 && !all}
                disabled={selectable.length === 0}
                onChange={onToggleAll}
                slotProps={{ input: { "aria-label": "Keep every row" } }}
              />
            </TableCell>
            <TableCell scope="col">Company</TableCell>
            <TableCell scope="col">Role</TableCell>
            <TableCell scope="col">Location</TableCell>
            <TableCell scope="col">What happens</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {preview.rows.map((row) => {
            const note = ANNOTATION[row.annotation];
            return (
              <TableRow key={row.rowId} hover selected={kept.has(row.rowId)}>
                <TableCell padding="checkbox">
                  <Checkbox
                    checked={kept.has(row.rowId)}
                    disabled={!canKeep(row.annotation)}
                    onChange={() => onToggle(row.rowId)}
                    slotProps={{
                      input: { "aria-label": `Keep ${row.lead.company}, ${row.lead.title}` },
                    }}
                  />
                </TableCell>
                <TableCell sx={{ fontWeight: 600 }}>{row.lead.company}</TableCell>
                <TableCell>{row.lead.title}</TableCell>
                <TableCell>{row.lead.locationText ?? row.lead.country ?? ""}</TableCell>
                <TableCell>
                  <Chip size="small" variant="outlined" color={note.color} label={note.label} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

// ---------------------------------------------------------------------------------------------
// Page

export function ImportReportPage() {
  const linkSx = useLinkSx({ fontSize: "inherit" });
  const preview = usePreviewReport();
  const commit = useCommitReport();
  const [text, setText] = useState("");
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set());

  const over = text.length > MAX_REPORT_CHARS;
  const canRead = text.trim() !== "" && !over && !preview.isPending && !commit.isPending;
  const data = preview.data;
  const done = commit.isSuccess;
  const keptCount = kept.size;
  // What commit will do with the kept rows: new ones become leads in New, the rest are Suppressed.
  const keptRows = data?.rows.filter((r) => kept.has(r.rowId)) ?? [];
  const keptNew = keptRows.filter((r) => r.annotation === "new").length;
  const keptSuppressed = keptRows.length - keptNew;

  const read = () => {
    commit.reset();
    preview.mutate(text, {
      // Rows start checked as the API says: new ones, not the duplicates or already-seen.
      onSuccess: (result) =>
        setKept(new Set(result.rows.filter((r) => r.defaultKeep).map((r) => r.rowId))),
    });
  };

  const startOver = () => {
    commit.reset();
    preview.reset();
    setKept(new Set());
    setText("");
  };

  const toggle = (rowId: string) =>
    setKept((prev) => {
      const next = new Set(prev);
      if (!next.delete(rowId)) next.add(rowId);
      return next;
    });
  const toggleAll = () =>
    setKept((prev) => {
      const selectable = data?.rows.filter((r) => canKeep(r.annotation)) ?? [];
      return prev.size < selectable.length ? new Set(selectable.map((r) => r.rowId)) : new Set();
    });

  const runImport = () => {
    if (!data || keptCount === 0) return;
    // Rows go in the order of the report, whatever order they were checked in.
    const keepRowIds = data.rows.filter((r) => kept.has(r.rowId)).map((r) => r.rowId);
    commit.mutate(
      { previewId: data.previewId, keepRowIds },
      {
        onError: (error) => {
          if (isApiError(error, "not_found")) {
            preview.reset();
            setKept(new Set());
          }
        },
      },
    );
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2.5, maxWidth: 960 }}>
      <Box component="header" sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
        <Link component={RouterLink} to="/leads" sx={linkSx}>
          Back to Leads
        </Link>
        <Typography variant="h4" component="h1">
          Import a report
        </Typography>
      </Box>

      <SeenCompanies />

      <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5, alignItems: "flex-start" }}>
        <DemoLock reason="import" block>
          <TextField
            label="Report"
            placeholder="Paste a list of roles here"
            value={text}
            onChange={(e) => setText(e.target.value)}
            multiline
            minRows={8}
            maxRows={20}
            fullWidth
            disabled={done}
            error={over}
            helperText={
              <Box
                component="span"
                sx={{ display: "flex", justifyContent: "space-between", gap: 2 }}
              >
                <span>
                  {over
                    ? `Over the limit by ${formatCount(text.length - MAX_REPORT_CHARS)} characters. Shorten the report to read it.`
                    : "Offerbound reads the roles in it. Nothing is saved until you import."}
                </span>
                <span>{`${formatCount(text.length)} of ${formatCount(MAX_REPORT_CHARS)} characters`}</span>
              </Box>
            }
            sx={{ maxWidth: 680 }}
          />
        </DemoLock>
        <DemoLock reason="import">
          <Button variant="contained" disabled={!canRead || done} onClick={read}>
            {preview.isPending ? "Reading the report" : "Read the report"}
          </Button>
        </DemoLock>
      </Box>

      {preview.isError ? (
        <Alert severity="error" role="alert">
          {previewErrorMessage(preview.error)}
        </Alert>
      ) : null}

      {data ? (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {data.rows.length === 0
              ? "No roles found in the report"
              : `${plural(data.rows.length, "role", "roles")} found`}
          </Typography>
          {data.droppedRows > 0 ? (
            <Alert severity="warning" role="alert">
              {`The report has more than ${MAX_REPORT_ROWS} roles. ${plural(data.droppedRows, "role", "roles")} after the first ${MAX_REPORT_ROWS} weren't read. Paste them in a second report.`}
            </Alert>
          ) : null}
          {data.rows.length > 0 ? (
            <>
              <PreviewTable preview={data} kept={kept} onToggle={toggle} onToggleAll={toggleAll} />
              <Typography variant="caption" color="text.secondary">
                Rows already tracked can't be added. Rows from companies you've seen, or for a level
                you excluded, start unchecked: if you add them they go to Suppressed, not New.
              </Typography>
            </>
          ) : null}
        </Box>
      ) : null}

      {commit.isError ? (
        <Alert severity="error" role="alert">
          {isApiError(commit.error, "not_found")
            ? EXPIRED
            : "Couldn't import the leads. Try again."}
        </Alert>
      ) : null}
      {done ? (
        <Alert
          severity="success"
          role="status"
          action={
            <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
              <Button color="inherit" size="small" onClick={startOver}>
                Import another report
              </Button>
              <Button color="inherit" size="small" component={RouterLink} to="/leads">
                Go to Leads
              </Button>
            </Box>
          }
        >
          {`Imported ${plural(keptCount, "lead", "leads")}: ${keptNew} in New, ${keptSuppressed} in Suppressed.${keptNew > 0 ? " New leads appear once their links are checked." : ""}`}
        </Alert>
      ) : null}

      {data && data.rows.length > 0 && !done ? (
        <Box sx={{ display: "flex", justifyContent: "flex-end" }}>
          <Button
            variant="contained"
            disabled={keptCount === 0 || commit.isPending}
            onClick={runImport}
          >
            {`Import ${plural(keptCount, "lead", "leads")}`}
          </Button>
        </Box>
      ) : null}
    </Box>
  );
}
