import CheckCircleOutlined from "@mui/icons-material/CheckCircleOutlined";
import DescriptionOutlined from "@mui/icons-material/DescriptionOutlined";
import ExpandMoreOutlined from "@mui/icons-material/ExpandMoreOutlined";
import Accordion from "@mui/material/Accordion";
import AccordionDetails from "@mui/material/AccordionDetails";
import AccordionSummary from "@mui/material/AccordionSummary";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import LinearProgress from "@mui/material/LinearProgress";
import Paper from "@mui/material/Paper";
import Skeleton from "@mui/material/Skeleton";
import Step from "@mui/material/Step";
import StepLabel from "@mui/material/StepLabel";
import Stepper from "@mui/material/Stepper";
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
  DEFAULT_SETTINGS,
  type CvProfile,
  type SheetPreview,
  type SheetStatus,
  type SheetTarget,
} from "@offerbound/contracts";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { ApiClientError } from "../api/client";
import {
  useCommitSheetImport,
  useCompleteOnboarding,
  usePreviewSheetImport,
  useSaveSettings,
  useSettings,
  useStartGmail,
  useSyncStatus,
  useUploadCv,
} from "../api/hooks";
import { GOOGLE_START_PATH } from "../api/paths";
import { CvProfileSummary } from "../components/CvProfileSummary";
import { DropZone } from "../components/DropZone";
import { FilePicker } from "../components/FilePicker";
import { Logo } from "../components/Logo";
import { ErrorState } from "../components/States";
import { FlagChip } from "../components/StatusChip";

/**
 * Onboarding (DESIGN_SPEC §5.8, TECHNICAL_SPEC §11): upload the CV, import the spreadsheet, write
 * the search brief, start syncing Gmail. Only the last step is required. Every step stays mounted
 * once the owner has been there, so going back shows what was already done.
 */

const STEPS = [
  "Upload your CV",
  "Import your spreadsheet",
  "Write your search brief",
  "Start syncing Gmail",
] as const;
const LAST_STEP = STEPS.length - 1;
/**
 * Steps before the last one can be skipped; the stepper says so under their names until the step
 * is completed or skipped.
 */
const isOptional = (index: number) => index < LAST_STEP;

const MB = 1024 * 1024;
const CV_MAX_BYTES = 5 * MB;
const CSV_MAX_BYTES = 2 * MB;
const CV_ACCEPT =
  ".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const CSV_ACCEPT = ".csv,text/csv";

/** The OS file picker can bypass `accept`, so the page checks the extension or MIME type too. */
function hasAllowedType(file: File, accept: string): boolean {
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  return accept
    .split(",")
    .some((entry) => (entry.startsWith(".") ? name.endsWith(entry) : type === entry));
}

const countFormat = new Intl.NumberFormat("en-US");

function rowsLabel(n: number): string {
  return n === 1 ? "1 row" : `${countFormat.format(n)} rows`;
}

function plural(n: number, one: string, many: string): string {
  return `${countFormat.format(n)} ${n === 1 ? one : many}`;
}

// ---------------------------------------------------------------------------------------------
// Page

export function OnboardingPage() {
  const [active, setActive] = useState(0);
  const [visited, setVisited] = useState<ReadonlySet<number>>(new Set([0]));
  const [completed, setCompleted] = useState<ReadonlySet<number>>(new Set());
  const [skipped, setSkipped] = useState<ReadonlySet<number>>(new Set());
  const touched = useRef(false);
  const status = useSyncStatus();

  const goTo = (step: number) => {
    touched.current = true;
    setActive(step);
    setVisited((previous) => new Set(previous).add(step));
  };

  // Leaving and coming back while the first sync runs: open on the step that shows its progress.
  const alreadyStarted = status.data?.started === true;
  useEffect(() => {
    if (alreadyStarted && !touched.current) {
      setActive(LAST_STEP);
      setVisited((previous) => new Set(previous).add(LAST_STEP));
    }
  }, [alreadyStarted]);

  const advance = (from: number, outcome: "done" | "skipped") => {
    const mark = (set: ReadonlySet<number>) => new Set(set).add(from);
    const unmark = (set: ReadonlySet<number>) => {
      const next = new Set(set);
      next.delete(from);
      return next;
    };
    setCompleted(outcome === "done" ? mark : unmark);
    setSkipped(outcome === "skipped" ? mark : unmark);
    goTo(from + 1);
  };
  const back = (from: number) => goTo(from - 1);

  return (
    <Box
      component="main"
      sx={{
        minHeight: "100vh",
        bgcolor: "background.default",
        color: "text.primary",
        px: "max(16px, 4vw)",
        py: 4,
        display: "flex",
        flexDirection: "column",
        gap: 3.5,
      }}
    >
      {/* 40px artwork in a 28px line, as in the app shell header. */}
      <Logo height={40} style={{ margin: "-6px 0" }} />
      <Box
        sx={{ width: "100%", maxWidth: 960, display: "flex", flexDirection: "column", gap: 3.5 }}
      >
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
          <Typography variant="h5" component="h1" sx={{ fontWeight: 700 }}>
            Set up Offerbound
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Four steps. Only the last one is required; you can come back to the others in Settings.
          </Typography>
        </Box>

        <Stepper
          activeStep={active}
          aria-label="Setup steps"
          sx={{ flexWrap: "wrap", rowGap: 1.5 }}
        >
          {STEPS.map((label, index) => (
            <Step
              key={label}
              completed={completed.has(index)}
              aria-current={index === active ? "step" : undefined}
            >
              <StepLabel
                optional={
                  skipped.has(index) ? (
                    <Typography variant="caption">Skipped</Typography>
                  ) : isOptional(index) && !completed.has(index) ? (
                    <Typography variant="caption">Optional</Typography>
                  ) : undefined
                }
              >
                {label}
              </StepLabel>
            </Step>
          ))}
        </Stepper>

        <StepSection id="cv" title={STEPS[0]} active={active === 0} visited={visited.has(0)}>
          <CvStep onContinue={() => advance(0, "done")} onSkip={() => advance(0, "skipped")} />
        </StepSection>
        <StepSection
          id="import"
          title={STEPS[1]}
          active={active === 1}
          visited={visited.has(1)}
          optional
        >
          <ImportStep
            onBack={() => back(1)}
            onContinue={() => advance(1, "done")}
            onSkip={() => advance(1, "skipped")}
          />
        </StepSection>
        <StepSection id="brief" title={STEPS[2]} active={active === 2} visited={visited.has(2)}>
          <BriefStep
            active={active === 2}
            onBack={() => back(2)}
            onContinue={() => advance(2, "done")}
            onSkip={() => advance(2, "skipped")}
          />
        </StepSection>
        <StepSection id="gmail" title={STEPS[3]} active={active === 3} visited={visited.has(3)}>
          <GmailStep active={active === 3} onBack={() => back(3)} />
        </StepSection>
      </Box>
    </Box>
  );
}

/** One step's panel: an `h2`, and focus moves to it when the owner arrives from another step. */
function StepSection({
  id,
  title,
  active,
  visited,
  optional = false,
  children,
}: {
  id: string;
  title: string;
  active: boolean;
  visited: boolean;
  /** Shows an Optional label beside the heading (outside the `h2`, so its name stays the title). */
  optional?: boolean;
  children: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (active) heading.current?.focus();
  }, [active]);

  if (!visited) return null;
  return (
    <Paper
      component="section"
      variant="outlined"
      hidden={!active}
      aria-labelledby={`step-${id}`}
      sx={{ p: 3, display: active ? "flex" : "none", flexDirection: "column", gap: 2.5 }}
    >
      <Box
        sx={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          columnGap: 1.5,
          rowGap: 0.5,
        }}
      >
        <Typography
          id={`step-${id}`}
          ref={heading}
          tabIndex={-1}
          variant="h6"
          component="h2"
          sx={{ fontWeight: 700, outline: "none" }}
        >
          {title}
        </Typography>
        {optional ? <FlagChip tone="neutral" label="Optional" size="small" /> : null}
      </Box>
      {children}
    </Paper>
  );
}

function StepFooter({
  onBack,
  onSkip,
  children,
}: {
  onBack?: () => void;
  onSkip?: () => void;
  children?: ReactNode;
}) {
  return (
    <Box
      sx={{
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "space-between",
        gap: 1,
        pt: 0.5,
      }}
    >
      <Box>{onBack ? <Button onClick={onBack}>Back</Button> : null}</Box>
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1 }}>
        {onSkip ? <Button onClick={onSkip}>Skip this step</Button> : null}
        {children}
      </Box>
    </Box>
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiClientError ? error.message : fallback;
}

// ---------------------------------------------------------------------------------------------
// Step 1: CV (AC-11.1, 11.3)

function cvErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    switch (error.code) {
      case "cv_no_text":
        return "We couldn't read text from that file. It may be a scan or an image; export a version with text you can select, then add it again.";
      case "unsupported_file":
        return "Offerbound reads PDF and DOCX files. Choose one of those.";
      case "too_large":
        return "That file is larger than 5 MB. Choose a smaller one.";
      default:
        return error.message;
    }
  }
  return "The upload didn't go through. Check your connection and try again.";
}

function CvStep({ onContinue, onSkip }: { onContinue: () => void; onSkip: () => void }) {
  const upload = useUploadCv();
  const [rejected, setRejected] = useState<"unsupported_file" | "too_large" | null>(null);
  // The last upload that gave a profile. A later upload that fails does not replace it: the server
  // keeps the previous CV, and so does this page.
  const [profile, setProfile] = useState<CvProfile | null>(null);
  const [saved, setSaved] = useState(false);
  const [profileFailed, setProfileFailed] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const zone = useRef<HTMLDivElement>(null);
  const statusRegion = useRef<HTMLDivElement>(null);
  const refocus = useRef(false);

  // The chooser unmounts while the CV is read. If it had focus, move focus to the status region
  // (the next Tab reaches Skip or Continue) instead of letting it fall back to the page.
  const reading = upload.isPending;
  useEffect(() => {
    if (reading && refocus.current) {
      refocus.current = false;
      statusRegion.current?.focus();
    }
  }, [reading]);

  const choose = (file: File) => {
    const reason = !hasAllowedType(file, CV_ACCEPT)
      ? "unsupported_file"
      : file.size > CV_MAX_BYTES
        ? "too_large"
        : null;
    setRejected(reason);
    if (reason) {
      upload.reset();
      return;
    }
    setFileName(file.name);
    refocus.current = zone.current?.contains(document.activeElement) ?? false;
    upload.mutate(file, {
      onSuccess: (outcome) => {
        setSaved(true);
        setProfileFailed(outcome.profileStatus === "failed");
        // A new CV whose profile failed is the one on file now: the old profile no longer applies.
        setProfile(outcome.profile);
      },
    });
  };

  return (
    <>
      <Typography sx={{ maxWidth: 680 }}>
        Add your CV as a PDF or DOCX, up to 5 MB. Offerbound reads its text to rank leads against
        your skills. The file itself isn't kept, only the text and the profile built from it.
      </Typography>
      <DropZone ref={zone} label="CV drop zone" onFile={choose} disabled={upload.isPending}>
        {upload.isPending ? null : (
          <FilePicker
            label={saved ? "Replace CV" : "Choose CV file"}
            accept={CV_ACCEPT}
            onFile={choose}
          />
        )}
        <Box
          ref={statusRegion}
          role="status"
          aria-live="polite"
          tabIndex={-1}
          sx={{ flex: "1 1 280px", minWidth: 0, outline: "none" }}
        >
          {upload.isPending ? (
            <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
              {fileName ? (
                <Typography noWrap title={fileName} sx={{ fontWeight: 600 }}>
                  {fileName}
                </Typography>
              ) : null}
              <LinearProgress aria-label="Reading your CV" />
              <Typography variant="body2" color="text.secondary">
                {/* The file name is on the line above; repeating it would not wrap on a phone. */}
                Reading your CV and building your profile. This usually takes under a minute; keep
                this page open.
              </Typography>
            </Box>
          ) : null}
        </Box>
      </DropZone>
      {rejected ? (
        <Alert severity="error" role="alert">
          {cvErrorMessage(new ApiClientError({ status: 422, code: rejected, message: "" }))}
        </Alert>
      ) : null}
      {upload.isError ? (
        <Alert severity="error" role="alert">
          {cvErrorMessage(upload.error)}
        </Alert>
      ) : null}
      {profileFailed ? (
        <Alert severity="warning" role="alert">
          <Box component="span" sx={{ fontWeight: 700 }}>
            Your CV was saved, but its profile isn't ready.
          </Box>{" "}
          You can continue and build the profile again later in Settings.
        </Alert>
      ) : null}
      {profile ? (
        <Box
          aria-label="Your CV profile"
          role="region"
          sx={{ border: 1, borderColor: "divider", borderRadius: 1, p: 2 }}
        >
          <CvProfileSummary profile={profile} />
        </Box>
      ) : null}
      <StepFooter onSkip={saved ? undefined : onSkip}>
        {saved ? (
          <Button variant="contained" onClick={onContinue}>
            Continue
          </Button>
        ) : null}
      </StepFooter>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Step 2: spreadsheet (AC-14.1-14.5, S-23)

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
 * Stopgap until `POST /import/sheet/preview` exists (T7.5): today it answers 404, and the page
 * must not call that an expired preview. When T7.5 lands, narrow this to `not_found` or remove it,
 * so a transient preview failure doesn't tell the owner to skip.
 */
const IMPORT_UNAVAILABLE =
  "Spreadsheet import isn't available yet. Skip this step; you can import later from Settings.";

/** `phase` says which call failed: only a missing preview on *commit* means it expired. */
function importErrorMessage(error: unknown, phase: "preview" | "commit"): string {
  if (error instanceof ApiClientError) {
    const unavailable =
      phase === "preview" &&
      (error.code === "not_found" || error.code === "unexpected_response" || error.status >= 500);
    if (unavailable) return IMPORT_UNAVAILABLE;
    switch (error.code) {
      case "duplicate_import":
        return "This file was already imported. Skip this step to keep your list as it is.";
      case "too_large":
        return CSV_REJECTED.too_large;
      case "not_found":
        return "This preview expired. Add the file again.";
      default:
        return error.message;
    }
  }
  return "The request didn't go through. Check your connection and try again.";
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

function ImportStep({
  onBack,
  onContinue,
  onSkip,
}: {
  onBack: () => void;
  onContinue: () => void;
  onSkip: () => void;
}) {
  const preview = usePreviewSheetImport();
  const commit = useCommitSheetImport();
  const [fileName, setFileName] = useState<string | null>(null);
  const [rejected, setRejected] = useState<"unsupported_file" | "too_large" | null>(null);

  const choose = (file: File) => {
    // A file the page turns away leaves the preview already on screen as it was.
    const reason = !hasAllowedType(file, CSV_ACCEPT)
      ? "unsupported_file"
      : file.size > CSV_MAX_BYTES
        ? "too_large"
        : null;
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
      <Typography sx={{ maxWidth: 680, fontWeight: 600 }}>
        If you don't track your applications in a spreadsheet, skip this step. Gmail sync builds
        your list from your emails.
      </Typography>
      <ImportExpectations />

      <DropZone label="CSV drop zone" onFile={choose} disabled={picking || imported}>
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
              <FilePicker
                label="Replace file"
                accept={CSV_ACCEPT}
                onFile={choose}
                disabled={picking}
                variant="text"
              />
            ) : null}
          </Box>
        ) : (
          <>
            <FilePicker
              label="Choose CSV file"
              accept={CSV_ACCEPT}
              onFile={choose}
              disabled={picking}
            />
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
                      <TableCell align="right">{countFormat.format(row.rows)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Box>
          <SkippedRows preview={data} />
          <Typography variant="caption" color="text.secondary">
            Your notes are kept as they are. Gmail sync starts in step 4, so your emails attach to
            these records instead of creating duplicates.
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

      <StepFooter onBack={onBack} onSkip={imported ? undefined : onSkip}>
        {imported ? (
          <Button variant="contained" onClick={onContinue}>
            Continue
          </Button>
        ) : data ? (
          <Button
            variant="contained"
            disabled={importable === 0 || commit.isPending}
            onClick={() => commit.mutate(data.previewId)}
          >
            {`Import ${rowsLabel(importable)}`}
          </Button>
        ) : null}
      </StepFooter>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Step 3: search brief (AC-10.1)

const BRIEF_PLACEHOLDER =
  "For example: senior full-stack roles, remote from Mexico or with relocation support. At least US$8k per month. No agencies, no on-site only.";

function BriefStep({
  active,
  onBack,
  onContinue,
  onSkip,
}: {
  active: boolean;
  onBack: () => void;
  onContinue: () => void;
  onSkip: () => void;
}) {
  const settings = useSettings({ enabled: active });
  const save = useSaveSettings();
  // `undefined` until the owner types; then what they typed.
  const [draft, setDraft] = useState<string | undefined>(undefined);

  const stored = settings.data?.search.brief ?? "";
  // The repo-shipped brief is instructions, not the owner's words: start from an empty field.
  const initial = stored === DEFAULT_SETTINGS.search.brief ? "" : stored;
  const brief = draft ?? initial;
  const tooLong = brief.length > BRIEF_MAX_CHARS;
  // The text last saved from this page. Once there is one, the step is done: Continue replaces Skip.
  const [savedBrief, setSavedBrief] = useState<string | null>(null);
  const saved = savedBrief !== null;
  const unchanged = saved && brief.trim() === savedBrief;

  const submit = () => {
    if (!settings.data) return;
    const text = brief.trim();
    save.mutate(
      { ...settings.data, search: { ...settings.data.search, brief: text } },
      {
        onSuccess: () => {
          setSavedBrief(text);
          onContinue();
        },
      },
    );
  };

  return (
    <>
      <Typography sx={{ maxWidth: 680 }}>
        Describe the roles you want: titles, locations, work modes, pay floors and anything to
        avoid. Offerbound uses it for the daily search and to rank leads. You can change it any time
        in Settings.
      </Typography>

      {settings.isPending && active ? (
        <Skeleton variant="rounded" height={160} aria-label="Loading your search brief" />
      ) : settings.isError ? (
        <ErrorState
          what="your settings"
          error={settings.error}
          onRetry={() => void settings.refetch()}
        />
      ) : (
        <TextField
          label="Search brief"
          multiline
          minRows={6}
          fullWidth
          value={brief}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={BRIEF_PLACEHOLDER}
          error={tooLong}
          helperText={
            tooLong
              ? `${countFormat.format(brief.length)} of ${countFormat.format(BRIEF_MAX_CHARS)} characters. Shorten it to save.`
              : `${countFormat.format(brief.length)} of ${countFormat.format(BRIEF_MAX_CHARS)} characters`
          }
        />
      )}

      {save.isError ? (
        <Alert severity="error" role="alert">
          {`Couldn't save your brief. ${errorMessage(save.error, "Check your connection and try again.")}`}
        </Alert>
      ) : null}

      <StepFooter onBack={onBack} onSkip={saved ? undefined : onSkip}>
        {unchanged ? (
          <Button variant="contained" onClick={onContinue}>
            Continue
          </Button>
        ) : (
          <Button
            variant="contained"
            disabled={!settings.data || brief.trim() === "" || tooLong || save.isPending}
            onClick={submit}
          >
            Save and continue
          </Button>
        )}
      </StepFooter>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Step 4: start syncing Gmail (AC-2.3)

function GmailStep({ active, onBack }: { active: boolean; onBack: () => void }) {
  const navigate = useNavigate();
  const status = useSyncStatus();
  const start = useStartGmail();
  const complete = useCompleteOnboarding();
  const finishing = useRef(false);

  const data = status.data;
  const started = data?.started === true;
  const backfill = data?.backfill;
  const needsAccess = data !== undefined && data.connection !== "active";

  const finish = () => {
    finishing.current = true;
    complete.mutate(undefined, { onSuccess: () => void navigate("/today", { replace: true }) });
  };

  // The first sync is done: setup is complete, so go to Today.
  const firstSyncDone = started && backfill?.state === "done";
  useEffect(() => {
    if (active && firstSyncDone && !finishing.current) finish();
    // `finish` only touches a ref and the mutation; it runs once per visit.
  }, [active, firstSyncDone]);

  const notConnected =
    start.error instanceof ApiClientError && start.error.code === "not_connected";

  return (
    <>
      <Typography sx={{ maxWidth: 680 }}>
        {started
          ? "Offerbound is reading your Gmail with read-only access. It never sends, deletes or labels email."
          : "Offerbound reads your Gmail with read-only access. It never sends, deletes or labels email. Nothing is read until you press the button, so the spreadsheet import comes first."}
      </Typography>

      {!started ? (
        <>
          <Box
            component="ul"
            aria-label="What Offerbound reads"
            sx={{ m: 0, pl: 2.5, maxWidth: 680 }}
          >
            <Typography component="li" variant="body2">
              Emails from job sites, hiring systems like Ashby or Greenhouse, and companies you've
              applied to are read in full and sent to OpenAI to update your records.
            </Typography>
            <Typography component="li" variant="body2">
              For any other email, only the sender, subject and the short preview Gmail shows are
              sent to OpenAI, to decide whether it's about your job search.
            </Typography>
            <Typography component="li" variant="body2">
              Promotions and forum emails that don't come from a job source are skipped without
              being sent anywhere.
            </Typography>
          </Box>
          {needsAccess || notConnected ? (
            <Alert
              severity="warning"
              role="alert"
              action={
                <Button component="a" href={GOOGLE_START_PATH} color="warning" size="small">
                  Connect Gmail
                </Button>
              }
            >
              Offerbound doesn't have access to your Gmail yet. Connect it, then start syncing.
            </Alert>
          ) : null}
          {start.isError && !notConnected ? (
            <Alert severity="error" role="alert">
              {`Couldn't start syncing. ${errorMessage(start.error, "Check your connection and try again.")}`}
            </Alert>
          ) : null}
        </>
      ) : (
        <FirstSync
          state={backfill?.state ?? "running"}
          listed={backfill?.listed ?? 0}
          processed={backfill?.processed ?? 0}
        />
      )}

      {complete.isError ? (
        <Alert severity="error" role="alert">
          {`Couldn't finish setup. ${errorMessage(complete.error, "Check your connection and try again.")}`}
        </Alert>
      ) : null}

      <StepFooter onBack={started ? undefined : onBack}>
        {started ? (
          <Button variant="contained" disabled={complete.isPending} onClick={finish}>
            {complete.isError ? "Try again" : "Go to Today"}
          </Button>
        ) : (
          <Button
            variant="contained"
            disabled={start.isPending || needsAccess || notConnected}
            onClick={() => start.mutate()}
          >
            Start syncing
          </Button>
        )}
      </StepFooter>
    </>
  );
}

/** The first-sync progress card (DESIGN_SPEC §7, States board). */
function FirstSync({
  state,
  listed,
  processed,
}: {
  state: "not_started" | "running" | "done" | "failed";
  listed: number;
  processed: number;
}) {
  const percent = listed > 0 ? Math.min(100, Math.round((processed / listed) * 100)) : 0;
  return (
    <Box
      role="status"
      aria-live="polite"
      sx={{
        display: "flex",
        flexDirection: "column",
        gap: 1,
        p: 2,
        border: 1,
        borderColor: "divider",
        borderRadius: 1,
      }}
    >
      {state === "failed" ? (
        <Alert severity="error" role="alert">
          The first sync stopped before it finished. Go to Today and use Sync now to try again.
        </Alert>
      ) : (
        <>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            {state === "done" ? (
              <CheckCircleOutlined color="primary" fontSize="small" aria-hidden />
            ) : null}
            <Typography sx={{ fontWeight: 700 }}>
              {state === "done" ? "First sync finished" : "First sync in progress"}
            </Typography>
          </Box>
          {listed > 0 || state === "done" ? (
            <LinearProgress
              variant="determinate"
              value={state === "done" ? 100 : percent}
              aria-label="First sync"
              sx={{ height: 6, borderRadius: 3 }}
            />
          ) : (
            <LinearProgress aria-label="First sync" sx={{ height: 6, borderRadius: 3 }} />
          )}
          <Typography variant="body2" color="text.secondary">
            {listed > 0
              ? `${countFormat.format(processed)} of ${countFormat.format(listed)} checked. `
              : "Finding your email. "}
            Applications update as emails are read; follow-up timers start when this finishes. You
            can leave this page; the sync keeps running.
          </Typography>
        </>
      )}
    </Box>
  );
}
