import { z } from "zod";

// One zod enum per DATA_MODEL §2 enum. Values are verbatim from the table.

export const ApplicationStatusSchema = z.enum([
  "applied",
  "screening",
  "assessment",
  "interviewing",
  "offer",
  "accepted",
  "rejected",
  "withdrawn",
  "abandoned",
]);
export type ApplicationStatus = z.infer<typeof ApplicationStatusSchema>;

export const ApplicationSourceSchema = z.enum([
  "sheet_import",
  "gmail",
  "lead_conversion",
  "manual",
]);
export type ApplicationSource = z.infer<typeof ApplicationSourceSchema>;

export const LeadStatusSchema = z.enum([
  "new",
  "shortlisted",
  "dismissed",
  "applied",
  "suppressed",
]);
export type LeadStatus = z.infer<typeof LeadStatusSchema>;

export const LeadPipelineStateSchema = z.enum(["checking", "ranking", "ready"]);
export type LeadPipelineState = z.infer<typeof LeadPipelineStateSchema>;

export const SuppressedReasonSchema = z.enum([
  "company_already_seen",
  "same_company_in_batch",
  "excluded_seniority",
  "ineligible",
]);
export type SuppressedReason = z.infer<typeof SuppressedReasonSchema>;

export const LeadSourceSchema = z.enum([
  "search_agent",
  "gmail_alert",
  "gmail_recruiter",
  "sheet_import",
  "paste_report",
  "manual",
]);
export type LeadSource = z.infer<typeof LeadSourceSchema>;

export const VerificationSchema = z.enum(["pending", "verified", "unverified", "unverifiable"]);
export type Verification = z.infer<typeof VerificationSchema>;

export const WorkModeSchema = z.enum(["remote", "hybrid", "onsite", "unknown"]);
export type WorkMode = z.infer<typeof WorkModeSchema>;

export const TriStateSchema = z.enum(["yes", "no", "unknown"]);
export type TriState = z.infer<typeof TriStateSchema>;

export const SenioritySchema = z.enum([
  "junior",
  "mid",
  "senior",
  "staff_plus",
  "lead",
  "manager",
  "unknown",
]);
export type Seniority = z.infer<typeof SenioritySchema>;

export const CompPeriodSchema = z.enum(["year", "month", "hour"]);
export type CompPeriod = z.infer<typeof CompPeriodSchema>;

export const InterviewKindSchema = z.enum([
  "recruiter_screen",
  "hiring_manager",
  "technical",
  "system_design",
  "behavioral",
  "take_home_review",
  "onsite_loop",
  "other",
]);
export type InterviewKind = z.infer<typeof InterviewKindSchema>;

export const InterviewStatusSchema = z.enum(["to_schedule", "scheduled", "completed", "cancelled"]);
export type InterviewStatus = z.infer<typeof InterviewStatusSchema>;

export const MessageStateSchema = z.enum([
  "discovered",
  "skipped",
  "triaged_out",
  "job_related",
  "extracted",
  "applied",
  "needs_review",
  "failed",
]);
export type MessageState = z.infer<typeof MessageStateSchema>;

export const MessageDirectionSchema = z.enum(["inbound", "outbound"]);
export type MessageDirection = z.infer<typeof MessageDirectionSchema>;

export const TriageMethodSchema = z.enum(["rule", "llm"]);
export type TriageMethod = z.infer<typeof TriageMethodSchema>;

export const EmailCategorySchema = z.enum([
  "application_confirmation",
  "rejection",
  "interview_invite",
  "interview_reschedule",
  "interview_cancellation",
  "assessment",
  "offer",
  "recruiter_outreach",
  "job_alert",
  "status_update_other",
  "candidate_outbound",
  "not_job_related",
]);
export type EmailCategory = z.infer<typeof EmailCategorySchema>;

export const EventTypeSchema = z.enum([
  "imported",
  "email_received",
  "email_sent",
  "application_created",
  "lead_created",
  "lead_converted",
  "status_changed",
  "field_updated",
  "note_updated",
  "interview_created",
  "interview_updated",
  "interview_cancelled",
  "interview_completed",
  "follow_up_due",
  "follow_up_done",
  "abandoned",
  "reopened",
  "merged",
  "undone",
]);
export type EventType = z.infer<typeof EventTypeSchema>;

export const ActorSchema = z.enum(["system", "owner", "import"]);
export type Actor = z.infer<typeof ActorSchema>;

export const ReviewKindSchema = z.enum([
  "low_confidence",
  "ambiguous_match",
  "unexpected_transition",
  "possible_duplicate_company",
  "extraction_failed",
  "undone_change",
]);
export type ReviewKind = z.infer<typeof ReviewKindSchema>;

export const ReviewStateSchema = z.enum(["open", "resolved", "dismissed"]);
export type ReviewState = z.infer<typeof ReviewStateSchema>;

/** No row in `gmail_connection` means "not connected"; see `SyncStatusSchema` for that value. */
export const ConnectionStatusSchema = z.enum([
  "active",
  "needs_reauth",
  "missing_scope",
  "disconnected",
]);
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>;

export const BackfillStateSchema = z.enum(["not_started", "running", "done", "failed"]);
export type BackfillState = z.infer<typeof BackfillStateSchema>;

export const SearchTriggerSchema = z.enum(["schedule", "manual"]);
export type SearchTrigger = z.infer<typeof SearchTriggerSchema>;

export const SearchRunStatusSchema = z.enum(["running", "succeeded", "partial", "failed"]);
export type SearchRunStatus = z.infer<typeof SearchRunStatusSchema>;

export const IntakeBatchKindSchema = z.enum([
  "search_run",
  "gmail_message",
  "paste_report",
  "sheet_import",
  "manual",
]);
export type IntakeBatchKind = z.infer<typeof IntakeBatchKindSchema>;

export const LlmPurposeSchema = z.enum([
  "triage",
  "extract",
  "rank",
  "search",
  "parse_report",
  "cv_profile",
]);
export type LlmPurpose = z.infer<typeof LlmPurposeSchema>;

export const LlmCallStatusSchema = z.enum(["ok", "error"]);
export type LlmCallStatus = z.infer<typeof LlmCallStatusSchema>;
