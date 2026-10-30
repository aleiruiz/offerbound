import type { ApplicationStatus, EmailCategory, InterviewKind } from "@offerbound/contracts";
import {
  ApplicationStatusSchema,
  EmailCategorySchema,
  InterviewKindSchema,
} from "@offerbound/contracts";
import { describe, expect, it } from "vitest";
import { decideTransition, targetStatusFor } from "./status.js";

type Cell = "apply" | "none" | "review";
type Target = "applied" | "screening" | "assessment" | "interviewing" | "offer" | "rejected";

const TARGETS: readonly Target[] = [
  "applied",
  "screening",
  "assessment",
  "interviewing",
  "offer",
  "rejected",
];

const ok: Cell = "apply";
const no: Cell = "none";
const rv: Cell = "review";

/** TECHNICAL_SPEC §6.3 matrix, transcribed row by row: ✓ = apply, · = none, R = review. */
const MATRIX: Record<ApplicationStatus, readonly [Cell, Cell, Cell, Cell, Cell, Cell]> = {
  //           applied screening assessment interviewing offer rejected
  applied: [no, ok, ok, ok, ok, ok],
  screening: [no, no, ok, ok, ok, ok],
  assessment: [no, no, no, ok, ok, ok],
  interviewing: [no, no, no, no, ok, ok],
  offer: [no, no, no, no, no, rv],
  accepted: [no, no, no, no, no, no],
  rejected: [rv, rv, rv, rv, rv, no],
  withdrawn: [no, no, no, no, no, no],
  abandoned: [ok, ok, ok, ok, ok, ok],
};

describe("decideTransition: full §6.3 matrix", () => {
  const cases = ApplicationStatusSchema.options.flatMap((current) =>
    TARGETS.map((target, i) => ({ current, target, expected: MATRIX[current][i] })),
  );

  it("covers every current status and all six targets (54 cells)", () => {
    expect(Object.keys(MATRIX).sort()).toEqual([...ApplicationStatusSchema.options].sort());
    expect(cases).toHaveLength(9 * 6);
  });

  it.each(cases)("$current + $target -> $expected", ({ current, target, expected }) => {
    expect(decideTransition(current, target)).toBe(expected);
  });
});

describe("decideTransition: extra cases", () => {
  it("reopens an abandoned application when the email implies no status", () => {
    expect(decideTransition("abandoned", null)).toBe("reopen");
  });

  it("does nothing for a null target on every other status", () => {
    for (const current of ApplicationStatusSchema.options) {
      if (current === "abandoned") continue;
      expect(decideTransition(current, null)).toBe("none");
    }
  });

  it("never changes accepted or withdrawn automatically, whatever the target", () => {
    for (const current of ["accepted", "withdrawn"] as const) {
      for (const target of [...ApplicationStatusSchema.options, null]) {
        expect(decideTransition(current, target)).toBe("none");
      }
    }
  });

  it("does nothing when the target equals the current status", () => {
    for (const status of TARGETS) {
      expect(decideTransition(status, status)).toBe("none");
    }
  });

  it("treats targets that are not automatic outcomes as no change", () => {
    // accepted, withdrawn and abandoned are manual-only; targetStatusFor never yields them.
    for (const current of [
      "applied",
      "screening",
      "assessment",
      "interviewing",
      "offer",
    ] as const) {
      for (const target of ["accepted", "withdrawn", "abandoned"] as const) {
        expect(decideTransition(current, target)).toBe("none");
      }
    }
  });
});

describe("targetStatusFor", () => {
  it.each([
    ["application_confirmation", "applied"],
    ["assessment", "assessment"],
    ["offer", "offer"],
    ["rejection", "rejected"],
  ] as const)("%s -> %s regardless of interview kind", (category, expected) => {
    expect(targetStatusFor(category, null)).toBe(expected);
    for (const kind of InterviewKindSchema.options) {
      expect(targetStatusFor(category, kind)).toBe(expected);
    }
  });

  it("maps an interview invite with kind recruiter_screen to screening", () => {
    expect(targetStatusFor("interview_invite", "recruiter_screen")).toBe("screening");
  });

  it("maps an interview invite with any other kind to interviewing", () => {
    for (const kind of InterviewKindSchema.options) {
      if (kind === "recruiter_screen") continue;
      expect(targetStatusFor("interview_invite", kind)).toBe("interviewing");
    }
  });

  it("maps an interview invite with no kind to interviewing", () => {
    expect(targetStatusFor("interview_invite", null)).toBe("interviewing");
  });

  it("gives no status change for the categories that carry none", () => {
    const none: EmailCategory[] = [
      "interview_reschedule",
      "interview_cancellation",
      "status_update_other",
      "candidate_outbound",
      "recruiter_outreach",
    ];
    const kinds: (InterviewKind | null)[] = [null, ...InterviewKindSchema.options];
    for (const category of none) {
      for (const kind of kinds) {
        expect(targetStatusFor(category, kind)).toBeNull();
      }
    }
  });

  it("gives no status change for job_alert and not_job_related (not about an application)", () => {
    expect(targetStatusFor("job_alert", null)).toBeNull();
    expect(targetStatusFor("not_job_related", null)).toBeNull();
  });

  it("answers for every category", () => {
    for (const category of EmailCategorySchema.options) {
      expect(() => targetStatusFor(category, null)).not.toThrow();
    }
  });
});
