import { useEffect } from "react";
import { useLocation } from "react-router";
import { msg } from "../i18n";
import { NAV_ITEMS } from "./nav";

/**
 * Where "back" from a record leads. An application opened from Today or Leads should return
 * there, not to the Applications list; an application opened from a filtered list should return
 * to that filter. The shell records the last top-level page visited (a destination's own path,
 * with its query); a reload forgets it and back falls to the destination's list.
 */

export interface Origin {
  /** Path and query of the page, as a link target. */
  to: string;
  /** The page's name in the navigation, an English message key: show it through `t()`. */
  label: string;
}

let lastTopLevel: Origin | null = null;

/** The top-level page for a path, or undefined for a record, a sub-page or anything else. */
export function topLevelPage(pathname: string): Origin | undefined {
  if (pathname === "/") return { to: "/today", label: msg("Today") };
  const item = NAV_ITEMS.find((nav) => pathname === nav.prefix);
  return item ? { to: item.prefix, label: item.label } : undefined;
}

/** Records each top-level page the owner visits; called once, by the shell. */
export function useTrackOrigin(): void {
  const { pathname, search } = useLocation();
  useEffect(() => {
    const page = topLevelPage(pathname);
    if (page) lastTopLevel = { to: `${page.to}${search}`, label: page.label };
  }, [pathname, search]);
}

/** Where back from an application leads: the last top-level page, or the Applications list. */
export function applicationOrigin(): Origin {
  return lastTopLevel ?? { to: "/applications", label: msg("Applications") };
}

/**
 * The parent of a sub-page, for the phone top bar's back button, or undefined on a top-level
 * page (the bottom navigation is the way out of those).
 */
export function parentOf(pathname: string): Origin | undefined {
  if (topLevelPage(pathname)) return undefined;
  if (pathname.startsWith("/applications/")) return applicationOrigin();
  if (pathname.startsWith("/leads/")) return { to: "/leads", label: msg("Leads") };
  if (pathname.startsWith("/settings/")) return { to: "/settings", label: msg("Settings") };
  return undefined;
}

/** Test hook: forget the recorded page. */
export function resetOrigin(): void {
  lastTopLevel = null;
}
