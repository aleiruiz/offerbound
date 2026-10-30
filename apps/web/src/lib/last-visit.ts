import { useEffect, useState } from "react";

/**
 * "Newly fetched" leads (DESIGN_SPEC §6.4): a lead found after the owner's previous visit to the
 * Leads page on this device. The time of that visit lives in localStorage; no value (the first
 * visit ever, or blocked storage) means nothing is new.
 */

export const LEADS_SEEN_KEY = "ob.leadsSeenAt";

/** The stored time of the previous visit, in ms since the epoch, or null when there is none. */
export function readLeadsSeenAt(): number | null {
  try {
    const value = window.localStorage.getItem(LEADS_SEEN_KEY);
    if (value === null) return null;
    const at = Date.parse(value);
    return Number.isNaN(at) ? null : at;
  } catch {
    return null;
  }
}

function writeLeadsSeenAt(at: Date): void {
  try {
    window.localStorage.setItem(LEADS_SEEN_KEY, at.toISOString());
  } catch {
    // storage is blocked: nothing is highlighted next time
  }
}

/** True when the lead was found after `since`. No `since` means nothing is new. */
export function isFoundSince(foundAt: string, since: number | null): boolean {
  return since !== null && Date.parse(foundAt) > since;
}

/**
 * The "since" mark for this visit: the stored time of the previous visit, read once and kept
 * fixed while the page is open, so highlights stay while the owner works. With `markSeen` the
 * page then stores the current time for the next visit; Today only reads.
 */
export function useLeadsSince({ markSeen }: { markSeen: boolean }): number | null {
  const [since] = useState(readLeadsSeenAt);
  useEffect(() => {
    if (markSeen) writeLeadsSeenAt(new Date());
  }, [markSeen]);
  return since;
}
