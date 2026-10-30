import type { ApplicationStatus, EmailCategory, InterviewKind } from "@offerbound/contracts";

/**
 * Status mapping and automatic transitions (TECHNICAL_SPEC §6.3; AC-4.1, AC-7.5).
 * Pure: manual status changes ignore this table.
 */

export type TransitionDecision = "apply" | "none" | "review" | "reopen";

/** Statuses an email can imply. Accepted, Withdrawn and Abandoned are never automatic targets. */
export type AutomaticTarget =
  "applied" | "screening" | "assessment" | "interviewing" | "offer" | "rejected";

/**
 * The status an email of this category implies, or null when it implies none.
 * An interview invite is Screening for a recruiter screen and Interviewing for any other kind
 * (including an unknown kind).
 */
export function targetStatusFor(
  category: EmailCategory,
  interviewKind: InterviewKind | null,
): ApplicationStatus | null {
  switch (category) {
    case "application_confirmation":
      return "applied";
    case "interview_invite":
      return interviewKind === "recruiter_screen" ? "screening" : "interviewing";
    case "assessment":
      return "assessment";
    case "offer":
      return "offer";
    case "rejection":
      return "rejected";
    case "interview_reschedule":
    case "interview_cancellation":
    case "status_update_other":
    case "candidate_outbound":
    case "recruiter_outreach":
    case "job_alert":
    case "not_job_related":
      return null;
  }
}

type Cell = "apply" | "none" | "review";

const A: Cell = "apply";
const N: Cell = "none";
const R: Cell = "review";

/** Column order of every row in {@link TRANSITIONS}. */
const TARGET_COLUMNS = [
  "applied",
  "screening",
  "assessment",
  "interviewing",
  "offer",
  "rejected",
] as const satisfies readonly AutomaticTarget[];

type Row = Readonly<Record<AutomaticTarget, Cell>>;

function row(cells: readonly [Cell, Cell, Cell, Cell, Cell, Cell]): Row {
  const [applied, screening, assessment, interviewing, offer, rejected] = cells;
  return { applied, screening, assessment, interviewing, offer, rejected };
}

/** TECHNICAL_SPEC §6.3 allowed automatic transitions: rows = current, columns = target. */
const TRANSITIONS: Readonly<Record<ApplicationStatus, Row>> = {
  //                 applied screening assessment interviewing offer rejected
  applied: row([N, A, A, A, A, A]),
  screening: row([N, N, A, A, A, A]),
  assessment: row([N, N, N, A, A, A]),
  interviewing: row([N, N, N, N, A, A]),
  offer: row([N, N, N, N, N, R]),
  accepted: row([N, N, N, N, N, N]),
  rejected: row([R, R, R, R, R, N]),
  withdrawn: row([N, N, N, N, N, N]),
  abandoned: row([A, A, A, A, A, A]),
};

function isAutomaticTarget(status: ApplicationStatus): status is AutomaticTarget {
  return (TARGET_COLUMNS as readonly string[]).includes(status);
}

/**
 * What to do with an application in `current` when an email implies `target`.
 * - "apply": change the status automatically.
 * - "none": no status change (the email still lands on the timeline).
 * - "review": raise an "Unexpected status change" review item.
 * - "reopen": abandoned application, email implies no status; restore `status_before_abandon` (AC-7.5).
 */
export function decideTransition(
  current: ApplicationStatus,
  target: ApplicationStatus | null,
): TransitionDecision {
  if (target === null) return current === "abandoned" ? "reopen" : "none";
  if (!isAutomaticTarget(target)) return "none";
  return TRANSITIONS[current][target];
}
