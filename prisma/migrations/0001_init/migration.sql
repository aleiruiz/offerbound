-- Hand-written SQL, part 1: extensions. See prisma/MANUAL_SQL.md.
create extension if not exists citext;
create extension if not exists pgcrypto;

-- CreateEnum
CREATE TYPE "application_status" AS ENUM ('applied', 'screening', 'assessment', 'interviewing', 'offer', 'accepted', 'rejected', 'withdrawn', 'abandoned');

-- CreateEnum
CREATE TYPE "application_source" AS ENUM ('sheet_import', 'gmail', 'lead_conversion', 'manual');

-- CreateEnum
CREATE TYPE "lead_status" AS ENUM ('new', 'shortlisted', 'dismissed', 'applied', 'suppressed');

-- CreateEnum
CREATE TYPE "lead_pipeline_state" AS ENUM ('checking', 'ranking', 'ready');

-- CreateEnum
CREATE TYPE "suppressed_reason" AS ENUM ('company_already_seen', 'same_company_in_batch', 'excluded_seniority', 'ineligible');

-- CreateEnum
CREATE TYPE "lead_source" AS ENUM ('search_agent', 'gmail_alert', 'gmail_recruiter', 'sheet_import', 'paste_report', 'manual');

-- CreateEnum
CREATE TYPE "verification" AS ENUM ('pending', 'verified', 'unverified', 'unverifiable');

-- CreateEnum
CREATE TYPE "work_mode" AS ENUM ('remote', 'hybrid', 'onsite', 'unknown');

-- CreateEnum
CREATE TYPE "tri_state" AS ENUM ('yes', 'no', 'unknown');

-- CreateEnum
CREATE TYPE "seniority" AS ENUM ('junior', 'mid', 'senior', 'staff_plus', 'lead', 'manager', 'unknown');

-- CreateEnum
CREATE TYPE "comp_period" AS ENUM ('year', 'month', 'hour');

-- CreateEnum
CREATE TYPE "interview_kind" AS ENUM ('recruiter_screen', 'hiring_manager', 'technical', 'system_design', 'behavioral', 'take_home_review', 'onsite_loop', 'other');

-- CreateEnum
CREATE TYPE "interview_status" AS ENUM ('to_schedule', 'scheduled', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "message_state" AS ENUM ('discovered', 'skipped', 'triaged_out', 'job_related', 'extracted', 'applied', 'needs_review', 'failed');

-- CreateEnum
CREATE TYPE "message_direction" AS ENUM ('inbound', 'outbound');

-- CreateEnum
CREATE TYPE "triage_method" AS ENUM ('rule', 'llm');

-- CreateEnum
CREATE TYPE "email_category" AS ENUM ('application_confirmation', 'rejection', 'interview_invite', 'interview_reschedule', 'interview_cancellation', 'assessment', 'offer', 'recruiter_outreach', 'job_alert', 'status_update_other', 'candidate_outbound', 'not_job_related');

-- CreateEnum
CREATE TYPE "event_type" AS ENUM ('imported', 'email_received', 'email_sent', 'application_created', 'lead_created', 'lead_converted', 'status_changed', 'field_updated', 'note_updated', 'interview_created', 'interview_updated', 'interview_cancelled', 'interview_completed', 'follow_up_due', 'follow_up_done', 'abandoned', 'reopened', 'merged', 'undone');

-- CreateEnum
CREATE TYPE "actor" AS ENUM ('system', 'owner', 'import');

-- CreateEnum
CREATE TYPE "review_kind" AS ENUM ('low_confidence', 'ambiguous_match', 'unexpected_transition', 'possible_duplicate_company', 'extraction_failed', 'undone_change');

-- CreateEnum
CREATE TYPE "review_state" AS ENUM ('open', 'resolved', 'dismissed');

-- CreateEnum
CREATE TYPE "connection_status" AS ENUM ('active', 'needs_reauth', 'missing_scope', 'disconnected');

-- CreateEnum
CREATE TYPE "backfill_state" AS ENUM ('not_started', 'running', 'done', 'failed');

-- CreateEnum
CREATE TYPE "search_trigger" AS ENUM ('schedule', 'manual');

-- CreateEnum
CREATE TYPE "search_run_status" AS ENUM ('running', 'succeeded', 'partial', 'failed');

-- CreateEnum
CREATE TYPE "intake_batch_kind" AS ENUM ('search_run', 'gmail_message', 'paste_report', 'sheet_import', 'manual');

-- CreateEnum
CREATE TYPE "llm_purpose" AS ENUM ('triage', 'extract', 'rank', 'search', 'parse_report', 'cv_profile');

-- CreateEnum
CREATE TYPE "llm_call_status" AS ENUM ('ok', 'error');

-- CreateTable
CREATE TABLE "company" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "version" INTEGER NOT NULL DEFAULT 1,
    "name" TEXT NOT NULL,
    "normalized_name" TEXT NOT NULL,
    "aliases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "domains" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "ats_slugs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "website_domain" TEXT,
    "group_id" UUID,
    "created_source" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID,
    "email" CITEXT NOT NULL,
    "name" TEXT,
    "title" TEXT,
    "is_agency" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "version" INTEGER NOT NULL DEFAULT 1,
    "company_id" UUID NOT NULL,
    "intake_batch_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "job_url" TEXT,
    "job_key" TEXT,
    "location_text" TEXT,
    "country" TEXT,
    "work_mode" "work_mode" NOT NULL DEFAULT 'unknown',
    "remote_from_home_country" "tri_state" NOT NULL DEFAULT 'unknown',
    "sponsorship" "tri_state" NOT NULL DEFAULT 'unknown',
    "relocation" "tri_state" NOT NULL DEFAULT 'unknown',
    "sponsorship_text" TEXT,
    "compensation_text" TEXT,
    "comp_min" DECIMAL(12,2),
    "comp_max" DECIMAL(12,2),
    "comp_currency" CHAR(3),
    "comp_period" "comp_period",
    "comp_is_estimate" BOOLEAN NOT NULL DEFAULT false,
    "comp_basis" TEXT,
    "seniority" "seniority" NOT NULL DEFAULT 'unknown',
    "track" TEXT,
    "fit_score" SMALLINT,
    "fit_reason" TEXT,
    "gaps" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "eligible" "tri_state" NOT NULL DEFAULT 'unknown',
    "eligibility_reason" TEXT,
    "status" "lead_status" NOT NULL DEFAULT 'new',
    "status_changed_at" TIMESTAMPTZ(3) NOT NULL,
    "pipeline_state" "lead_pipeline_state" NOT NULL DEFAULT 'checking',
    "suppressed_reason" "suppressed_reason",
    "dismissed_reason" TEXT,
    "company_seen_before" BOOLEAN NOT NULL DEFAULT false,
    "verification" "verification" NOT NULL DEFAULT 'pending',
    "verified_at" TIMESTAMPTZ(3),
    "page_excerpt" TEXT,
    "ranked_at" TIMESTAMPTZ(3),
    "source" "lead_source" NOT NULL,
    "source_message_id" TEXT,
    "contact_id" UUID,
    "posted_at" TIMESTAMPTZ(3),
    "found_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "application_id" UUID,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "version" INTEGER NOT NULL DEFAULT 1,
    "company_id" UUID NOT NULL,
    "lead_id" UUID,
    "title" TEXT NOT NULL,
    "job_url" TEXT,
    "job_key" TEXT,
    "location_text" TEXT,
    "country" TEXT,
    "work_mode" "work_mode" NOT NULL DEFAULT 'unknown',
    "compensation_text" TEXT,
    "sponsorship_text" TEXT,
    "status" "application_status" NOT NULL,
    "status_changed_at" TIMESTAMPTZ(3) NOT NULL,
    "status_before_abandon" "application_status",
    "applied_at" TIMESTAMPTZ(3),
    "last_company_activity_at" TIMESTAMPTZ(3),
    "last_outbound_at" TIMESTAMPTZ(3),
    "follow_up_due" BOOLEAN NOT NULL DEFAULT false,
    "follow_up_due_since" TIMESTAMPTZ(3),
    "follow_up_done_at" TIMESTAMPTZ(3),
    "source" "application_source" NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interview" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "version" INTEGER NOT NULL DEFAULT 1,
    "application_id" UUID NOT NULL,
    "kind" "interview_kind" NOT NULL,
    "status" "interview_status" NOT NULL,
    "starts_at" TIMESTAMPTZ(3),
    "ends_at" TIMESTAMPTZ(3),
    "timezone_hint" TEXT,
    "meeting_url" TEXT,
    "scheduling_url" TEXT,
    "location" TEXT,
    "interviewers" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "ics_uid" TEXT,
    "source_message_id" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "interview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gmail_message" (
    "id" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "internal_date" TIMESTAMPTZ(3) NOT NULL,
    "direction" "message_direction" NOT NULL,
    "label_ids" TEXT[] NOT NULL,
    "state" "message_state" NOT NULL DEFAULT 'discovered',
    "triage_method" "triage_method",
    "triage_rule" TEXT,
    "triage_confidence" REAL,
    "category" "email_category",
    "extract_confidence" REAL,
    "extraction" JSONB,
    "ics_events" JSONB,
    "from_email" TEXT,
    "from_name" TEXT,
    "to_emails" TEXT[],
    "subject" TEXT,
    "snippet" TEXT,
    "body_text" TEXT,
    "summary" TEXT,
    "application_id" UUID,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "discovered_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gmail_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "thread_link" (
    "thread_id" TEXT NOT NULL,
    "application_id" UUID,
    "lead_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "thread_link_pkey" PRIMARY KEY ("thread_id")
);

-- CreateTable
CREATE TABLE "event" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "application_id" UUID,
    "lead_id" UUID,
    "company_id" UUID,
    "type" "event_type" NOT NULL,
    "actor" "actor" NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "message_id" TEXT,
    "summary" TEXT NOT NULL,
    "data" JSONB,
    "change_set" JSONB,
    "undoable" BOOLEAN NOT NULL,
    "undone_at" TIMESTAMPTZ(3),
    "undone_by_event_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_item" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" "review_kind" NOT NULL,
    "state" "review_state" NOT NULL DEFAULT 'open',
    "message_id" TEXT,
    "application_id" UUID,
    "lead_id" UUID,
    "company_id" UUID,
    "confidence" REAL,
    "plan" JSONB,
    "candidates" JSONB NOT NULL DEFAULT '[]',
    "reasons" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "resolution" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(3),

    CONSTRAINT "review_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intake_batch" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" "intake_batch_kind" NOT NULL,
    "search_run_id" UUID,
    "message_id" TEXT,
    "file_hash" TEXT,
    "counts" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalized_at" TIMESTAMPTZ(3),

    CONSTRAINT "intake_batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_preview" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" TEXT NOT NULL,
    "file_hash" TEXT,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "import_preview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_run" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "trigger" "search_trigger" NOT NULL,
    "status" "search_run_status" NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "finished_at" TIMESTAMPTZ(3),
    "rounds" SMALLINT NOT NULL DEFAULT 0,
    "returned" INTEGER NOT NULL DEFAULT 0,
    "accepted" INTEGER NOT NULL DEFAULT 0,
    "suppressed" INTEGER NOT NULL DEFAULT 0,
    "duplicates" INTEGER NOT NULL DEFAULT 0,
    "dead" INTEGER NOT NULL DEFAULT 0,
    "web_search_calls" INTEGER NOT NULL DEFAULT 0,
    "cost_micros" BIGINT,
    "brief_hash" TEXT NOT NULL,
    "error" TEXT,

    CONSTRAINT "search_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_profile" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "text_content" TEXT NOT NULL,
    "profile" JSONB,
    "profile_status" TEXT NOT NULL,
    "model" TEXT,
    "is_active" BOOLEAN NOT NULL,
    "uploaded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidate_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gmail_connection" (
    "id" SMALLINT NOT NULL,
    "google_sub" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "scopes" TEXT[] NOT NULL,
    "refresh_token_enc" TEXT,
    "access_token_enc" TEXT,
    "access_token_expires_at" TIMESTAMPTZ(3),
    "status" "connection_status" NOT NULL,
    "history_id" TEXT,
    "started_at" TIMESTAMPTZ(3),
    "last_sync_at" TIMESTAMPTZ(3),
    "last_sync_error" TEXT,
    "backfill_since" DATE NOT NULL,
    "backfill_state" "backfill_state" NOT NULL DEFAULT 'not_started',
    "backfill_page_token" TEXT,
    "backfill_listed" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gmail_connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_agent" TEXT,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id_hash")
);

-- CreateTable
CREATE TABLE "setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "daily_activity" (
    "day" DATE NOT NULL,
    "outreach_count" INTEGER NOT NULL DEFAULT 0,
    "prep_minutes" INTEGER NOT NULL DEFAULT 0,
    "follow_ups" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_activity_pkey" PRIMARY KEY ("day")
);

-- CreateTable
CREATE TABLE "llm_call" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "purpose" "llm_purpose" NOT NULL,
    "model" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL,
    "cached_input_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "web_search_calls" INTEGER NOT NULL DEFAULT 0,
    "cost_micros" BIGINT,
    "latency_ms" INTEGER NOT NULL,
    "status" "llm_call_status" NOT NULL,
    "error_code" TEXT,
    "request_id" TEXT,
    "message_id" TEXT,
    "search_run_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "llm_call_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "company_normalized_name_key" ON "company"("normalized_name");

-- CreateIndex
CREATE INDEX "company_group_id_idx" ON "company"("group_id");

-- CreateIndex
CREATE UNIQUE INDEX "contact_email_key" ON "contact"("email");

-- CreateIndex
CREATE UNIQUE INDEX "lead_application_id_key" ON "lead"("application_id");

-- CreateIndex
CREATE INDEX "lead_status_pipeline_state_track_fit_score_idx" ON "lead"("status", "pipeline_state", "track", "fit_score" DESC);

-- CreateIndex
CREATE INDEX "lead_company_id_idx" ON "lead"("company_id");

-- CreateIndex
CREATE INDEX "lead_intake_batch_id_idx" ON "lead"("intake_batch_id");

-- CreateIndex
CREATE INDEX "lead_found_at_idx" ON "lead"("found_at");

-- CreateIndex
CREATE UNIQUE INDEX "application_lead_id_key" ON "application"("lead_id");

-- CreateIndex
CREATE INDEX "application_status_idx" ON "application"("status");

-- CreateIndex
CREATE INDEX "application_company_id_idx" ON "application"("company_id");

-- CreateIndex
CREATE INDEX "application_last_company_activity_at_idx" ON "application"("last_company_activity_at");

-- CreateIndex
CREATE INDEX "interview_status_starts_at_idx" ON "interview"("status", "starts_at");

-- CreateIndex
CREATE INDEX "interview_application_id_idx" ON "interview"("application_id");

-- CreateIndex
CREATE INDEX "gmail_message_state_internal_date_idx" ON "gmail_message"("state", "internal_date");

-- CreateIndex
CREATE INDEX "gmail_message_thread_id_idx" ON "gmail_message"("thread_id");

-- CreateIndex
CREATE INDEX "gmail_message_application_id_idx" ON "gmail_message"("application_id");

-- CreateIndex
CREATE INDEX "event_application_id_occurred_at_idx" ON "event"("application_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "event_lead_id_occurred_at_idx" ON "event"("lead_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "review_item_state_created_at_idx" ON "review_item"("state", "created_at" DESC);

-- CreateIndex
CREATE INDEX "search_run_started_at_idx" ON "search_run"("started_at" DESC);

-- CreateIndex
CREATE INDEX "llm_call_created_at_idx" ON "llm_call"("created_at");

-- CreateIndex
CREATE INDEX "llm_call_purpose_created_at_idx" ON "llm_call"("purpose", "created_at");

-- AddForeignKey
ALTER TABLE "company" ADD CONSTRAINT "company_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact" ADD CONSTRAINT "contact_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead" ADD CONSTRAINT "lead_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead" ADD CONSTRAINT "lead_intake_batch_id_fkey" FOREIGN KEY ("intake_batch_id") REFERENCES "intake_batch"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead" ADD CONSTRAINT "lead_source_message_id_fkey" FOREIGN KEY ("source_message_id") REFERENCES "gmail_message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead" ADD CONSTRAINT "lead_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contact"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead" ADD CONSTRAINT "lead_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application" ADD CONSTRAINT "application_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application" ADD CONSTRAINT "application_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview" ADD CONSTRAINT "interview_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview" ADD CONSTRAINT "interview_source_message_id_fkey" FOREIGN KEY ("source_message_id") REFERENCES "gmail_message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gmail_message" ADD CONSTRAINT "gmail_message_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "thread_link" ADD CONSTRAINT "thread_link_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "thread_link" ADD CONSTRAINT "thread_link_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event" ADD CONSTRAINT "event_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event" ADD CONSTRAINT "event_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event" ADD CONSTRAINT "event_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event" ADD CONSTRAINT "event_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "gmail_message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event" ADD CONSTRAINT "event_undone_by_event_id_fkey" FOREIGN KEY ("undone_by_event_id") REFERENCES "event"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "review_item" ADD CONSTRAINT "review_item_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "gmail_message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_item" ADD CONSTRAINT "review_item_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_item" ADD CONSTRAINT "review_item_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_item" ADD CONSTRAINT "review_item_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intake_batch" ADD CONSTRAINT "intake_batch_search_run_id_fkey" FOREIGN KEY ("search_run_id") REFERENCES "search_run"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intake_batch" ADD CONSTRAINT "intake_batch_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "gmail_message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "llm_call" ADD CONSTRAINT "llm_call_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "gmail_message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "llm_call" ADD CONSTRAINT "llm_call_search_run_id_fkey" FOREIGN KEY ("search_run_id") REFERENCES "search_run"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Hand-written SQL, part 2: constraints and indexes Prisma 6 cannot express. See prisma/MANUAL_SQL.md.
-- Check every new migration for DROP statements against these.

-- Partial unique indexes
create unique index lead_job_key_key on lead (job_key) where job_key is not null;
create unique index application_job_key_key on application (job_key) where job_key is not null;
create unique index interview_ics_uid_key on interview (ics_uid) where ics_uid is not null;
create unique index intake_batch_file_hash_key on intake_batch (file_hash) where file_hash is not null;
create unique index candidate_profile_one_active on candidate_profile (is_active) where is_active;
create unique index search_run_one_running on search_run (status) where status = 'running';
create unique index review_item_one_open_per_message_kind on review_item (message_id, kind)
  where state = 'open' and message_id is not null;

-- Event idempotency (replaces the generated entity_key column of DATA_MODEL 3.8)
create unique index event_message_type_entity_key on event
  (message_id, type, (coalesce(application_id::text, lead_id::text, '-')))
  where message_id is not null;

-- Partial index (DATA_MODEL 3.4)
create index application_follow_up_due_idx on application (follow_up_due) where follow_up_due;

-- GIN indexes on company arrays (DATA_MODEL 3.1)
create index company_aliases_gin on company using gin (aliases);
create index company_domains_gin on company using gin (domains);
create index company_ats_slugs_gin on company using gin (ats_slugs);

-- Check constraints
alter table lead add constraint lead_suppressed_reason
  check ((status = 'suppressed') = (suppressed_reason is not null));
alter table thread_link add constraint thread_link_target
  check (application_id is not null or lead_id is not null);
alter table gmail_connection add constraint gmail_connection_singleton check (id = 1);
