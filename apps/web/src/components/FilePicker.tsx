import UploadFileOutlined from "@mui/icons-material/UploadFileOutlined";
import Button from "@mui/material/Button";
import type { ChangeEvent } from "react";

/**
 * A file chooser styled as a button. The real `<input type="file">` is visually hidden but stays
 * in the tab order, and the button shows the focus ring when it has focus.
 */
export function FilePicker({
  label,
  accept,
  onFile,
  disabled = false,
  variant = "outlined",
}: {
  label: string;
  /** The `accept` attribute: extensions and MIME types. */
  accept: string;
  onFile: (file: File) => void;
  disabled?: boolean;
  variant?: "outlined" | "text" | "contained";
}) {
  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Clear the input so choosing the same file again (after fixing it) still fires a change.
    event.target.value = "";
    if (file) onFile(file);
  };

  return (
    <Button
      component="label"
      variant={variant}
      disabled={disabled}
      startIcon={<UploadFileOutlined />}
      sx={{
        "&:focus-within": {
          outline: 2,
          outlineStyle: "solid",
          outlineColor: "primary.main",
          outlineOffset: 2,
        },
      }}
    >
      {label}
      <input
        type="file"
        accept={accept}
        onChange={choose}
        disabled={disabled}
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          margin: -1,
          padding: 0,
          overflow: "hidden",
          clip: "rect(0 0 0 0)",
          whiteSpace: "nowrap",
          border: 0,
        }}
      />
    </Button>
  );
}
