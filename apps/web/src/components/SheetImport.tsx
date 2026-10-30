import DescriptionOutlined from "@mui/icons-material/DescriptionOutlined";
import ExpandMoreOutlined from "@mui/icons-material/ExpandMoreOutlined";
import Accordion from "@mui/material/Accordion";
import AccordionDetails from "@mui/material/AccordionDetails";
import AccordionSummary from "@mui/material/AccordionSummary";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import type { SheetPreview, SheetStatus, SheetTarget } from "@offerbound/contracts";
import { useState, type ReactNode } from "react";
import { ApiClientError } from "../api/client";
import { useCommitSheetImport, usePreviewSheetImport } from "../api/hooks";
import { CSV_ACCEPT, CSV_MAX_BYTES, rejectFile } from "../lib/files";
import { formatCount, plural, rowsLabel } from "../lib/format";
import { DropZone } from "./DropZone";
import { FilePicker } from "./FilePicker";
import { DemoLock, useIsDemo } from "../lib/demo";

/**
 * The spreadsheet import (DESIGN_SPEC §5.8 and §5.7, AC-14.1-14.5): choose the CSV, read the
 * preview, import. Onboarding's second step and Settings, Import are the same component; each
 * supplies its own buttons through `actions`.
 */

const SHEET_STATUS_LABEL: Record<SheetStatus, string> = {
  to_research: "To research",
  cancelled: "Cancelled",
  applied: "Applied",
  interview: "Interview",
  rejected: "Rejected",
};

const SHEET_TARGET_LABEL: Record<SheetTarget, string> = {
  lead_new: "New leads, checked and ranked after import",
  lead_dismissed: "Dismissed leads, kept so their companies aren't suggested again",
  application_applied: "Applications with status Applied",
  application_interviewing: "Applications with status Interviewing",
  application_rejected: "Applications with status Rejected",
};

const CSV_REJECTED = {
  unsupported_file:
    "Offerbound imports CSV files. In Google Sheets, choose File, Download, Comma-separated values, then add that file.",
  too_large: "That file is larger than 2 MB. Export only the Applications tab and try again.",
} as const;

/**
 * What to tell the owner when a call of the import fails. `phase` says which call it was: only a
 * missing preview on *commit* means it expired. A header-less file comes back as
 * `validation_failed` from the preview, and its message says what is wrong.
 */
function importErrorMessage(error: unknown, phase: "preview" | "commit"): string {
  if (error instanceof ApiClientError) {
    switch (error.code) {
      case "validation_failed":
        if (phase === "preview") return error.message;
        break;
      case "too_large":
        return "File is over 2 MB";
      case "duplicate_import":
        return "This file was already imported";
      case "not_found":
        if (phase === "commit") return "This preview expired. Add the file again.";
        break;
    }
  }
  return "Couldn't import the file. Try again.";
}

function SkippedRows({ preview }: { preview: SheetPreview }) {
  const skipped = preview.errors.length + preview.duplicatesInFile.length + preview.existingMatches;
  if (skipped === 0) return null;
  return (
    <Alert severity="warning" role="alert">
      <Typography variant="body2" sx={{ fontWeight: 700 }}>
        {`${rowsLabel(skipped)} will be skipped.`}
      </Typography>
      <Box component="ul" sx={{ m: 0, mt: 0.5, pl: 2.5 }}>
        {preview.errors.map((row) => (
          <Typography key={`e-${row.line}`} component="li" variant="body2">
            {`Row ${row.line}: ${row.message}`}
          </Typography>
        ))}
        {preview.duplicatesInFile.map((row) => (
          <Typography key={`d-${row.line}`} component="li" variant="body2">
            {`Row ${row.line} repeats row ${row.duplicateOfLine} (${row.company}, ${row.role}).`}
          </Typography>
        ))}
        {preview.existingMatches > 0 ? (
          <Typography component="li" variant="body2">
            {`${rowsLabel(preview.existingMatches)} match records Offerbound already has.`}
          </Typography>
        ) : null}
      </Box>
      {preview.errors.length > 0 ? (
        <Typography variant="body2" sx={{ mt: 0.5 }}>
          Change the sheet and add the file again, or import without those rows.
        </Typography>
      ) : null}
    </Alert>
  );
}

const EXPECTATIONS: readonly { lead: string; text: string }[] = [
  {
    lead: "What it reads:",
    text: "the Applications tab exported as CSV. Offerbound finds the header row by itself; it needs Company, Role and Status. It also uses Country, City or modality, Date applied, Salary, Sponsorship or relocation, Job link and Notes when they are there.",
  },
  {
    lead: "How statuses become records:",
    text: "To research becomes a new lead. Applied, Interview and Rejected become applications. Cancelled becomes a dismissed lead. Any other status is reported and skipped.",
  },
  {
    lead: "What you see first:",
    text: "a preview with counts, rows with errors and duplicates in the file. Nothing is saved until you press Import.",
  },
  {
    lead: "Duplicates:",
    text: "rows that match records you already have are skipped, and the same file can't be imported twice.",
  },
  { lead: "Your spreadsheet:", text: "it isn't changed." },
];

/** AC-14.1-14.6 in plain words. Open by default; folds away so a phone isn't left with a long card. */
function ImportExpectations() {
  return (
    <Accordion
      defaultExpanded
      disableGutters
      elevation={0}
      sx={{
        maxWidth: 680,
        border: 1,
        borderColor: "divider",
        borderRadius: 1,
        "&:before": { display: "none" },
      }}
    >
      <AccordionSummary expandIcon={<ExpandMoreOutlined />}>
        <Typography sx={{ fontWeight: 600 }}>What to expect</Typography>
      </AccordionSummary>
      <AccordionDetails sx={{ pt: 0 }}>
        <Box
          component="ul"
          sx={{ m: 0, pl: 2.5, display: "flex", flexDirection: "column", gap: 1 }}
        >
          {EXPECTATIONS.map((item) => (
            <Typography key={item.lead} component="li" variant="body2">
              <Box component="span" sx={{ fontWeight: 700 }}>
                {item.lead}
              </Box>{" "}
              {item.text}
            </Typography>
          ))}
        </Box>
      </AccordionDetails>
    </Accordion>
  );
}

export interface SheetImportState {
  /** The import has run: the summary is on screen. */
  imported: boolean;
  /** "Import 41 rows" once a preview has been read, otherwise empty. */
  importLabel: string;
  /** The preview has at least one row to import. */
  canImport: boolean;
  /** The import call is in flight. */
  importing: boolean;
  runImport: () => void;
}

export function SheetImport({
  intro,
  note = "Your notes are kept as they are.",
  actions,
}: {
  /** Extra paragraphs between the instructions and the "What to expect" panel. */
  intro?: ReactNode;
  /** The caption under the preview. */
  note?: ReactNode;
  /** The buttons under the import: onboarding's footer, or Settings' single button. */
  actions: (state: SheetImportState) => ReactNode;
}) {
  const demo = useIsDemo();
  const preview = usePreviewSheetImport();
  const commit = useCommitSheetImport();
  const [fileName, setFileName] = useState<string | null>(null);
  const [rejected, setRejected] = useState<"unsupported_file" | "too_large" | null>(null);

  const choose = (file: File) => {
    // A file the page turns away leaves the preview already on screen as it was.
    const reason = rejectFile(file, CSV_ACCEPT, CSV_MAX_BYTES);
    setRejected(reason);
    if (reason) return;
    setFileName(file.name);
    commit.reset();
    preview.mutate(file);
  };

  const data = preview.data;
  const importable = data ? data.mappings.reduce((sum, row) => sum + row.rows, 0) : 0;
  const summary = commit.data;
  const imported = commit.isSuccess;
  const picking = preview.isPending || commit.isPending;

  return (
    <>
      <Typography sx={{ maxWidth: 680 }}>
        In Google Sheets, open the Applications tab and choose File, Download, Comma-separated
        values. Add that file here. Offerbound imports it once; from then on it keeps your list
        current from Gmail.
      </Typography>
      {intro}
      <ImportExpectations />

      <DropZone label="CSV drop zone" onFile={choose} disabled={picking || imported || demo}>
        {data && fileName ? (
          <Box
            sx={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 1.5,
              flex: "1 1 auto",
              minWidth: 0,
            }}
          >
            <DescriptionOutlined sx={{ color: "text.secondary" }} aria-hidden />
            <Box sx={{ flex: "1 1 260px", minWidth: 0 }}>
              <Typography sx={{ fontWeight: 600, wordBreak: "break-word" }}>{fileName}</Typography>
              <Typography variant="caption" color="text.secondary">
                {`${rowsLabel(data.totalRows)} found under the title rows`}
              </Typography>
            </Box>
            {!imported ? (
              <DemoLock reason="import">
                <FilePicker
                  label="Replace file"
                  accept={CSV_ACCEPT}
                  onFile={choose}
                  disabled={picking}
                  variant="text"
                />
              </DemoLock>
            ) : null}
          </Box>
        ) : (
          <>
            <DemoLock reason="import">
              <FilePicker
                label="Choose CSV file"
                accept={CSV_ACCEPT}
                onFile={choose}
                disabled={picking}
              />
            </DemoLock>
            <Box role="status" aria-live="polite">
              {preview.isPending ? (
                <Typography variant="body2" color="text.secondary">
                  Reading your file
                </Typography>
              ) : null}
            </Box>
          </>
        )}
      </DropZone>

      {rejected ? (
        <Alert severity="error" role="alert">
          {CSV_REJECTED[rejected]}
        </Alert>
      ) : null}
      {preview.isError ? (
        <Alert severity="error" role="alert">
          {importErrorMessage(preview.error, "preview")}
        </Alert>
      ) : null}

      {data ? (
        <>
          <Box sx={{ display: "flex", flexDirection: "column", gap: 1.25 }}>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              What will be imported
            </Typography>
            <TableContainer sx={{ border: 1, borderColor: "divider", borderRadius: 1 }}>
              <Table sx={{ minWidth: 560 }}>
                <TableHead>
                  <TableRow>
                    <TableCell scope="col">Status in your sheet</TableCell>
                    <TableCell scope="col">Becomes</TableCell>
                    <TableCell scope="col" align="right">
                      Rows
                    </TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {data.mappings.map((row) => (
                    <TableRow key={row.sheetStatus}>
                      <TableCell>{SHEET_STATUS_LABEL[row.sheetStatus]}</TableCell>
                      <TableCell>{SHEET_TARGET_LABEL[row.target]}</TableCell>
                      <TableCell align="right">{formatCount(row.rows)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Box>
          <SkippedRows preview={data} />
          <Typography variant="caption" color="text.secondary">
            {note}
          </Typography>
        </>
      ) : null}

      {commit.isError ? (
        <Alert severity="error" role="alert">
          {importErrorMessage(commit.error, "commit")}
        </Alert>
      ) : null}
      {summary ? (
        <Alert severity="success" role="status">
          {`Imported ${plural(summary.applicationsCreated, "application", "applications")}, ${plural(summary.leadsCreated, "new lead", "new leads")} and ${plural(summary.leadsDismissed, "dismissed lead", "dismissed leads")}.`}
          {summary.skippedExisting + summary.skippedDuplicateRows + summary.errorRows > 0
            ? ` ${rowsLabel(summary.skippedExisting + summary.skippedDuplicateRows + summary.errorRows)} skipped.`
            : ""}
        </Alert>
      ) : null}

      {actions({
        imported,
        importLabel: data ? `Import ${rowsLabel(importable)}` : "",
        canImport: importable > 0,
        importing: commit.isPending,
        runImport: () => {
          if (data) commit.mutate(data.previewId);
        },
      })}
    </>
  );
}
