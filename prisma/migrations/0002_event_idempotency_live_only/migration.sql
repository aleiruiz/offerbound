-- An undone event frees its idempotency slot: reprocessing the same email may write the same
-- (message, type, record) event again. Hand-written (see prisma/MANUAL_SQL.md): Prisma does not
-- know this index.
drop index event_message_type_entity_key;
create unique index event_message_type_entity_key on event
  (message_id, type, (coalesce(application_id::text, lead_id::text, '-')))
  where message_id is not null and undone_at is null;
