import Box from "@mui/material/Box";
import Tooltip from "@mui/material/Tooltip";
import { cloneElement, type ReactElement } from "react";
import { useMe } from "../api/hooks";
import { msg, t } from "../i18n";

/**
 * The public demo (Release 1.1, DESIGN_SPEC §5.10, AC-16.6): controls that take free text, or add
 * records by hand, are disabled with a tooltip saying why. The server refuses the same requests
 * with `403 demo_read_only`; this keeps the visitor from running into that.
 */

/** True in the public demo. Reads the account `RequireSession` fetched; never asks the server again. */
export function useIsDemo(): boolean {
  return useMe({ enabled: false }).data?.mode === "demo";
}

/** Why a control is off, in the demo. One short sentence each, in English: show it through `t()`. */
export const DEMO_REASON = {
  add: msg("Adding records by hand is turned off in the demo."),
  edit: msg("Editing details is turned off in the demo."),
  notes: msg("Writing notes is turned off in the demo."),
  text: msg("Typing free text is turned off in the demo."),
  upload: msg("Uploading files is turned off in the demo."),
  import: msg("Importing is turned off in the demo."),
  settings: msg("Saving settings is turned off in the demo."),
  gmail: msg("The demo has no Gmail connected, so this is turned off."),
  profile: msg("Rebuilding the CV profile is turned off in the demo."),
  delete: msg("Deleting data is turned off in the demo."),
};

export type DemoReason = keyof typeof DEMO_REASON;

/** What the visitor sees when the server refuses a request the page let through. */
export const DEMO_READ_ONLY_MESSAGE = msg("That is turned off in the demo. Nothing was changed.");

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
    <Tooltip title={t(DEMO_REASON[reason])}>
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
