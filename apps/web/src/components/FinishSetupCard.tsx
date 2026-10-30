import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import { DEFAULT_SETTINGS } from "@offerbound/contracts";
import { useState } from "react";
import { Link as RouterLink } from "react-router";
import { useCv, useSettings } from "../api/hooks";
import { useIsDemo } from "../lib/demo";

/**
 * Setup steps skipped in onboarding are easy to forget, and the daily search ranks leads against
 * the CV and the brief. Today lists the ones still missing, each with a link to its Settings
 * section, until both are done or the owner hides the card on this device.
 */

export const SETUP_HIDDEN_KEY = "ob.finishSetupHidden";

/** The brief counts as written when the owner's own brief is on file, not the shipped one. */
export function hasOwnBrief(brief: string | undefined): boolean {
  return brief !== undefined && brief.trim() !== "" && brief !== DEFAULT_SETTINGS.search.brief;
}

function readHidden(): boolean {
  try {
    return window.localStorage.getItem(SETUP_HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeHidden(): void {
  try {
    window.localStorage.setItem(SETUP_HIDDEN_KEY, "1");
  } catch {
    // storage is blocked: the card comes back on the next visit
  }
}

interface Missing {
  key: string;
  title: string;
  why: string;
  to: string;
  action: string;
}

export function FinishSetupCard() {
  const demo = useIsDemo();
  const cv = useCv();
  const settings = useSettings();
  const [hidden, setHidden] = useState(readHidden);

  // Nothing is claimed missing until both answers are in.
  if (demo || hidden || cv.isPending || settings.isPending || cv.isError || settings.isError) {
    return null;
  }

  const missing: Missing[] = [];
  if (!cv.data) {
    missing.push({
      key: "cv",
      title: "Upload your CV",
      why: "Leads are scored against it.",
      to: "/settings/cv",
      action: "Upload CV",
    });
  }
  if (!hasOwnBrief(settings.data.search.brief)) {
    missing.push({
      key: "brief",
      title: "Write your search brief",
      why: "The daily search looks for the roles it describes.",
      to: "/settings/search",
      action: "Write brief",
    });
  }
  if (missing.length === 0) return null;

  return (
    <Paper
      component="section"
      aria-labelledby="finish-setup-title"
      variant="outlined"
      sx={{ p: 2.5, display: "flex", flexDirection: "column", gap: 1.5 }}
    >
      <Box
        sx={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 2 }}
      >
        <Typography id="finish-setup-title" variant="h5" component="h2" sx={{ fontWeight: 700 }}>
          Finish setting up
        </Typography>
        <Button
          size="small"
          onClick={() => {
            writeHidden();
            setHidden(true);
          }}
        >
          Hide
        </Button>
      </Box>
      <Typography variant="body2" color="text.secondary">
        {missing.length === 1 ? "One setup step is" : `${missing.length} setup steps are`} still
        open. You can do them any time in Settings.
      </Typography>
      {missing.map((step) => (
        <Box
          key={step.key}
          sx={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 1.5,
            borderTop: 1,
            borderColor: "divider",
            pt: 1.5,
          }}
        >
          <Box sx={{ display: "flex", flexDirection: "column" }}>
            <Typography variant="subtitle2" component="h3">
              {step.title}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {step.why}
            </Typography>
          </Box>
          <Button component={RouterLink} to={step.to} variant="outlined">
            {step.action}
          </Button>
        </Box>
      ))}
    </Paper>
  );
}
