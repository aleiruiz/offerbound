import type { GmailMessage, Prisma, ReviewItem as ReviewItemRow } from "@prisma/client";
import type {
  MessageSummary,
  OperationPreview,
  ReviewItem as ReviewItemDto,
} from "@offerbound/contracts";
import type { ChangePlan } from "@offerbound/domain";

/**
 * The `ReviewItem` DTO (TECHNICAL_SPEC §10.2) and the plain-language preview of a stored plan
 * (AC-5.1). The queue's own routes and Today's review preview both map rows through
 * {@link toReviewItemDto}. Nothing here logs: the rows hold email-derived text.
 */

/** The `include` that gives a {@link ReviewRow}: the source email and the company the item is about. */
export const REVIEW_ITEM_INCLUDE = {
  message: {
    select: {
      id: true,
      internalDate: true,
      direction: true,
      fromName: true,
      fromEmail: true,
      subject: true,
      summary: true,
      category: true,
    },
  },
  company: { select: { name: true } },
} as const satisfies Prisma.ReviewItemInclude;

/** A review item with the columns {@link toReviewItemDto} reads. `company` may be left out. */
export type ReviewRow = ReviewItemRow & {
  message: Pick<
    GmailMessage,
    | "id"
    | "internalDate"
    | "direction"
    | "fromName"
    | "fromEmail"
    | "subject"
    | "summary"
    | "category"
  > | null;
  company?: { name: string } | null;
};

const iso = (date: Date): string => date.toISOString();

const STATUS_LABEL: Record<string, string> = {
  applied: "Applied",
  screening: "Screening",
  assessment: "Assessment",
  interviewing: "Interviewing",
  offer: "Offer",
  accepted: "Accepted",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
  abandoned: "Abandoned",
};

const statusLabel = (status: string): string => STATUS_LABEL[status] ?? status;

const INTERVIEW_LABEL: Record<string, string> = {
  recruiter_screen: "recruiter screen",
  hiring_manager: "hiring manager interview",
  technical: "technical interview",
  system_design: "system design interview",
  behavioral: "behavioral interview",
  take_home_review: "take-home review",
  onsite_loop: "onsite interviews",
  other: "interview",
};

function describeInterview(op: { fields?: { kind?: unknown; startsAt?: unknown } }): string {
  const kind = typeof op.fields?.kind === "string" ? op.fields.kind : "other";
  const label = INTERVIEW_LABEL[kind] ?? "interview";
  const startsAt = op.fields?.startsAt;
  const when = typeof startsAt === "string" || startsAt instanceof Date ? new Date(startsAt) : null;
  return when !== null && !Number.isNaN(when.getTime())
    ? `${label} on ${when.toISOString().slice(0, 16).replace("T", " ")} UTC`
    : label;
}

type LooseOp = Record<string, unknown> & { op: string };

function previewOperation(op: LooseOp): OperationPreview | null {
  switch (op.op) {
    case "create_company": {
      const company = op.company as { name?: unknown } | undefined;
      const name = typeof company?.name === "string" ? company.name : "a company";
      return { entity: "company", action: "create", summary: `Would add the company ${name}.` };
    }
    case "create_contact": {
      const who =
        typeof op.name === "string" && op.name !== ""
          ? op.name
          : typeof op.email === "string"
            ? op.email
            : "";
      return {
        entity: "contact",
        action: "create",
        summary: `Would save ${who === "" ? "the sender" : who} as a contact.`,
      };
    }
    case "create_application": {
      const title = typeof op.title === "string" ? op.title : "a role";
      return {
        entity: "application",
        action: "create",
        summary: `Would create the application for ${title} as ${statusLabel(String(op.status))}.`,
      };
    }
    case "convert_lead":
      return {
        entity: "application",
        action: "create",
        summary: `Would turn the lead into an application as ${statusLabel(String(op.status))}.`,
      };
    case "update_application": {
      const set = (op.set ?? {}) as { status?: unknown };
      return {
        entity: "application",
        action: "update",
        summary:
          typeof set.status === "string"
            ? `Would change the status to ${statusLabel(set.status)}.`
            : "Would record the email on the application.",
      };
    }
    case "upsert_interview": {
      const update = typeof op.interviewId === "string";
      return {
        entity: "interview",
        action: update ? "update" : "create",
        summary: `Would ${update ? "update the" : "add a"} ${describeInterview(op as never)}.`,
      };
    }
    case "cancel_interview":
      return { entity: "interview", action: "cancel", summary: "Would cancel an interview." };
    case "create_leads": {
      const count = Array.isArray(op.leads) ? op.leads.length : 0;
      return {
        entity: "lead",
        action: "create",
        summary: `Would add ${count} ${count === 1 ? "lead" : "leads"}.`,
      };
    }
    case "increment_daily_follow_ups":
      return {
        entity: "activity",
        action: "update",
        summary: "Would count one follow-up today.",
      };
    // Bookkeeping the owner has no decision about.
    case "link_thread":
    case "attach_message":
      return null;
    default:
      return null;
  }
}

/**
 * The owner-facing question and the change list for a stored plan. Reads a plan as it comes back
 * from JSON (dates are strings), so it checks the shape it uses rather than trusting the type.
 */
export function describePlan(plan: ChangePlan): {
  description: string;
  operations: OperationPreview[];
} {
  const operations = (Array.isArray(plan.operations) ? plan.operations : []).flatMap((op) =>
    typeof op === "object" && op !== null ? (previewOperation(op as LooseOp) ?? []) : [],
  );
  const first = Array.isArray(plan.events) ? plan.events[0] : undefined;
  const summary = typeof first?.summary === "string" ? first.summary : null;
  return {
    description: summary === null ? "Is this change right?" : `${summary}. Is that right?`,
    operations,
  };
}

/** A stored `plan` column as a plan, or null when it is not one. */
function storedPlan(plan: unknown): ChangePlan | null {
  return typeof plan === "object" && plan !== null && "operations" in plan
    ? (plan as ChangePlan)
    : null;
}

function candidatesOf(value: unknown): { id: string; label: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((c: unknown) => {
    const candidate = c as { id?: unknown; label?: unknown } | null;
    return typeof candidate?.id === "string" && typeof candidate.label === "string"
      ? [{ id: candidate.id, label: candidate.label }]
      : [];
  });
}

/** The `reasons` code the apply stage gives an item for a message it could not apply. */
export const APPLY_FAILED = "apply_failed";

function questionFor(row: ReviewRow, plan: ChangePlan | null, candidates: { label: string }[]) {
  const reason = row.reasons[0];
  switch (row.kind) {
    case "low_confidence":
      return plan === null ? "Is this change right?" : describePlan(plan).description;
    case "ambiguous_match":
      return candidates.length > 0
        ? "Which application is this email about?"
        : "Is this email about a new application?";
    case "unexpected_transition":
      return reason ?? "This email implies an unexpected change of status.";
    case "possible_duplicate_company": {
      const names = candidates.map((c) => c.label).join(" or ");
      const own = row.company?.name ?? "this company";
      return names === ""
        ? `Is ${own} the same company as one you already have?`
        : `Is ${own} the same company as ${names}?`;
    }
    case "extraction_failed":
      // Neutral wording: an email that was read but could not be applied is not "unreadable".
      return row.reasons.includes(APPLY_FAILED)
        ? "Offerbound couldn't process this email."
        : "Offerbound couldn't read this email.";
    case "undone_change":
      return "You undid a change from this email.";
  }
}

function messageSummary(message: NonNullable<ReviewRow["message"]>): MessageSummary {
  return {
    id: message.id,
    internalDate: iso(message.internalDate),
    direction: message.direction,
    fromName: message.fromName,
    fromEmail: message.fromEmail,
    subject: message.subject,
    summary: message.summary,
    category: message.category,
  };
}

/** The `ReviewItem` DTO of a row loaded with {@link REVIEW_ITEM_INCLUDE} (or just `message`). */
export function toReviewItemDto(row: ReviewRow): ReviewItemDto {
  const plan = storedPlan(row.plan);
  const candidates = candidatesOf(row.candidates);
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    createdAt: iso(row.createdAt),
    confidence: row.confidence,
    message: row.message === null ? null : messageSummary(row.message),
    proposal: {
      description: questionFor(row, plan, candidates),
      operations: plan === null ? [] : describePlan(plan).operations,
    },
    candidates,
  };
}
