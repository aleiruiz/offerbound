import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Divider from "@mui/material/Divider";
import Typography from "@mui/material/Typography";
import { Link as RouterLink } from "react-router";
import { SheetImport } from "../../components/SheetImport";
import { SectionPaper } from "./shared";

/**
 * Settings, Import (DESIGN_SPEC §5.7, F14, F9.4): the onboarding spreadsheet import, reused, and an
 * entry to the paste-a-report importer, which lives on its own page under Leads.
 */
export function Import() {
  return (
    <SectionPaper id="import-heading" title="Import">
      <SheetImport
        actions={({ imported, importLabel, canImport, importing, runImport }) =>
          importLabel && !imported ? (
            <Box sx={{ display: "flex", justifyContent: "flex-end" }}>
              <Button variant="contained" disabled={!canImport || importing} onClick={runImport}>
                {importLabel}
              </Button>
            </Box>
          ) : null
        }
      />
      <Divider />
      <Box
        component="section"
        aria-labelledby="paste-report-heading"
        sx={{ display: "flex", flexDirection: "column", gap: 1.25, alignItems: "flex-start" }}
      >
        <Typography
          id="paste-report-heading"
          variant="subtitle1"
          component="h3"
          sx={{ fontWeight: 700 }}
        >
          Paste a report
        </Typography>
        <Typography sx={{ maxWidth: 680 }}>
          Have a list of roles from a chat or a newsletter? Paste it, check what Offerbound found
          and add the roles you want as leads. You can also copy the companies you already know to
          keep them out of the next report.
        </Typography>
        <Button variant="outlined" component={RouterLink} to="/leads/import">
          Paste a report
        </Button>
      </Box>
    </SectionPaper>
  );
}
