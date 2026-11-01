-- =============================================================================
-- Migration 005: correct schema comments that outlived their design
--
-- No structural change. The inline comment in 001 describing `job_key` as
-- "derived from checksum" stopped being true when document identity moved from
-- content to slot, and 001 has shipped — it cannot be edited (the migrator
-- checksums applied files and refuses a changed one). A `COMMENT ON COLUMN`
-- is the forward-only way to correct the record, and it is what `\d+` and every
-- introspection tool actually show.
-- =============================================================================

BEGIN;

COMMENT ON COLUMN ingestion_jobs.job_key IS
    'BullMQ jobId; deterministic, derived from version_id (ingest-<versionId>). '
    'Originally derived from the content checksum, which stopped being unique '
    'once the same bytes could legitimately belong to two document slots.';

COMMENT ON COLUMN document_versions.checksum_sha256 IS
    'SHA-256 of the stored bytes. Unique per DOCUMENT SLOT, not per tenant: a '
    'contractor submits the same SBU to every tender, so tenant-wide uniqueness '
    'discarded the second tender''s upload. The non-unique '
    '(organization_id, checksum_sha256) index answers "are these bytes already '
    'stored?" and lets a repeat upload reuse the existing object.';

COMMIT;
