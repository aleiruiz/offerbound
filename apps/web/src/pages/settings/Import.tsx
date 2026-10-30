import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import { SheetImport } from "../../components/SheetImport";
import { SectionPaper } from "./shared";

/**
 * Settings, Import (DESIGN_SPEC §5.7, F14): the onboarding spreadsheet import, reused. The paste-a-report
 * importer (F9.4) joins it when that is built.
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
    </SectionPaper>
  );
}
