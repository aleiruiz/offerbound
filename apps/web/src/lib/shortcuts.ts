import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useNavigate } from "react-router";

/**
 * Keyboard shortcuts (DESIGN_SPEC §9.3). They never fire while the owner is typing in a field,
 * with a modifier held, or inside a dialog; each has a visible button that does the same.
 */

/** True when the key press belongs to a text field rather than to a shortcut. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  // jsdom has no `isContentEditable`, so the attribute is checked as well.
  return (
    (target as HTMLElement).isContentEditable === true ||
    target.closest('[contenteditable=""], [contenteditable="true"]') !== null
  );
}

function ignoreKey(e: KeyboardEvent): boolean {
  return (
    e.defaultPrevented ||
    e.ctrlKey ||
    e.metaKey ||
    e.altKey ||
    isTypingTarget(e.target) ||
    (e.target instanceof Element && e.target.closest('[role="dialog"]') !== null)
  );
}

// --- Shortcut dialog state, shared by `?` and any button that opens the dialog ---

let dialogOpen = false;
const dialogListeners = new Set<() => void>();

export function setShortcutDialogOpen(open: boolean): void {
  if (dialogOpen === open) return;
  dialogOpen = open;
  dialogListeners.forEach((listener) => listener());
}

export function useShortcutDialogOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      dialogListeners.add(listener);
      return () => dialogListeners.delete(listener);
    },
    () => dialogOpen,
    () => false,
  );
}

// --- Go to ---

export const GO_SHORTCUTS: Record<string, string> = {
  t: "/today",
  a: "/applications",
  l: "/leads",
  i: "/interviews",
  r: "/review",
};

const CHORD_TIMEOUT_MS = 1500;

/** `g` then `t`/`a`/`l`/`i`/`r` navigates; `?` opens the shortcut dialog. Needs a router. */
export function useGlobalShortcuts(): void {
  const navigate = useNavigate();
  useEffect(() => {
    let waiting = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopWaiting = () => {
      waiting = false;
      clearTimeout(timer);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (ignoreKey(e)) return;
      if (waiting) {
        stopWaiting();
        const destination = GO_SHORTCUTS[e.key];
        if (destination) {
          e.preventDefault();
          void navigate(destination);
        }
        return;
      }
      if (e.key === "g") {
        waiting = true;
        timer = setTimeout(stopWaiting, CHORD_TIMEOUT_MS);
      } else if (e.key === "?") {
        e.preventDefault();
        setShortcutDialogOpen(true);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      stopWaiting();
    };
  }, [navigate]);
}

// --- Lists ---

export interface ListKeyboardHandlers<T> {
  onOpen: (item: T) => void;
  /** Extra single-key actions on the focused row, for example `{ s: shortlist, d: dismiss }`. */
  keys?: Record<string, (item: T) => void>;
}

/**
 * `j`/`k` move the focused row, ↓/↑ do the same from inside a row, `Enter` opens it and any key in
 * `keys` acts on it. Spread `getRowProps(i)` on each row element.
 */
export function useListKeyboard<T>(
  items: T[],
  handlers: ListKeyboardHandlers<T>,
): { focusedIndex: number; getRowProps: (i: number) => object } {
  const [focused, setFocused] = useState(-1);
  const focusedIndex = Math.min(focused, items.length - 1);
  const rows = useRef(new Map<number, HTMLElement>());
  const latest = useRef({ items, focusedIndex, handlers });
  useLayoutEffect(() => {
    latest.current = { items, focusedIndex, handlers };
  });

  const move = useCallback((delta: number) => {
    const { items: current, focusedIndex: from } = latest.current;
    if (current.length === 0) return;
    const next = Math.max(
      0,
      Math.min(current.length - 1, from < 0 && delta < 0 ? 0 : from + delta),
    );
    setFocused(next);
    const el = rows.current.get(next);
    el?.focus();
    el?.scrollIntoView?.({ block: "nearest" });
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (ignoreKey(e)) return;
      const { items: current, focusedIndex: index, handlers: h } = latest.current;
      if (e.key === "j") {
        e.preventDefault();
        move(1);
      } else if (e.key === "k") {
        e.preventDefault();
        move(-1);
      } else if (e.key === "Enter") {
        // Only when nothing else has focus; Enter on a button or link belongs to that control.
        const item = current[index];
        if (e.target === document.body && item !== undefined) {
          e.preventDefault();
          h.onOpen(item);
        }
      } else {
        const action = h.keys?.[e.key];
        const item = current[index];
        if (action && item !== undefined) {
          e.preventDefault();
          action(item);
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [move]);

  const getRowProps = (i: number) => ({
    ref: (el: HTMLElement | null) => {
      if (el) rows.current.set(i, el);
      else rows.current.delete(i);
    },
    tabIndex: i === Math.max(focusedIndex, 0) ? 0 : -1,
    "data-list-row": "",
    "aria-current": i === focusedIndex ? ("true" as const) : undefined,
    onFocus: () => setFocused(i),
    onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        move(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        move(-1);
      } else if (e.key === "Enter" && e.target === e.currentTarget) {
        const item = latest.current.items[i];
        if (item !== undefined) {
          e.preventDefault();
          latest.current.handlers.onOpen(item);
        }
      }
    },
  });

  return { focusedIndex, getRowProps };
}
