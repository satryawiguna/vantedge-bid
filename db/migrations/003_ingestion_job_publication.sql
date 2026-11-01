-- =============================================================================
-- Migration 003: durable record of queue publication
--
-- The API commits the ingestion_jobs row and only then publishes to BullMQ
-- (ADR 0002). That ordering is correct, but it leaves a window: the process can
-- die after the commit and before the publish. The database then records work
-- that the broker has never heard of, and nothing notices.
--
-- `published_at` closes the window by making publication itself a durable fact.
-- A row that is queued with published_at IS NULL is committed intent that was
-- never handed to the broker, which is exactly what the reconciler looks for.
-- =============================================================================

BEGIN;

ALTER TABLE ingestion_jobs
    ADD COLUMN published_at timestamptz;

COMMENT ON COLUMN ingestion_jobs.published_at IS
    'When this job was accepted by the broker. NULL on a queued row means the '
    'publish never completed — the reconciler republishes those.';

-- Existing rows predate the column. They were published under the old code
-- path, so backfilling them as published keeps the reconciler from
-- re-publishing historical work on first boot.
UPDATE ingestion_jobs SET published_at = enqueued_at WHERE published_at IS NULL;

-- The reconciler's only query: unpublished intent, oldest first. Partial, so
-- the index stays the size of the backlog rather than the whole ledger — which
-- in a healthy system is zero rows.
CREATE INDEX ingestion_jobs_unpublished_idx
    ON ingestion_jobs (enqueued_at)
    WHERE published_at IS NULL AND state = 'queued';

COMMIT;
