import Box from "@mui/material/Box";
import Tooltip from "@mui/material/Tooltip";
import { cloneElement, type ReactElement } from "react";
import { useMe } from "../api/hooks";

/**
 * The public demo (Release 1.1, DESIGN_SPEC §5.10, AC-16.6): controls that take free text, or add
 * records by hand, are disabled with a tooltip saying why. The server refuses the same requests
 * with `403 demo_read_only`; this keeps the visitor from running into that.
 */

/** True in the public demo. Reads the account `RequireSession` fetched; never asks the server again. */
export function useIsDemo(): boolean {
  return useMe({ enabled: false }).data?.mode === "demo";
}

/** Why a control is off, in the demo. One short sentence each, naming what the control does. */
export const DEMO_REASON = {
  add: "Adding records by hand is turned off in the demo.",
  edit: "Editing details is turned off in the demo.",
  notes: "Writing notes is turned off in the demo.",
  text: "Typing free text is turned off in the demo.",
  upload: "Uploading files is turned off in the demo.",
  import: "Importing is turned off in the demo.",
  settings: "Saving settings is turned off in the demo.",
  delete: "Deleting data is turned off in the demo.",
} as const;

export type DemoReason = keyof typeof DEMO_REASON;

/** What the visitor sees when the server refuses a request the page let through. */
export const DEMO_READ_ONLY_MESSAGE = "That is turned off in the demo. Nothing was changed.";

/**
 * Wraps one control. Outside the demo it renders the control untouched. In the demo it disables it
 * and puts a tooltip with the reason around it. A disabled control gets no pointer events, so the
 * tooltip hangs on a wrapper, which also takes focus for keyboard users.
 */
export function DemoLock({
  reason,
  block = false,
  children,
}: {
  reason: DemoReason;
  /** The wrapper fills the width, for fields and menu items. */
  block?: boolean;
  children: ReactElement<{ disabled?: boolean }>;
}) {
  const demo = useIsDemo();
  if (!demo) return children;
  return (
    <Tooltip title={DEMO_REASON[reason]}>
      <Box
        component="span"
        tabIndex={0}
        sx={{ display: block ? "block" : "inline-flex", width: block ? "100%" : undefined }}
      >
        {cloneElement(children, { disabled: true })}
      </Box>
    </Tooltip>
  );
}
