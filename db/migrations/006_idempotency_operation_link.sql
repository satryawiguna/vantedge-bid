-- =============================================================================
-- Migration 006: an idempotency claim remembers the operation it began
--
-- A request files its document version in one transaction and records its
-- response against the Idempotency-Key afterwards. If the process dies in
-- between, the lease expires and the same request takes the key over. Until now
-- the successor had nothing to go on but the content checksum, and for a
-- multi-instance type (SKK_PERSONIL, SURAT_DUKUNGAN) the checksum proves nothing:
-- two key personnel can hold byte-identical certificates. The successor filed a
-- second logical document for the same request.
--
-- `version_id` is written in the same transaction that creates the version, so
-- "the claim names a version" and "the version exists" commit together or not at
-- all. A takeover reads it and recovers that operation instead of repeating it.
--
-- Forward-only: 001–005 are untouched.
-- =============================================================================

BEGIN;

ALTER TABLE idempotency_keys
    ADD COLUMN version_id uuid REFERENCES document_versions (id) ON DELETE SET NULL;

COMMENT ON COLUMN idempotency_keys.version_id IS
    'The document version this claim''s request created. Set in the same '
    'transaction that creates the version, conditional on owner_token. A takeover '
    'by the same request fingerprint recovers this version rather than filing '
    'another. NULL until the version exists, and reset when the key is re-claimed '
    'by a different request or after its response was already recorded.';

COMMIT;
