import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { useState, type DragEvent, type ReactNode, type Ref } from "react";
import { t } from "../i18n";

/**
 * A drop target around a file chooser. The chooser (a `FilePicker`) stays inside as the child, so
 * keyboard users and phones keep working; dropping is the extra way in. A dropped file goes to
 * `onFile` exactly as a chosen one does, and when several are dropped only the first is used.
 * While `disabled`, drops are swallowed (so the browser doesn't open the file) and nothing happens.
 */
export function DropZone({
  label,
  hint,
  onFile,
  disabled = false,
  children,
  ref,
}: {
  /** The zone's element, for callers that need to know whether focus is inside it. */
  ref?: Ref<HTMLDivElement>;
  /** The accessible name of the zone, for example "CV drop zone". */
  label: string;
  hint?: string;
  onFile: (file: File) => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  const [over, setOver] = useState(false);

  const carriesFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes("Files");

  const enter = (event: DragEvent<HTMLElement>) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    if (disabled) return;
    event.dataTransfer.dropEffect = "copy";
    setOver(true);
  };

  const leave = (event: DragEvent<HTMLElement>) => {
    // Moving between the zone's own children also fires dragleave; only leaving the zone counts.
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
      return;
    }
    setOver(false);
  };

  const drop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setOver(false);
    if (disabled) return;
    const file = event.dataTransfer.files[0];
    if (file) onFile(file);
  };

  return (
    <Box
      ref={ref}
      role="group"
      aria-label={label}
      data-drag-over={over ? "true" : undefined}
      data-disabled={disabled ? "true" : undefined}
      onDragEnter={enter}
      onDragOver={enter}
      onDragLeave={leave}
      onDrop={drop}
      sx={(theme) => ({
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 1.5,
        p: 2,
        border: 1.5,
        // A disabled zone takes no drops, so it loses the dashed "drop here" look.
        borderStyle: disabled ? "solid" : "dashed",
        borderColor: over ? "primary.main" : "divider",
        borderRadius: 1,
        bgcolor: disabled
          ? theme.palette.action.disabledBackground
          : over
            ? theme.palette.tokens.routeTint
            : "transparent",
        color: disabled ? theme.palette.text.disabled : undefined,
        transition: "background-color 120ms, border-color 120ms",
      })}
    >
      {children}
      {disabled ? null : (
        <Typography
          variant="body2"
          color={over ? "primary" : "text.secondary"}
          // Phones and tablets have no pointer to drag with, so the hint would only add noise.
          sx={{ "@media (hover: none)": { display: "none" } }}
        >
          {over ? t("Drop the file to add it") : (hint ?? t("or drop a file here"))}
        </Typography>
      )}
    </Box>
  );
}
