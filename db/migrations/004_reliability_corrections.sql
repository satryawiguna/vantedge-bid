-- =============================================================================
-- Migration 004: ownership, multi-instance document types, durable audit intent
--
-- Three unrelated corrections, each needing one piece of durable state that the
-- schema did not previously carry. Forward-only: 001–003 are left untouched.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Idempotency claims need an owner, not just an age
-- -----------------------------------------------------------------------------
-- A claim could be taken over once its lease expired, but completing and
-- releasing it keyed on (organization_id, key) alone. A slow request whose
-- lease lapsed could therefore come back and delete or overwrite the claim its
-- successor now held — writing one request's response under another's key.
--
-- The token is minted on every acquisition, including a takeover, and every
-- mutation is conditional on still holding it.

ALTER TABLE idempotency_keys
    ADD COLUMN owner_token uuid NOT NULL DEFAULT gen_random_uuid();

COMMENT ON COLUMN idempotency_keys.owner_token IS
    'Minted per acquisition. completeClaim and releaseClaim are conditional on it, '
    'so an owner whose lease lapsed cannot modify its successor''s claim.';

-- -----------------------------------------------------------------------------
-- 2. Some document types are legitimately held more than once
-- -----------------------------------------------------------------------------
-- A tender needs one SBU but one SKK per key person, and may need a support
-- letter per supplier. Those are independent logical documents that happen to
-- share a type — and two of them can even hold byte-identical files.
--
-- Without this flag the ingestion path had no way to tell "the same document
-- uploaded twice" from "two documents of the same kind", and fell back to the
-- checksum, which answers neither question.

ALTER TABLE document_types
    ADD COLUMN allows_multiple boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN document_types.allows_multiple IS
    'True when a tender may hold several independent documents of this type. '
    'Identical content is then two submissions, not one repeated.';

UPDATE document_types SET allows_multiple = true
 WHERE code IN ('SKK_PERSONIL', 'SURAT_DUKUNGAN');

-- -----------------------------------------------------------------------------
-- 3. Audit intent has to outlive the broker
-- -----------------------------------------------------------------------------
-- Audits were coalesced by reusing one BullMQ job id per tender. That collapses
-- requests arriving before the audit starts, which is wanted — but a request
-- arriving while the audit is *active* resolved to the running job and was
-- silently dropped, so the document that triggered it was never audited. A
-- retained failed job held its id for a week and blocked the tender entirely.
--
-- Redis holds the schedule; this table holds the intent.

CREATE TABLE tender_audit_state (
    tender_id         uuid PRIMARY KEY REFERENCES tenders (id) ON DELETE CASCADE,
    organization_id   uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    -- An audit is owed. Set on request, cleared when a run takes it.
    pending           boolean     NOT NULL DEFAULT false,
    -- The job currently carrying that intent, unique per run so a retained
    -- failed job can never block the next one.
    scheduled_job_id  text,
    requested_at      timestamptz NOT NULL DEFAULT now(),
    last_audited_at   timestamptz
);

COMMENT ON TABLE tender_audit_state IS
    'Durable per-tender audit intent. The queue schedules; this records what is owed.';

-- The reconciler's query: intent with nothing live carrying it.
CREATE INDEX tender_audit_state_pending_idx
    ON tender_audit_state (requested_at)
    WHERE pending;

COMMIT;
