import Button from "@mui/material/Button";
import Snackbar, { type SnackbarCloseReason } from "@mui/material/Snackbar";
import SnackbarContent from "@mui/material/SnackbarContent";
import { useEffect, useSyncExternalStore } from "react";
import { ApiClientError } from "../api/client";

const AUTO_HIDE_MS = 6000;

interface SnackState {
  id: number;
  open: boolean;
  message: string;
  onUndo: (() => Promise<void>) | undefined;
  /** An alert interrupts the screen reader; a status waits for a pause. */
  tone: "status" | "alert";
}

let state: SnackState = { id: 0, open: false, message: "", onUndo: undefined, tone: "status" };
const listeners = new Set<() => void>();

function set(next: Partial<SnackState>): void {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

function show(message: string, onUndo?: () => Promise<void>, tone: SnackState["tone"] = "status") {
  set({ id: state.id + 1, open: true, message, onUndo, tone });
}

const handle = {
  show: (message: string, onUndo?: () => Promise<void>) => show(message, onUndo),
  alert: (message: string) => show(message, undefined, "alert"),
};

/**
 * `show("Marked as applied", undo)` raises the snackbar for 6 seconds; `alert` is the same for a
 * failure. Mount `<UndoSnackbar />` once.
 */
export function useUndoSnackbar(): {
  show: (message: string, onUndo?: () => Promise<void>) => void;
  alert: (message: string) => void;
} {
  return handle;
}

const CHANGED_ELSEWHERE = "Can't undo: changes were made elsewhere. Reload to see the latest.";
const CANNOT_UNDO = "Can't undo: this application changed after the update. Edit it directly.";

async function runUndo(onUndo: () => Promise<void>): Promise<void> {
  set({ open: false });
  try {
    await onUndo();
    show("Undone");
  } catch (error) {
    if (error instanceof ApiClientError && error.code === "changed_since") {
      show(CANNOT_UNDO, undefined, "alert");
    } else if (error instanceof ApiClientError && error.code === "version_conflict") {
      show(CHANGED_ELSEWHERE, undefined, "alert");
    } else {
      show("Couldn't undo this change.", onUndo, "alert");
    }
  }
}

/** The dark snackbar of DESIGN_SPEC §6.5: one text action, usually *Undo*, hidden after 6 seconds. */
export function UndoSnackbar() {
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => state,
  );
  // A message left over from a previous screen must not reappear when the host remounts.
  useEffect(() => () => set({ open: false }), []);

  const close = (_event: unknown, reason?: SnackbarCloseReason) => {
    if (reason === "clickaway") return;
    set({ open: false });
  };
  const { onUndo } = current;

  return (
    <Snackbar
      key={current.id}
      open={current.open}
      autoHideDuration={AUTO_HIDE_MS}
      onClose={close}
      sx={{ bottom: { xs: 80, sm: 24 } }}
    >
      <SnackbarContent
        role={current.tone === "alert" ? "alert" : "status"}
        message={current.message}
        action={
          onUndo ? (
            <Button
              size="small"
              onClick={() => void runUndo(onUndo)}
              sx={(theme) => ({ color: theme.palette.tokens.routeOnInk })}
            >
              Undo
            </Button>
          ) : undefined
        }
      />
    </Snackbar>
  );
}
