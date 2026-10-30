# Hand-written SQL

Prisma 6 cannot express these objects, so they live as raw SQL in `migrations/0001_init/migration.sql`
(part 2, below the generated table definitions). Prisma knows nothing about most of them.

**Check every new migration for DROP statements against these.** When `prisma migrate dev` diffs
the schema against the database it can generate `DROP INDEX` or `DROP CONSTRAINT` for any object on
this list. Delete those statements by hand before committing the migration. Update this file when
a migration adds, changes or removes a hand-written object.

| Object                                  | Statement                                                                                                                              |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Extension                               | `create extension if not exists citext`                                                                                                |
| Extension                               | `create extension if not exists pgcrypto`                                                                                              |
| `lead_job_key_key`                      | `create unique index … on lead (job_key) where job_key is not null`                                                                    |
| `application_job_key_key`               | `create unique index … on application (job_key) where job_key is not null`                                                             |
| `interview_ics_uid_key`                 | `create unique index … on interview (ics_uid) where ics_uid is not null`                                                               |
| `intake_batch_file_hash_key`            | `create unique index … on intake_batch (file_hash) where file_hash is not null`                                                        |
| `candidate_profile_one_active`          | `create unique index … on candidate_profile (is_active) where is_active`                                                               |
| `search_run_one_running`                | `create unique index … on search_run (status) where status = 'running'`                                                                |
| `review_item_one_open_per_message_kind` | `create unique index … on review_item (message_id, kind) where state = 'open' and message_id is not null`                              |
| `event_message_type_entity_key`         | `create unique index … on event (message_id, type, (coalesce(application_id::text, lead_id::text, '-'))) where message_id is not null` |
| `application_follow_up_due_idx`         | `create index … on application (follow_up_due) where follow_up_due`                                                                    |
| `lead_suppressed_reason`                | `alter table lead add constraint … check ((status = 'suppressed') = (suppressed_reason is not null))`                                  |
| `thread_link_target`                    | `alter table thread_link add constraint … check (application_id is not null or lead_id is not null)`                                   |
| `gmail_connection_singleton`            | `alter table gmail_connection add constraint … check (id = 1)`                                                                         |
| `company.aliases` not null              | column `aliases` on `company` is `text[] not null` (edited into the generated `create table`)                                          |
| `company.domains` not null              | column `domains` on `company` is `text[] not null` (edited into the generated `create table`)                                          |
| `company.ats_slugs` not null            | column `ats_slugs` on `company` is `text[] not null` (edited into the generated `create table`)                                        |
| `lead.gaps` not null                    | column `gaps` on `lead` is `text[] not null` (edited into the generated `create table`)                                                |
| `interview.interviewers` not null       | column `interviewers` on `interview` is `text[] not null` (edited into the generated `create table`)                                   |
| `gmail_message.label_ids` not null      | column `label_ids` on `gmail_message` is `text[] not null` (edited into the generated `create table`)                                  |
| `review_item.reasons` not null          | column `reasons` on `review_item` is `text[] not null` (edited into the generated `create table`)                                      |
| `gmail_connection.scopes` not null      | column `scopes` on `gmail_connection` is `text[] not null` (edited into the generated `create table`)                                  |

Notes:

- Declared in `schema.prisma`, not hand-written: the GIN indexes `company_aliases_gin`,
  `company_domains_gin` and `company_ats_slugs_gin` (`type: Gin`, `map:` the same names). Prisma
  manages them and a diff never drops them; the generated part of the migration creates them.
- The `event` expression index replaces the generated `entity_key` column of DATA_MODEL §3.8 with
  the same guarantee (the plan's refinement); there is no `entity_key` column.
- Prisma list columns generate as nullable `text[]`. The migration adds `not null` to every array
  column DATA_MODEL marks not null (`aliases`, `domains`, `ats_slugs`, `gaps`, `interviewers`,
  `label_ids`, `reasons`, `scopes`). `gmail_message.to_emails` stays nullable. If a later
  `migrate dev` diff generates `ALTER COLUMN … DROP NOT NULL` for any of these, remove it.
- Prisma Client cannot write `null` to a list field. Clearing `gmail_message.to_emails` to null
  (the content purge) needs raw SQL; an empty array is the in-client equivalent.
