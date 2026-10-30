import { z } from "zod";
import {
  ActorSchema,
  ApplicationSourceSchema,
  ApplicationStatusSchema,
  BackfillStateSchema,
  ConnectionStatusSchema,
  EmailCategorySchema,
  EventTypeSchema,
  InterviewKindSchema,
  InterviewStatusSchema,
  LeadSourceSchema,
  LeadStatusSchema,
  LlmPurposeSchema,
  MessageDirectionSchema,
  ReviewKindSchema,
  ReviewStateSchema,
  SearchRunStatusSchema,
  SearchTriggerSchema,
  SenioritySchema,
  SuppressedReasonSchema,
  TriStateSchema,
  VerificationSchema,
  WorkModeSchema,
} from "./enums.js";
import { CompensationSchema, ExtractionSchema, ReportLeadSchema } from "./llm.js";
import { DailyTargetsSchema } from "./settings.js";

// TECHNICAL_SPEC §10.2 DTOs and §10.1 request bodies.
// Response timestamps are ISO 8601 strings in UTC. Request timestamps must carry an offset (or Z).

const id = z.string();
const iso = z.string();
const count = z.number().int().min(0);
const version = z.number().int().min(1);
const isoWithOffset = z.iso.datetime({ offset: true });

export const MeSchema = z.object({
  mode: z.enum(["private", "demo"]),
  email: z.string().nullable(),
  onboardingCompleted: z.boolean(),
  timezone: z.string(),
});
export type Me = z.infer<typeof MeSchema>;

export const SyncStatusSchema = z.object({
  connection: z.union([z.literal("not_connected"), ConnectionStatusSchema]),
  started: z.boolean(),
  lastSyncAt: iso.nullable(),
  lastError: z.string().nullable(),
  backfill: z.object({ state: BackfillStateSchema, listed: count, processed: count }),
  queue: z.object({
    discovered: count,
    jobRelated: count,
    extracted: count,
    needsReview: count,
    failed: count,
  }),
});
export type SyncStatus = z.infer<typeof SyncStatusSchema>;

export const MessageSummarySchema = z.object({
  id,
  internalDate: iso,
  direction: MessageDirectionSchema,
  fromName: z.string().nullable(),
  fromEmail: z.string().nullable(),
  subject: z.string().nullable(),
  summary: z.string().nullable(),
  category: EmailCategorySchema.nullable(),
});
export type MessageSummary = z.infer<typeof MessageSummarySchema>;

export const MessageDetailSchema = MessageSummarySchema.extend({
  bodyText: z.string().nullable(),
  toEmails: z.array(z.string()),
});
export type MessageDetail = z.infer<typeof MessageDetailSchema>;

export const TimelineEventSchema = z.object({
  id,
  type: EventTypeSchema,
  occurredAt: iso,
  actor: ActorSchema,
  summary: z.string(),
  messageId: z.string().nullable(),
  /** The status a status event moved the application to (from the event payload); null otherwise. */
  toStatus: ApplicationStatusSchema.nullable(),
  undoable: z.boolean(),
  undoneAt: iso.nullable(),
});
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;

export const InterviewSchema = z.object({
  id,
  version,
  applicationId: id,
  kind: InterviewKindSchema,
  status: InterviewStatusSchema,
  startsAt: iso.nullable(),
  endsAt: iso.nullable(),
  timezoneHint: z.string().nullable(),
  meetingUrl: z.string().nullable(),
  schedulingUrl: z.string().nullable(),
  location: z.string().nullable(),
  interviewers: z.array(z.string()),
  notes: z.string().nullable(),
});
export type Interview = z.infer<typeof InterviewSchema>;

const CompanyRefSchema = z.object({ id, name: z.string() });

export const ApplicationSummarySchema = z.object({
  id,
  version,
  company: CompanyRefSchema,
  title: z.string(),
  status: ApplicationStatusSchema,
  statusChangedAt: iso,
  appliedAt: iso.nullable(),
  lastCompanyActivityAt: iso.nullable(),
  followUpDue: z.boolean(),
  nextInterviewAt: iso.nullable(),
  workMode: WorkModeSchema,
  country: z.string().nullable(),
  source: ApplicationSourceSchema,
});
export type ApplicationSummary = z.infer<typeof ApplicationSummarySchema>;

/** An interview with its application, as returned by `GET /interviews` and inside `Today`. */
export const InterviewWithApplicationSchema = InterviewSchema.extend({
  application: ApplicationSummarySchema,
});
export type InterviewWithApplication = z.infer<typeof InterviewWithApplicationSchema>;

export const ApplicationDetailSchema = ApplicationSummarySchema.extend({
  jobUrl: z.string().nullable(),
  locationText: z.string().nullable(),
  compensationText: z.string().nullable(),
  sponsorshipText: z.string().nullable(),
  notes: z.string().nullable(),
  leadId: z.string().nullable(),
  interviews: z.array(InterviewSchema),
  messages: z.array(MessageSummarySchema),
  timeline: z.array(TimelineEventSchema),
});
export type ApplicationDetail = z.infer<typeof ApplicationDetailSchema>;

export const LeadSchema = z.object({
  id,
  version,
  company: CompanyRefSchema,
  title: z.string(),
  jobUrl: z.string().nullable(),
  locationText: z.string().nullable(),
  country: z.string().nullable(),
  workMode: WorkModeSchema,
  remoteFromHomeCountry: TriStateSchema,
  sponsorship: TriStateSchema,
  relocation: TriStateSchema,
  sponsorshipText: z.string().nullable(),
  eligible: TriStateSchema,
  eligibilityReason: z.string().nullable(),
  compensationText: z.string().nullable(),
  compensation: CompensationSchema,
  seniority: SenioritySchema,
  track: z.string().nullable(),
  fitScore: z.number().int().min(0).max(100).nullable(),
  fitReason: z.string().nullable(),
  gaps: z.array(z.string()),
  status: LeadStatusSchema,
  suppressedReason: SuppressedReasonSchema.nullable(),
  dismissedReason: z.string().nullable(),
  companySeenBefore: z.boolean(),
  verification: VerificationSchema,
  source: LeadSourceSchema,
  foundAt: iso,
  postedAt: iso.nullable(),
  applicationId: z.string().nullable(),
  notes: z.string().nullable(),
});
export type Lead = z.infer<typeof LeadSchema>;

export const OperationPreviewSchema = z.object({
  entity: z.string(),
  action: z.string(),
  summary: z.string(),
});
export type OperationPreview = z.infer<typeof OperationPreviewSchema>;

export const ReviewItemSchema = z.object({
  id,
  kind: ReviewKindSchema,
  state: ReviewStateSchema,
  createdAt: iso,
  confidence: z.number().nullable(),
  message: MessageSummarySchema.nullable(),
  proposal: z.object({
    description: z.string(),
    operations: z.array(OperationPreviewSchema),
  }),
  candidates: z.array(z.object({ id, label: z.string() })),
});
export type ReviewItem = z.infer<typeof ReviewItemSchema>;

export const TodaySchema = z.object({
  date: z.string(),
  targets: DailyTargetsSchema,
  counts: z.object({
    newLeads: count,
    applications: count,
    outreach: count,
    followUps: count,
    prepMinutes: count,
  }),
  followUpsDue: z.array(ApplicationSummarySchema),
  upcomingInterviews: z.array(InterviewWithApplicationSchema),
  topLeads: z.array(LeadSchema),
  review: z.object({ open: count, first: z.array(ReviewItemSchema) }),
  sync: SyncStatusSchema,
  pipeline: z.object({
    byStatus: z.record(ApplicationStatusSchema, count),
    responseRate: z.number(),
    interviewRate: z.number(),
  }),
});
export type Today = z.infer<typeof TodaySchema>;

export const AiUsageSchema = z.object({
  monthToDateMicros: count,
  byPurpose: z.array(
    z.object({
      purpose: LlmPurposeSchema,
      calls: count,
      costMicros: count,
      unknownCostCalls: count,
    }),
  ),
  last30Days: z.array(z.object({ date: z.string(), costMicros: count })),
});
export type AiUsage = z.infer<typeof AiUsageSchema>;

export const SearchRunSchema = z.object({
  id,
  trigger: SearchTriggerSchema,
  status: SearchRunStatusSchema,
  startedAt: iso,
  finishedAt: iso.nullable(),
  rounds: count,
  returned: count,
  accepted: count,
  suppressed: count,
  duplicates: count,
  dead: count,
  webSearchCalls: count,
  costMicros: count.nullable(),
  error: z.string().nullable(),
});
export type SearchRun = z.infer<typeof SearchRunSchema>;

export const CompanySchema = z.object({
  id,
  version,
  name: z.string(),
  aliases: z.array(z.string()),
  domains: z.array(z.string()),
  websiteDomain: z.string().nullable(),
  groupId: z.string().nullable(),
});
export type Company = z.infer<typeof CompanySchema>;

export const NavCountsSchema = z.object({
  openApplications: count,
  newLeads: count,
  upcomingInterviews: count,
  openReview: count,
});
export type NavCounts = z.infer<typeof NavCountsSchema>;

// --- Request bodies ---

const requiredText = z.string().trim().min(1);

export const ApplicationCreateSchema = z.object({
  companyName: requiredText,
  title: requiredText,
  jobUrl: z.httpUrl().nullable(),
  status: ApplicationStatusSchema,
  appliedAt: isoWithOffset.nullable(),
  notes: z.string().nullable(),
});
export type ApplicationCreate = z.infer<typeof ApplicationCreateSchema>;

export const ApplicationPatchSchema = z.object({
  version,
  companyName: requiredText.optional(),
  title: requiredText.optional(),
  jobUrl: z.httpUrl().nullable().optional(),
  status: ApplicationStatusSchema.optional(),
  appliedAt: isoWithOffset.nullable().optional(),
  notes: z.string().nullable().optional(),
  locationText: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  workMode: WorkModeSchema.optional(),
  compensationText: z.string().nullable().optional(),
  sponsorshipText: z.string().nullable().optional(),
});
export type ApplicationPatch = z.infer<typeof ApplicationPatchSchema>;

export const InterviewCreateSchema = z.object({
  kind: InterviewKindSchema,
  status: InterviewStatusSchema,
  startsAt: isoWithOffset.nullable(),
  endsAt: isoWithOffset.nullable(),
  meetingUrl: z.httpUrl().nullable(),
  location: z.string().nullable(),
  interviewers: z.array(z.string()),
  notes: z.string().nullable(),
});
export type InterviewCreate = z.infer<typeof InterviewCreateSchema>;

export const InterviewPatchSchema = z.object({
  version,
  kind: InterviewKindSchema.optional(),
  status: InterviewStatusSchema.optional(),
  startsAt: isoWithOffset.nullable().optional(),
  endsAt: isoWithOffset.nullable().optional(),
  meetingUrl: z.httpUrl().nullable().optional(),
  location: z.string().nullable().optional(),
  interviewers: z.array(z.string()).optional(),
  notes: z.string().nullable().optional(),
});
export type InterviewPatch = z.infer<typeof InterviewPatchSchema>;

export const LeadCreateSchema = z.object({
  companyName: requiredText,
  title: requiredText,
  jobUrl: z.httpUrl().nullable(),
  locationText: z.string().nullable(),
  country: z.string().nullable(),
  workMode: WorkModeSchema,
  compensationText: z.string().nullable(),
  notes: z.string().nullable(),
});
export type LeadCreate = z.infer<typeof LeadCreateSchema>;

export const LeadPatchSchema = z.object({
  version,
  status: z.enum(["shortlisted", "dismissed", "new"]).optional(),
  dismissedReason: z.string().optional(),
  notes: z.string().nullable().optional(),
});
export type LeadPatch = z.infer<typeof LeadPatchSchema>;

export const ReviewActionSchema = z.enum([
  "apply",
  "edit_apply",
  "dismiss",
  "attach",
  "create_new",
  "reopen",
  "timeline_only",
  "merge",
  "same_group",
  "keep_separate",
  "retry",
  "reprocess",
  "ignore",
]);
export type ReviewAction = z.infer<typeof ReviewActionSchema>;

// Per-action requirements (for example, attach needs applicationId) are enforced by the API.
export const ReviewResolveSchema = z.object({
  action: ReviewActionSchema,
  applicationId: z.string().optional(),
  edits: ExtractionSchema.partial().optional(),
});
export type ReviewResolve = z.infer<typeof ReviewResolveSchema>;

export const DailyActivityBodySchema = z.object({
  kind: z.enum(["outreach", "prep_minutes"]),
  amount: z.number().int().min(1).max(240),
});
export type DailyActivityBody = z.infer<typeof DailyActivityBodySchema>;

/** The owner-local day's counters (DATA_MODEL §3.17), returned by `POST /daily-activity`. */
export const DailyCountsSchema = z.object({
  date: z.string(),
  outreach: count,
  prepMinutes: count,
  followUps: count,
});
export type DailyCounts = z.infer<typeof DailyCountsSchema>;

// --- Previews and pages ---

export const SheetStatusSchema = z.enum([
  "to_research",
  "cancelled",
  "applied",
  "interview",
  "rejected",
]);
export type SheetStatus = z.infer<typeof SheetStatusSchema>;

/** What a sheet status becomes (DATA_MODEL §5). */
export const SheetTargetSchema = z.enum([
  "lead_new",
  "lead_dismissed",
  "application_applied",
  "application_interviewing",
  "application_rejected",
]);
export type SheetTarget = z.infer<typeof SheetTargetSchema>;

/** `POST /import/sheet/preview` (AC-14.4). Nothing is written until commit. */
export const SheetPreviewSchema = z.object({
  previewId: id,
  expiresAt: iso,
  totalRows: count,
  /** One entry per sheet status with rows: status in the sheet, what it becomes, and the row count. */
  mappings: z.array(
    z.object({ sheetStatus: SheetStatusSchema, target: SheetTargetSchema, rows: count }),
  ),
  errors: z.array(z.object({ line: z.number().int().min(1), message: z.string() })),
  duplicatesInFile: z.array(
    z.object({
      line: z.number().int().min(1),
      duplicateOfLine: z.number().int().min(1),
      company: z.string(),
      role: z.string(),
    }),
  ),
  /** Rows that match an existing record by job key or company + role and will be skipped (AC-14.5). */
  existingMatches: count,
});
export type SheetPreview = z.infer<typeof SheetPreviewSchema>;

/** `POST /import/sheet/commit`. */
export const ImportSummarySchema = z.object({
  applicationsCreated: count,
  leadsCreated: count,
  leadsDismissed: count,
  skippedExisting: count,
  skippedDuplicateRows: count,
  errorRows: count,
});
export type ImportSummary = z.infer<typeof ImportSummarySchema>;

export const ReportRowAnnotationSchema = z.enum([
  "new",
  "duplicate",
  "company_already_seen",
  "excluded_seniority",
]);
export type ReportRowAnnotation = z.infer<typeof ReportRowAnnotationSchema>;

/** `POST /leads/import/preview` (TECHNICAL_SPEC §7.6). */
export const ReportPreviewSchema = z.object({
  previewId: id,
  expiresAt: iso,
  rows: z.array(
    z.object({ rowId: id, annotation: ReportRowAnnotationSchema, lead: ReportLeadSchema }),
  ),
});
export type ReportPreview = z.infer<typeof ReportPreviewSchema>;

/** `{ items, nextCursor }` for every list endpoint. */
export const PageSchema = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });
export type Page<T> = { items: T[]; nextCursor: string | null };
