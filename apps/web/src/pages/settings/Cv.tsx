import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import LinearProgress from "@mui/material/LinearProgress";
import Skeleton from "@mui/material/Skeleton";
import Typography from "@mui/material/Typography";
import type { CvProfile } from "@offerbound/contracts";
import { useState } from "react";
import { ApiClientError } from "../../api/client";
import {
  useCv,
  useCvProfileFailed,
  useRerankLeads,
  useRetryCvProfile,
  useUploadCv,
} from "../../api/hooks";
import { CvProfileSummary } from "../../components/CvProfileSummary";
import { FilePicker } from "../../components/FilePicker";
import { ErrorState } from "../../components/States";
import {
  CV_ACCEPT,
  CV_MAX_BYTES,
  cvErrorMessage,
  cvRejectionMessage,
  rejectFile,
} from "../../lib/files";
import { SectionPaper } from "./shared";
import { DemoLock } from "../../lib/demo";

/**
 * Settings, CV (DESIGN_SPEC §5.7, AC-11.3, AC-11.4): the read-only profile with *Replace CV* and
 * *Re-rank new leads*. `GET /cv` answers null both when there is no CV and when its profile failed,
 * so *Retry profile* is offered only after an upload of this session came back without a profile;
 * otherwise the owner is offered a new upload.
 */
export function Cv() {
  const cv = useCv();
  const profileFailed = useCvProfileFailed();
  const upload = useUploadCv();
  const retry = useRetryCvProfile();
  const rerank = useRerankLeads();
  const [rejected, setRejected] = useState<"unsupported_file" | "too_large" | null>(null);
  const [replaced, setReplaced] = useState(false);

  const choose = (file: File) => {
    const reason = rejectFile(file, CV_ACCEPT, CV_MAX_BYTES);
    setRejected(reason);
    if (reason) {
      upload.reset();
      return;
    }
    setReplaced(false);
    upload.mutate(file, { onSuccess: (outcome) => setReplaced(outcome.profileStatus === "ok") });
  };

  const profile: CvProfile | null = profileFailed ? null : (cv.data ?? null);
  const reading = upload.isPending;

  let body;
  if (cv.isPending && !profileFailed) {
    body = <Skeleton variant="rounded" height={120} aria-label="Loading your CV" />;
  } else if (cv.isError && !profileFailed && !profile) {
    body = <ErrorState what="your CV" error={cv.error} onRetry={() => void cv.refetch()} />;
  } else if (profileFailed) {
    body = (
      <Alert
        severity="warning"
        role="alert"
        action={
          <DemoLock reason="profile">
            <Button
              color="warning"
              variant="outlined"
              size="small"
              disabled={retry.isPending}
              onClick={() => retry.mutate()}
            >
              Retry profile
            </Button>
          </DemoLock>
        }
      >
        <Box component="span" sx={{ fontWeight: 700 }}>
          Your CV was saved, but its profile isn't ready.
        </Box>{" "}
        Retry the profile, or add the CV again.
      </Alert>
    );
  } else if (profile) {
    body = (
      <>
        <CvProfileSummary profile={profile} showSecondary />
        <Typography variant="caption" color="text.secondary" component="p">
          Green: core skills. Grey: secondary skills. Leads list their gaps against this profile.
        </Typography>
      </>
    );
  } else {
    body = (
      <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
        <Typography sx={{ fontWeight: 600 }}>No CV profile yet</Typography>
        <Typography variant="body2" color="text.secondary">
          Add your CV so Offerbound can rank leads against your skills. If you added one before and
          this still shows, add it again.
        </Typography>
      </Box>
    );
  }

  return (
    <SectionPaper
      id="cv-heading"
      title="CV"
      caption="Only the text and this profile are stored, not the file."
    >
      {body}

      {retry.isError ? (
        <Alert severity="error" role="alert">
          {`Couldn't build the profile. ${
            retry.error instanceof ApiClientError ? retry.error.message : "Try again."
          }`}
        </Alert>
      ) : null}
      {rejected ? (
        <Alert severity="error" role="alert">
          {cvRejectionMessage(rejected)}
        </Alert>
      ) : null}
      {upload.isError ? (
        <Alert severity="error" role="alert">
          {cvErrorMessage(upload.error)}
        </Alert>
      ) : null}
      {reading ? (
        <Box
          role="status"
          aria-live="polite"
          sx={{ display: "flex", flexDirection: "column", gap: 1 }}
        >
          <LinearProgress aria-label="Reading your CV" />
          <Typography variant="body2" color="text.secondary">
            Reading your CV and building your profile. This usually takes under a minute.
          </Typography>
        </Box>
      ) : null}
      {replaced ? (
        <Alert severity="success" role="status">
          CV replaced. Leads you already have keep their scores until you press Re-rank new leads.
        </Alert>
      ) : null}
      {rerank.isSuccess ? (
        <Alert severity="info" role="status">
          Ranking your new leads again. Their scores update in Leads shortly.
        </Alert>
      ) : null}
      {rerank.isError ? (
        <Alert severity="error" role="alert">
          {`Couldn't re-rank your leads. ${
            rerank.error instanceof ApiClientError ? rerank.error.message : "Try again."
          }`}
        </Alert>
      ) : null}

      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1 }}>
        <DemoLock reason="upload">
          <FilePicker
            label={profile || profileFailed ? "Replace CV" : "Choose CV file"}
            accept={CV_ACCEPT}
            onFile={choose}
            disabled={reading}
          />
        </DemoLock>
        {profile ? (
          <Button variant="outlined" disabled={rerank.isPending} onClick={() => rerank.mutate()}>
            Re-rank new leads
          </Button>
        ) : null}
      </Box>
    </SectionPaper>
  );
}
