import { z } from "zod";

/**
 * What the owner already did in onboarding, kept in this browser so a reload or a new sign-in
 * reopens the page where it was left (DESIGN_SPEC §5.8). Only the steps the server cannot tell us
 * about matter much (the spreadsheet import), but the record holds every step the owner completed
 * or skipped. Storage can be blocked or hold anything, so every access is guarded.
 */
export const ONBOARDING_STORAGE_KEY = "offerbound.onboarding.v2";

export interface OnboardingProgress {
  completed: number[];
  skipped: number[];
}

const EMPTY: OnboardingProgress = { completed: [], skipped: [] };

/** Reads the record. Anything that is not a valid record is dropped and counts as no progress. */
export function readOnboardingProgress(stepCount: number): OnboardingProgress {
  try {
    const raw = window.localStorage.getItem(ONBOARDING_STORAGE_KEY);
    if (raw === null) return EMPTY;
    const index = z
      .number()
      .int()
      .min(0)
      .max(stepCount - 1);
    const parsed = z
      .object({ completed: z.array(index), skipped: z.array(index) })
      .safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    window.localStorage.removeItem(ONBOARDING_STORAGE_KEY);
  } catch {
    // unreadable storage or text that is not JSON: start from nothing
    try {
      window.localStorage.removeItem(ONBOARDING_STORAGE_KEY);
    } catch {
      // storage is blocked as well; nothing to drop
    }
  }
  return EMPTY;
}

export function writeOnboardingProgress(progress: OnboardingProgress): void {
  try {
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(progress));
  } catch {
    // storage is blocked: progress lasts until the page is closed
  }
}

export function clearOnboardingProgress(): void {
  try {
    window.localStorage.removeItem(ONBOARDING_STORAGE_KEY);
  } catch {
    // storage is blocked: nothing was kept
  }
}
