import { DateTime } from "luxon";
import type {
  ApplicationStatus,
  EmailCategory,
  EventType,
  Extraction,
  IcsEvent,
  InterviewKind,
  InterviewStatus,
  LeadStatus,
  ReviewKind,
} from "@offerbound/contracts";
import { bareAddress, isAtsSender, JOB_BOARD_DOMAINS, registrableDomain } from "./domains.js";
import {
  resolveCompany,
  type CompanyIndex,
  type CompanyResolution,
  type NewCompany,
} from "./company.js";
import type { IncomingLead } from "./intake.js";
import { planInterviewUpsert } from "./interview-upsert.js";
import { jobKey } from "./job-key.js";
import {
  matchApplication,
  type Candidate,
  type MatchResult,
  type MatchSnapshot,
} from "./matching.js";
import { decideTransition, targetStatusFor } from "./status.js";
import { ownerLocalDay } from "./time.js";

/**
 * Change plans (TECHNICAL_SPEC §6.5; AC-4.1, 4.2, 4.5, 7.3–7.5, 8.1, 8.2; journeys J2, J3).
 * `planChanges` is pure: the worker loads a snapshot, calls it, then executes the plan or stores
 * it in a review item. Resolving that item calls it again with the owner's choice.
 */

/** An existing record by id, or one the same plan creates by ref ("new:company", "new:application", …). */
export type EntityRef = { id: string } | { ref: string };

export type ApplicationSet = Partial<{
  status: ApplicationStatus;
  statusBeforeAbandon: ApplicationStatus | null;
  lastCompanyActivityAt: Date;
  lastOutboundAt: Date;
  followUpDue: boolean;
  followUpDueSince: Date | null;
  followUpDoneAt: Date;
}>;

export type InterviewFields = {
  kind: InterviewKind;
  status: InterviewStatus;
  startsAt: Date | null;
  endsAt: Date | null;
  timezoneHint: string | null;
  meetingUrl: string | null;
  schedulingUrl: string | null;
  location: string | null;
  interviewers: string[];
  icsUid: string | null;
};

export type Operation =
  | { op: "create_company"; ref: string; company: NewCompany }
  | {
      op: "create_contact";
      ref: string;
      email: string;
      name: string | null;
      title: string | null;
      isAgency: boolean;
      company: EntityRef | null;
    }
  | {
      op: "create_application";
      ref: string;
      company: EntityRef;
      title: string;
      jobUrl: string | null;
      jobKey: string | null;
      status: ApplicationStatus;
      appliedAt: Date | null;
      lastCompanyActivityAt: Date | null;
      source: "gmail";
    }
  | {
      op: "convert_lead";
      leadId: string;
      expectedVersion: number;
      applicationRef: string;
      status: ApplicationStatus;
      /** Set only when the email is an application confirmation, like `create_application.appliedAt`. */
      appliedAt: Date | null;
    }
  | {
      op: "update_application";
      application: EntityRef;
      expectedVersion: number | null;
      set: ApplicationSet;
    }
  | {
      op: "upsert_interview";
      application: EntityRef;
      interviewId: string | null;
      expectedVersion: number | null;
      ref: string;
      fields: InterviewFields;
    }
  | { op: "cancel_interview"; interviewId: string; expectedVersion: number }
  | { op: "create_leads"; source: "gmail_alert" | "gmail_recruiter"; leads: IncomingLead[] }
  | { op: "link_thread"; threadId: string; application: EntityRef | null; leadRef: string | null }
  | { op: "attach_message"; application: EntityRef }
  | { op: "increment_daily_follow_ups"; day: string };

/**
 * One timeline event for one affected record. When the event changes an application's status,
 * `data` carries `fromStatus` (when there was one) and `toStatus` so the API can fill the timeline
 * entry's `toStatus` for every status-bearing event: `application_created`, `lead_converted`,
 * `status_changed` and `reopened`.
 */
export type PlannedEvent = {
  subject: EntityRef;
  subjectType: "application" | "lead";
  type: EventType;
  summary: string;
  data: Record<string, unknown> | null;
};

/**
 * What the planner proposes for one message. When `autoApply` is false, `operations`, `events` and
 * `notices` are a proposal for display in the review item only: the executor must not run them
 * until the owner decides (the owner's choice produces a new plan with `autoApply` true).
 */
export type ChangePlan = {
  operations: Operation[];
  events: PlannedEvent[];
  autoApply: boolean;
  confidence: number;
  review: { kind: ReviewKind; reasons: string[]; candidates: Candidate[] } | null;
  notices: { kind: "possible_duplicate_company"; company: EntityRef; candidates: Candidate[] }[];
  messageOutcome: "applied" | "triaged_out";
};

export type InterviewRef = {
  id: string;
  version: number;
  kind: InterviewKind;
  status: InterviewStatus;
  startsAt: Date | null;
  icsUid: string | null;
};

export type PlanSnapshot = MatchSnapshot & {
  companyIndex: CompanyIndex;
  applicationState: ReadonlyMap<
    string,
    {
      version: number;
      status: ApplicationStatus;
      statusBeforeAbandon: ApplicationStatus | null;
      followUpDue: boolean;
      lastCompanyActivityAt: Date | null;
    }
  >;
  /** Version and status of every lead the plan may convert (a lead matched by thread, job key or role). */
  leadState: ReadonlyMap<string, { version: number; status: LeadStatus }>;
  /** By application id. */
  interviews: ReadonlyMap<string, InterviewRef[]>;
  ownerTimezone: string;
};

export type PlanMessage = {
  id: string;
  threadId: string;
  internalDate: Date;
  direction: "inbound" | "outbound";
  fromEmail: string | null;
  icsEvents: IcsEvent[];
};

export type OwnerChoice =
  | { action: "attach"; applicationId: string }
  | { action: "create_new" }
  | { action: "apply" }
  | { action: "edit_apply"; edits: Partial<Extraction> }
  | { action: "reopen" }
  | { action: "timeline_only" };

// ---------------------------------------------------------------------------------------------

const NEW_COMPANY = "new:company";
const NEW_CONTACT = "new:contact";
const NEW_APPLICATION = "new:application";

const STATUS_LABEL: Record<ApplicationStatus, string> = {
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

/** Categories that create an application when nothing matches (TECHNICAL_SPEC §6.4 rule 4). */
const CREATING: readonly EmailCategory[] = [
  "application_confirmation",
  "rejection",
  "interview_invite",
  "assessment",
  "offer",
];

type Condition = { kind: ReviewKind; reason: string; candidates: Candidate[] };

type Part = {
  operations: Operation[];
  events: PlannedEvent[];
  notices: ChangePlan["notices"];
  conditions: Condition[];
};

type Ctx = {
  s: PlanSnapshot;
  m: PlanMessage;
  e: Extraction;
  choice: OwnerChoice | undefined;
};

const emptyPart = (): Part => ({ operations: [], events: [], notices: [], conditions: [] });

function parseInstant(value: string | null): Date | null {
  if (value === null) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatLocal(instant: Date, tz: string): string {
  return DateTime.fromJSDate(instant, { zone: tz })
    .setLocale("en-US")
    .toFormat("ccc, LLL d, HH:mm");
}

/** A percentage floored to `digits` decimals, so a value below a threshold never reads as equal to it. */
function percent(value: number, digits = 0): string {
  const scale = 10 ** digits;
  // The epsilon absorbs binary noise such as 0.29 * 100 = 28.999999999999996.
  return `${Math.floor(value * 100 * scale + 1e-9) / scale}%`;
}

/** Both percentages for a "below the threshold" reason, with a decimal only when whole numbers tie. */
function percentPair(confidence: number, threshold: number): [string, string] {
  const whole: [string, string] = [percent(confidence), percent(threshold)];
  return whole[0] === whole[1] ? [percent(confidence, 2), percent(threshold, 2)] : whole;
}

function companyNameById(s: PlanSnapshot, companyId: string): string {
  return s.companies.find((c) => c.id === companyId)?.name ?? "the company";
}

function statusSummary(status: ApplicationStatus, company: string): string {
  return status === "rejected" ? `Rejected by ${company}` : `Moved to ${STATUS_LABEL[status]}`;
}

/** The status a new application gets: what the email implies, else a sensible start. */
function startingStatus(e: Extraction): ApplicationStatus {
  const implied = targetStatusFor(e.category, e.interview?.kind ?? null);
  if (implied !== null) return implied;
  if (e.category === "interview_reschedule" || e.category === "interview_cancellation") {
    return e.interview?.kind === "recruiter_screen" ? "screening" : "interviewing";
  }
  return "applied";
}

function applyEdits(e: Extraction, choice: OwnerChoice | undefined): Extraction {
  return choice?.action === "edit_apply" ? { ...e, ...choice.edits } : e;
}

// --- contacts ---------------------------------------------------------------------------------

function contactOps(c: Ctx, company: EntityRef | null): Operation[] {
  const { s, m, e } = c;
  const contact = e.contact;
  if (m.direction !== "inbound" || contact?.email == null) return [];
  const email = bareAddress(contact.email);
  if (email === "" || !email.includes("@")) return [];
  if (s.companyIndex.contacts.some((k) => bareAddress(k.email) === email)) return [];
  const domain = registrableDomain(email);
  // An ATS or job-board address would otherwise route every later email from that system here.
  if (isAtsSender(email) || (domain !== null && JOB_BOARD_DOMAINS.includes(domain))) return [];
  return [
    {
      op: "create_contact",
      ref: NEW_CONTACT,
      email,
      name: contact.name,
      title: contact.title,
      isAgency: contact.isAgency,
      company: contact.isAgency ? null : company,
    },
  ];
}

// --- interviews -------------------------------------------------------------------------------

function interviewEvent(
  op: Operation,
  existing: InterviewRef[],
  application: EntityRef,
  tz: string,
): PlannedEvent | null {
  if (op.op === "cancel_interview") {
    return {
      subject: application,
      subjectType: "application",
      type: "interview_cancelled",
      summary: "Interview cancelled",
      data: { interviewId: op.interviewId },
    };
  }
  if (op.op !== "upsert_interview") return null;
  const when = op.fields.startsAt === null ? null : formatLocal(op.fields.startsAt, tz);
  const previous =
    op.interviewId === null ? undefined : existing.find((i) => i.id === op.interviewId);
  const data = { interview: op.interviewId ?? op.ref };
  if (previous === undefined) {
    return {
      subject: application,
      subjectType: "application",
      type: "interview_created",
      summary: when === null ? "Interview to schedule" : `Interview scheduled for ${when}`,
      data,
    };
  }
  let summary: string;
  if (when === null) summary = "Interview needs a new time";
  else if (
    previous.status === "scheduled" &&
    previous.startsAt?.getTime() !== op.fields.startsAt?.getTime()
  ) {
    summary = `Interview rescheduled to ${when}`;
  } else if (previous.status === "scheduled") summary = "Interview updated";
  else summary = `Interview scheduled for ${when}`;
  return {
    subject: application,
    subjectType: "application",
    type: "interview_updated",
    summary,
    data,
  };
}

function interviewPart(
  c: Ctx,
  existing: InterviewRef[],
  application: EntityRef,
): { operations: Operation[]; events: PlannedEvent[] } {
  const op = planInterviewUpsert(existing, c.e, c.m.icsEvents, c.e.category, application);
  if (op === null) return { operations: [], events: [] };
  const event = interviewEvent(op, existing, application, c.s.ownerTimezone);
  return { operations: [op], events: event === null ? [] : [event] };
}

// --- an existing application ------------------------------------------------------------------

function planForApplication(c: Ctx, applicationId: string): Part {
  const { s, m, e, choice } = c;
  const state = s.applicationState.get(applicationId);
  const app = s.applications.find((a) => a.id === applicationId);
  if (state === undefined || app === undefined) {
    throw new RangeError(`The snapshot has no state for application ${applicationId}`);
  }
  const part = emptyPart();
  const appRef: EntityRef = { id: applicationId };
  const company = companyNameById(s, app.companyId);
  const timelineOnly = choice?.action === "timeline_only";
  const forced =
    choice?.action === "apply" || choice?.action === "reopen" || choice?.action === "edit_apply";
  const set: ApplicationSet = {};
  const events: PlannedEvent[] = [];
  const operations: Operation[] = [];
  let fallbackEvent: PlannedEvent = {
    subject: appRef,
    subjectType: "application",
    type: "email_received",
    summary: `Email from ${company}`,
    data: null,
  };

  if (m.direction === "inbound") {
    const target = targetStatusFor(e.category, e.interview?.kind ?? null);
    let decision = decideTransition(state.status, target);
    if (timelineOnly) decision = "none";
    if (decision === "review" && target !== null) {
      if (forced) decision = "apply";
      else {
        part.conditions.push({
          kind: "unexpected_transition",
          reason: `${company} is ${STATUS_LABEL[state.status]}, and this email implies ${STATUS_LABEL[target]}`,
          candidates: [],
        });
      }
    }
    if ((decision === "apply" || decision === "review") && target !== null) {
      set.status = target;
      const wasAbandoned = state.status === "abandoned";
      if (wasAbandoned) set.statusBeforeAbandon = null;
      const reopened = wasAbandoned && target !== "rejected";
      events.push({
        subject: appRef,
        subjectType: "application",
        type: reopened ? "reopened" : "status_changed",
        summary: reopened ? `Reopened: ${company} replied` : statusSummary(target, company),
        data: { fromStatus: state.status, toStatus: target },
      });
    } else if (decision === "reopen") {
      const restored = state.statusBeforeAbandon ?? "applied";
      set.status = restored;
      set.statusBeforeAbandon = null;
      events.push({
        subject: appRef,
        subjectType: "application",
        type: "reopened",
        summary: `Reopened: ${company} replied`,
        data: { fromStatus: state.status, toStatus: restored },
      });
    }
    // The company clock only moves forward, and a reply clears the follow-up flag.
    const previous = state.lastCompanyActivityAt;
    if (previous === null || m.internalDate.getTime() > previous.getTime()) {
      set.lastCompanyActivityAt = m.internalDate;
    }
    set.followUpDue = false;
    set.followUpDueSince = null;

    if (!timelineOnly) {
      const interview = interviewPart(c, s.interviews.get(applicationId) ?? [], appRef);
      operations.push(...interview.operations);
      events.push(...interview.events);
    }
  } else {
    // Outbound mail never touches the company clock, the status or an abandoned application.
    set.lastOutboundAt = m.internalDate;
    if (state.followUpDue) {
      set.followUpDue = false;
      set.followUpDueSince = null;
      set.followUpDoneAt = m.internalDate;
      operations.push({
        op: "increment_daily_follow_ups",
        day: ownerLocalDay(m.internalDate, s.ownerTimezone),
      });
      fallbackEvent = {
        subject: appRef,
        subjectType: "application",
        type: "follow_up_done",
        summary: "Followed up by email",
        data: null,
      };
    } else {
      fallbackEvent = {
        subject: appRef,
        subjectType: "application",
        type: "email_sent",
        summary: `Email sent to ${company}`,
        data: null,
      };
    }
  }

  // One event per affected record: a plain email entry only when nothing more specific says it.
  if (events.length === 0) events.push(fallbackEvent);

  part.operations.push(
    ...contactOps(c, { id: app.companyId }),
    { op: "update_application", application: appRef, expectedVersion: state.version, set },
    ...operations,
  );
  if (s.threadLinks.get(m.threadId)?.applicationId !== applicationId) {
    part.operations.push({
      op: "link_thread",
      threadId: m.threadId,
      application: appRef,
      leadRef: null,
    });
  }
  part.operations.push({ op: "attach_message", application: appRef });
  part.events.push(...events);
  return part;
}

// --- a new application ---------------------------------------------------------------------------

function createdSummary(e: Extraction, status: ApplicationStatus, company: string): string {
  return e.category === "application_confirmation"
    ? `Application received by ${company}`
    : statusSummary(status, company);
}

/** Company a new application belongs to, with the operations that create it. */
function companyForNew(
  c: Ctx,
  resolution: CompanyResolution,
  lead: { companyId: string } | null,
): { ref: EntityRef; name: string; operations: Operation[]; notices: Part["notices"] } | null {
  const { s, m, e } = c;
  if (lead !== null) {
    return {
      ref: { id: lead.companyId },
      name: companyNameById(s, lead.companyId),
      operations: [],
      notices: [],
    };
  }
  if (resolution.kind === "existing") {
    return {
      ref: { id: resolution.companyId },
      name: companyNameById(s, resolution.companyId),
      operations: [],
      notices: [],
    };
  }
  if (resolution.kind === "none") return null;

  // An agency recruiter's own domain says nothing about the hiring company.
  let domains = resolution.company.domains;
  if (e.contact?.isAgency && m.fromEmail !== null) {
    const senderDomain = registrableDomain(m.fromEmail);
    domains = domains.filter((d) => d !== senderDomain || d === resolution.company.websiteDomain);
  }
  const ref: EntityRef = { ref: NEW_COMPANY };
  const notices: Part["notices"] =
    resolution.possibleDuplicateOf.length === 0
      ? []
      : [
          {
            kind: "possible_duplicate_company",
            company: ref,
            candidates: resolution.possibleDuplicateOf.map((id) => ({
              id,
              label: companyNameById(s, id),
            })),
          },
        ];
  return {
    ref,
    name: resolution.company.name,
    operations: [
      { op: "create_company", ref: NEW_COMPANY, company: { ...resolution.company, domains } },
    ],
    notices,
  };
}

function planCreate(c: Ctx, resolution: CompanyResolution, convertLeadId: string | null): Part {
  const { s, m, e } = c;
  const part = emptyPart();
  const leadVersion = convertLeadId === null ? undefined : s.leadState.get(convertLeadId);
  const convertible =
    convertLeadId !== null && leadVersion !== undefined && leadVersion.status !== "applied"
      ? s.leads.find((l) => l.id === convertLeadId)
      : undefined;

  const company = companyForNew(c, resolution, convertible ?? null);
  if (company === null) {
    part.conditions.push({
      kind: "ambiguous_match",
      reason: "No company could be identified from this email",
      candidates: [],
    });
    return part;
  }

  const status = startingStatus(e);
  const appRef: EntityRef = { ref: NEW_APPLICATION };
  part.operations.push(...company.operations, ...contactOps(c, company.ref));
  part.notices.push(...company.notices);

  if (convertible !== undefined && leadVersion !== undefined) {
    part.operations.push(
      {
        op: "convert_lead",
        leadId: convertible.id,
        expectedVersion: leadVersion.version,
        applicationRef: NEW_APPLICATION,
        status,
        appliedAt: e.category === "application_confirmation" ? m.internalDate : null,
      },
      {
        op: "update_application",
        application: appRef,
        expectedVersion: null,
        set: { lastCompanyActivityAt: m.internalDate },
      },
    );
    part.events.push({
      subject: appRef,
      subjectType: "application",
      type: "lead_converted",
      summary: createdSummary(e, status, company.name),
      data: { leadId: convertible.id, toStatus: status },
    });
  } else {
    part.operations.push({
      op: "create_application",
      ref: NEW_APPLICATION,
      company: company.ref,
      title: e.role?.title ?? "Role not stated",
      jobUrl: e.jobUrl,
      jobKey: e.jobUrl === null ? null : jobKey(e.jobUrl),
      status,
      appliedAt: e.category === "application_confirmation" ? m.internalDate : null,
      lastCompanyActivityAt: m.internalDate,
      source: "gmail",
    });
    part.events.push({
      subject: appRef,
      subjectType: "application",
      type: "application_created",
      summary: createdSummary(e, status, company.name),
      data: { toStatus: status },
    });
  }

  const interview = interviewPart(c, [], appRef);
  part.operations.push(...interview.operations);
  part.events.push(...interview.events);
  part.operations.push(
    { op: "link_thread", threadId: m.threadId, application: appRef, leadRef: null },
    { op: "attach_message", application: appRef },
  );
  return part;
}

// --- leads --------------------------------------------------------------------------------------

function incomingLeads(
  source: "gmail_alert" | "gmail_recruiter",
  e: Extraction,
  contactEmail: string | null,
  limit: number,
): IncomingLead[] {
  return e.leads.slice(0, limit).map((lead, order) => ({
    ref: `new:lead:${order}`,
    order,
    source,
    companyName: lead.company,
    companyDomain: null,
    title: lead.title,
    jobUrl: lead.jobUrl,
    locationText: lead.locationText,
    country: lead.country,
    workMode: lead.workMode,
    compensationText: lead.compensationText,
    sponsorshipText: null,
    postedAt: parseInstant(lead.postedAt),
    seniority: null,
    ranking: null,
    verification: null,
    pageExcerpt: null,
    sheetStatus: null,
    notes: null,
    contactEmail,
  }));
}

function planAlert(c: Ctx): Part {
  const part = emptyPart();
  const leads = incomingLeads("gmail_alert", c.e, null, c.e.leads.length);
  if (leads.length > 0) part.operations.push({ op: "create_leads", source: "gmail_alert", leads });
  return part;
}

function planRecruiterLead(c: Ctx): Part {
  const { m, e } = c;
  const part = emptyPart();
  const contactEmail = e.contact?.email == null ? null : bareAddress(e.contact.email);
  // A recruiter email without a structured lead still names a company and role of its own.
  const source: Extraction =
    e.leads.length > 0 || e.company === null || e.company.name.trim() === ""
      ? e
      : {
          ...e,
          leads: [
            {
              company: e.company.name,
              title: e.role?.title ?? "Role not stated",
              jobUrl: e.jobUrl,
              locationText: null,
              country: null,
              workMode: "unknown",
              compensationText: null,
              postedAt: null,
            },
          ],
        };
  const leads = incomingLeads("gmail_recruiter", source, contactEmail, 1);
  const [lead] = leads;
  if (lead === undefined) {
    part.conditions.push({
      kind: "low_confidence",
      reason: "No company or role could be read from this recruiter email",
      candidates: [],
    });
    return part;
  }
  part.operations.push(
    ...contactOps(c, null),
    { op: "create_leads", source: "gmail_recruiter", leads },
    { op: "link_thread", threadId: m.threadId, application: null, leadRef: lead.ref },
  );
  return part;
}

function planLeadThread(c: Ctx, leadId: string): Part {
  const lead = c.s.leads.find((l) => l.id === leadId);
  const name = lead === undefined ? "the company" : companyNameById(c.s, lead.companyId);
  const outbound = c.m.direction === "outbound";
  return {
    ...emptyPart(),
    events: [
      {
        subject: { id: leadId },
        subjectType: "lead",
        type: outbound ? "email_sent" : "email_received",
        summary: outbound ? `Email sent to ${name}` : `Email from ${name}`,
        data: null,
      },
    ],
  };
}

// --- assembly -------------------------------------------------------------------------------------

const KIND_PRIORITY: ReviewKind[] = ["ambiguous_match", "unexpected_transition", "low_confidence"];

function finish(part: Part, confidence: number, outcome: ChangePlan["messageOutcome"]): ChangePlan {
  const ranked = [...part.conditions].sort(
    (a, b) => KIND_PRIORITY.indexOf(a.kind) - KIND_PRIORITY.indexOf(b.kind),
  );
  const first = ranked[0];
  return {
    operations: part.operations,
    events: part.events,
    autoApply: first === undefined,
    confidence,
    review:
      first === undefined
        ? null
        : {
            kind: first.kind,
            reasons: ranked.map((r) => r.reason),
            candidates: ranked
              .filter((r) => r.kind === "ambiguous_match")
              .flatMap((r) => r.candidates),
          },
    notices: part.notices,
    messageOutcome: outcome,
  };
}

const triagedOut = (confidence: number): ChangePlan =>
  finish(emptyPart(), confidence, "triaged_out");

function resolveMatch(c: Ctx, company: CompanyResolution): MatchResult {
  const { s, m, e, choice } = c;
  const input = {
    threadId: m.threadId,
    jobKey: e.jobUrl === null ? null : jobKey(e.jobUrl),
    company,
    roleTitle: e.role?.title ?? null,
    category: e.category,
  };
  if (choice?.action === "attach") {
    return s.applicationState.has(choice.applicationId)
      ? { kind: "application", applicationId: choice.applicationId, via: "company" }
      : matchApplication(s, input);
  }
  if (choice?.action === "create_new") {
    // Matching as if no application existed finds the lead (if any) this email should convert.
    const fresh = matchApplication({ ...s, applications: [], threadLinks: new Map() }, input);
    return fresh.kind === "create" ? fresh : { kind: "create", convertLeadId: null };
  }
  return matchApplication(s, input);
}

export function planChanges(
  s: PlanSnapshot,
  m: PlanMessage,
  extraction: Extraction,
  settings: { autoApplyMinConfidence: number },
  choice?: OwnerChoice,
): ChangePlan {
  const e = applyEdits(extraction, choice);
  const confidence = e.confidence;
  const c: Ctx = { s, m, e, choice };

  if (e.category === "not_job_related") return triagedOut(confidence);

  let part: Part;

  if (e.category === "job_alert") {
    part = planAlert(c);
  } else {
    const inbound = m.direction === "inbound";
    // The owner's own address says nothing about the company on outbound mail.
    const resolution = resolveCompany(
      {
        senderEmail: inbound ? m.fromEmail : null,
        extractedName: e.company?.name ?? null,
        websiteDomain: e.company?.websiteDomain ?? null,
        jobUrl: e.jobUrl,
      },
      s.companyIndex,
    );
    const match = resolveMatch(c, resolution);

    switch (match.kind) {
      case "application":
        part = planForApplication(c, match.applicationId);
        break;
      case "ambiguous":
        if (!inbound && match.candidates.length === 0) {
          return triagedOut(confidence);
        }
        part = emptyPart();
        if (choice?.action !== "timeline_only") {
          part.conditions.push({
            kind: "ambiguous_match",
            reason:
              match.candidates.length > 0
                ? "Several applications could match this email"
                : "No application matches this email",
            candidates: match.candidates,
          });
        }
        break;
      case "create":
        if (!inbound) return triagedOut(confidence);
        part = planCreate(c, resolution, match.convertLeadId);
        break;
      case "lead_thread":
        if (inbound && CREATING.includes(e.category)) {
          part = planCreate(c, resolution, match.leadId);
        } else {
          part = planLeadThread(c, match.leadId);
        }
        break;
      case "none":
        if (e.category === "recruiter_outreach" && inbound) {
          part = planRecruiterLead(c);
        } else {
          return triagedOut(confidence);
        }
        break;
    }
  }

  // Low confidence is a review condition unless the owner has already decided.
  if (choice === undefined && confidence < settings.autoApplyMinConfidence) {
    const [shown, threshold] = percentPair(confidence, settings.autoApplyMinConfidence);
    part.conditions.push({
      kind: "low_confidence",
      reason: `Confidence ${shown} is below the ${threshold} threshold`,
      candidates: [],
    });
  }
  return finish(part, confidence, "applied");
}
