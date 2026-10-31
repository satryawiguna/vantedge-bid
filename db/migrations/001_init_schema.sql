-- =============================================================================
-- Vantedge Bid — Tender Documents & Compliance Audit
-- Migration 001: initial schema
--
-- Design notes
--   * SQL-first schema. The ORM is a mapping layer, never the source of truth
--     for the schema (see docs/adr/0001-sql-first-schema.md).
--   * Every tenant-owned table carries organization_id so that row-level
--     isolation can be enforced in one place (Postgres RLS / Supabase).
--   * A document is a *logical* requirement; a document_version is the
--     *physical* file. Compliance is always evaluated against a version.
--   * Compliance rules are data, not code. Rulesets are versioned so an audit
--     performed in the past stays reproducible after the rules change.
-- =============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

-- -----------------------------------------------------------------------------
-- Enumerated lifecycles
-- -----------------------------------------------------------------------------
-- Native enums are used for closed, slow-moving state machines: they are
-- self-documenting in the ERD and rejected at write time. Open-ended
-- vocabularies (document types, rule evaluators) are lookup tables instead.

CREATE TYPE tender_status AS ENUM (
    'draft',       -- created, not yet pursued
    'monitoring',  -- watching the LPSE announcement
    'preparing',   -- assembling bid documents
    'submitted',
    'won',
    'lost',
    'cancelled'
);

CREATE TYPE document_lifecycle AS ENUM (
    'pending',      -- row created, bytes not yet committed to storage
    'queued',       -- handed to the ingestion queue
    'processing',   -- a worker holds it
    'processed',    -- text + metadata extracted, ready for audit
    'failed',       -- processing failed after all retries
    -- Terminal, and distinct from 'failed': the file was read and judged
    -- unusable (no text layer, corrupt, encrypted), so retrying cannot help.
    -- NOTE: there is no malware scanning in this service. If one is added, its
    -- rejections belong in this state too.
    'quarantined'
);

CREATE TYPE ingestion_job_state AS ENUM (
    'queued',
    'active',
    'completed',
    'failed',
    'dead_letter'
);

CREATE TYPE rule_severity AS ENUM (
    'blocker',   -- bid will be disqualified
    'critical',
    'major',
    'minor',
    'info'
);

CREATE TYPE finding_status AS ENUM (
    'pass',
    'fail',
    'warning',
    'not_applicable',
    'inconclusive'  -- extraction confidence too low to decide
);

CREATE TYPE audit_status AS ENUM ('queued', 'running', 'completed', 'failed');

CREATE TYPE audit_verdict AS ENUM (
    'compliant',
    'compliant_with_warnings',
    'non_compliant'
);

-- -----------------------------------------------------------------------------
-- Tenancy
-- -----------------------------------------------------------------------------

CREATE TABLE organizations (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug        text        NOT NULL,
    name        text        NOT NULL,
    npwp        text,                       -- tax ID, used for cross-document consistency checks
    nib         text,                       -- business identification number (OSS)
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT organizations_slug_key   UNIQUE (slug),
    CONSTRAINT organizations_slug_check CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
    CONSTRAINT organizations_npwp_check CHECK (npwp IS NULL OR npwp ~ '^[0-9]{15,16}$')
);

COMMENT ON TABLE organizations IS
    'Tenant root. One contractor company subscribing to Vantedge Bid.';

CREATE TABLE users (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    email            text        NOT NULL,
    full_name        text        NOT NULL,
    role             text        NOT NULL DEFAULT 'member',
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT users_role_check CHECK (role IN ('owner', 'admin', 'member', 'auditor'))
);

CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));
CREATE INDEX users_organization_id_idx   ON users (organization_id);

-- -----------------------------------------------------------------------------
-- Module 1 — Tender Documents
-- -----------------------------------------------------------------------------

CREATE TABLE tenders (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    tender_code         text        NOT NULL,          -- LPSE/SPSE package code
    title               text        NOT NULL,
    buyer_name          text        NOT NULL,          -- procuring entity (K/L/PD)
    buyer_lpse_code     text,
    work_category       text,                          -- e.g. 'bangunan_gedung', 'jalan_jembatan'
    required_sbu_codes  text[]      NOT NULL DEFAULT '{}',  -- e.g. {'BG009','SI003'}
    estimated_value     numeric(18, 2),                -- HPS / pagu, in currency below
    currency            char(3)     NOT NULL DEFAULT 'IDR',
    submission_deadline timestamptz,
    source_url          text,
    status              tender_status NOT NULL DEFAULT 'monitoring',
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT tenders_org_code_key        UNIQUE (organization_id, tender_code),
    CONSTRAINT tenders_estimated_value_chk CHECK (estimated_value IS NULL OR estimated_value >= 0)
);

CREATE INDEX tenders_org_status_idx   ON tenders (organization_id, status);
CREATE INDEX tenders_deadline_idx     ON tenders (submission_deadline)
    WHERE status IN ('monitoring', 'preparing');

COMMENT ON COLUMN tenders.required_sbu_codes IS
    'Business entity certification codes the announcement requires; compared against the SBU document extraction.';

-- Reference data, not an enum: the catalogue of document types grows with
-- regulation and must be editable without a deployment.
CREATE TABLE document_types (
    code                text PRIMARY KEY,
    name                text        NOT NULL,
    category            text        NOT NULL,   -- administrasi | kualifikasi | teknis | harga
    description         text,
    has_expiry          boolean     NOT NULL DEFAULT false,
    is_mandatory_default boolean    NOT NULL DEFAULT true,
    allowed_mime_types  text[]      NOT NULL DEFAULT '{application/pdf}',
    max_size_bytes      bigint      NOT NULL DEFAULT 26214400,  -- 25 MiB
    created_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT document_types_category_check
        CHECK (category IN ('administrasi', 'kualifikasi', 'teknis', 'harga')),
    CONSTRAINT document_types_max_size_check
        CHECK (max_size_bytes > 0 AND max_size_bytes <= 1073741824)
);

-- The logical document slot on a tender ("the SBU for this bid").
CREATE TABLE tender_documents (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    tender_id           uuid        NOT NULL REFERENCES tenders (id) ON DELETE CASCADE,
    document_type_code  text        NOT NULL REFERENCES document_types (code) ON DELETE RESTRICT,
    title               text        NOT NULL,
    is_mandatory        boolean     NOT NULL DEFAULT true,
    current_version_id  uuid,                           -- FK added below (circular)
    deleted_at          timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tender_documents_tender_idx ON tender_documents (tender_id)
    WHERE deleted_at IS NULL;
CREATE INDEX tender_documents_type_idx   ON tender_documents (tender_id, document_type_code)
    WHERE deleted_at IS NULL;

COMMENT ON TABLE tender_documents IS
    'A required document slot on a tender. Several rows may share a type (e.g. one SKK per key personnel).';

-- The physical file. Immutable once written: a correction creates a new row.
CREATE TABLE document_versions (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    document_id      uuid        NOT NULL REFERENCES tender_documents (id) ON DELETE CASCADE,
    version_no       integer     NOT NULL,
    original_filename text       NOT NULL,
    storage_bucket   text        NOT NULL,
    storage_key      text        NOT NULL,
    mime_type        text        NOT NULL,
    size_bytes       bigint      NOT NULL,
    checksum_sha256  char(64)    NOT NULL,
    page_count       integer,
    lifecycle        document_lifecycle NOT NULL DEFAULT 'pending',
    uploaded_by      uuid        REFERENCES users (id) ON DELETE SET NULL,
    uploaded_at      timestamptz NOT NULL DEFAULT now(),
    processed_at     timestamptz,
    failure_reason   text,
    metadata         jsonb       NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT document_versions_version_key   UNIQUE (document_id, version_no),
    -- Deliberately NOT unique. Storage is content-addressed, so every version
    -- holding identical bytes points at the same object. One certificate
    -- submitted to twelve tenders is one object and twelve version rows.
    CONSTRAINT document_versions_version_check CHECK (version_no >= 1),
    CONSTRAINT document_versions_size_check    CHECK (size_bytes > 0),
    CONSTRAINT document_versions_checksum_check CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$')
);

-- De-duplication is scoped to the document slot, not the tenant.
--
-- A contractor submits the same SBU, NIB and NPWP to every tender they bid for;
-- that is the normal case. A tenant-wide unique index treats the second tender's
-- upload as a duplicate and discards it, leaving that tender's slot empty while
-- the API reports success. Uniqueness therefore belongs on (document_id,
-- checksum): the same bytes twice in one slot is a retry, the same bytes in a
-- different slot is a different document.
CREATE UNIQUE INDEX document_versions_slot_checksum_key
    ON document_versions (document_id, checksum_sha256);

-- Non-unique: supports "is this content already stored for this tenant?", which
-- is what lets a repeat upload skip the object write.
CREATE INDEX document_versions_org_checksum_idx
    ON document_versions (organization_id, checksum_sha256);

CREATE INDEX document_versions_storage_key_idx  ON document_versions (storage_bucket, storage_key);
CREATE INDEX document_versions_document_idx  ON document_versions (document_id, version_no DESC);
CREATE INDEX document_versions_lifecycle_idx ON document_versions (lifecycle, uploaded_at)
    WHERE lifecycle IN ('pending', 'queued', 'processing');

ALTER TABLE tender_documents
    ADD CONSTRAINT tender_documents_current_version_fkey
    FOREIGN KEY (current_version_id) REFERENCES document_versions (id)
    ON DELETE SET NULL
    DEFERRABLE INITIALLY DEFERRED;

-- One extraction per version. Kept separate from document_versions so the file
-- record stays small and the extractor can be re-run without touching it.
CREATE TABLE document_extractions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    version_id          uuid        NOT NULL REFERENCES document_versions (id) ON DELETE CASCADE,
    text_storage_key    text,                       -- full text lives in object storage, not in the row
    document_number     text,
    issuer              text,
    holder_name         text,                       -- company name printed on the document
    holder_npwp         text,
    issued_at           date,
    expires_at          date,
    classification_codes text[]     NOT NULL DEFAULT '{}',  -- SBU subclassifications found
    monetary_value      numeric(18, 2),             -- e.g. bid bond amount
    -- Fields that exist only on certain document types: KBLI activity codes on
    -- an NIB, the qualification grade on an SBU, the guarantor on a bid bond.
    -- Giving each of those its own column would produce a table that is mostly
    -- NULL and grows a column per regulation change.
    extracted_data      jsonb       NOT NULL DEFAULT '{}'::jsonb,
    confidence          numeric(4, 3) NOT NULL DEFAULT 1.000,
    extractor_version   text        NOT NULL,
    -- Diagnostics about the extraction run itself, not about the document.
    raw                 jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT document_extractions_version_key   UNIQUE (version_id),
    CONSTRAINT document_extractions_confidence_chk CHECK (confidence >= 0 AND confidence <= 1),
    CONSTRAINT document_extractions_dates_chk
        CHECK (issued_at IS NULL OR expires_at IS NULL OR expires_at >= issued_at)
);

CREATE INDEX document_extractions_expiry_idx ON document_extractions (expires_at)
    WHERE expires_at IS NOT NULL;

COMMENT ON COLUMN document_extractions.extracted_data IS
    'Document-type-specific fields. Promotion rule: a field earns a real column once a '
    'compliance rule, a filter or a join depends on it; until then it lives here. The '
    'intermediate step, when a field is queried but not yet worth a migration, is a GIN or '
    'expression index on this column. None is created yet because nothing queries it.';

COMMENT ON COLUMN document_extractions.raw IS
    'Diagnostics about the extraction run (text length, streams decoded), not document content.';

-- Queue bookkeeping mirrored into Postgres. The broker (Redis/BullMQ) owns the
-- live state; this table is the durable, queryable history used for retry
-- analysis, dead-letter review and throughput dashboards.
CREATE TABLE ingestion_jobs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    version_id      uuid        NOT NULL REFERENCES document_versions (id) ON DELETE CASCADE,
    queue_name      text        NOT NULL,
    job_key         text        NOT NULL,   -- BullMQ jobId; deterministic, derived from checksum
    state           ingestion_job_state NOT NULL DEFAULT 'queued',
    attempt         integer     NOT NULL DEFAULT 0,
    max_attempts    integer     NOT NULL DEFAULT 5,
    priority        integer     NOT NULL DEFAULT 100,
    enqueued_at     timestamptz NOT NULL DEFAULT now(),
    started_at      timestamptz,
    finished_at     timestamptz,
    duration_ms     integer,
    error_class     text,
    error_message   text,

    CONSTRAINT ingestion_jobs_job_key_key  UNIQUE (queue_name, job_key),
    CONSTRAINT ingestion_jobs_attempt_chk  CHECK (attempt >= 0 AND attempt <= max_attempts)
);

CREATE INDEX ingestion_jobs_state_idx   ON ingestion_jobs (state, enqueued_at);
CREATE INDEX ingestion_jobs_version_idx ON ingestion_jobs (version_id);

-- API-level idempotency for the ingestion endpoint. A client that retries an
-- upload after a timeout gets the original response rather than a duplicate.
CREATE TABLE idempotency_keys (
    organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    key             text        NOT NULL,
    endpoint        text        NOT NULL,
    request_hash    char(64)    NOT NULL,
    response_status integer,
    response_body   jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL DEFAULT now() + interval '24 hours',

    CONSTRAINT idempotency_keys_pkey PRIMARY KEY (organization_id, key)
);

CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);

-- -----------------------------------------------------------------------------
-- Module 2 — Compliance Audit
-- -----------------------------------------------------------------------------

-- A versioned snapshot of the regulation in force. Audits reference the ruleset
-- they ran under, so a past verdict can always be explained after rules change.
--
-- Rulesets are GLOBAL, not per-tenant: every organisation is audited against the
-- same published regulation. Per-tenant rule overrides would need an
-- organization_id here and in compliance_rules; that is a product decision, not
-- an oversight.
--
-- Treated as immutable by convention only. Nothing in this schema prevents an
-- UPDATE to a ruleset an audit has already cited, which would silently rewrite
-- that audit's meaning. Enforcing it needs a trigger; see the README's
-- limitations section.
CREATE TABLE compliance_rulesets (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code           text        NOT NULL,   -- e.g. 'LKPP_KONSTRUKSI'
    version        integer     NOT NULL,
    name           text        NOT NULL,
    description    text,
    effective_from date        NOT NULL,
    effective_to   date,
    is_active      boolean     NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT compliance_rulesets_version_key UNIQUE (code, version),
    CONSTRAINT compliance_rulesets_period_chk
        CHECK (effective_to IS NULL OR effective_to > effective_from)
);

-- Only one active version per ruleset code.
CREATE UNIQUE INDEX compliance_rulesets_one_active_idx
    ON compliance_rulesets (code) WHERE is_active;

CREATE TABLE compliance_rules (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ruleset_id         uuid        NOT NULL REFERENCES compliance_rulesets (id) ON DELETE CASCADE,
    code               text        NOT NULL,
    name               text        NOT NULL,
    description        text,
    document_type_code text        REFERENCES document_types (code) ON DELETE RESTRICT,
    severity           rule_severity NOT NULL DEFAULT 'major',
    evaluator          text        NOT NULL,   -- handler key resolved at runtime
    params             jsonb       NOT NULL DEFAULT '{}'::jsonb,
    is_active          boolean     NOT NULL DEFAULT true,
    created_at         timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT compliance_rules_code_key UNIQUE (ruleset_id, code)
);

CREATE INDEX compliance_rules_ruleset_idx ON compliance_rules (ruleset_id) WHERE is_active;

COMMENT ON COLUMN compliance_rules.document_type_code IS
    'NULL means the rule is evaluated at tender level rather than against one document.';
COMMENT ON COLUMN compliance_rules.evaluator IS
    'Key of a registered evaluator implementation (document_present, not_expired, ...). Rules are data; evaluators are code.';

CREATE TABLE compliance_audits (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    tender_id       uuid        NOT NULL REFERENCES tenders (id) ON DELETE CASCADE,
    ruleset_id      uuid        NOT NULL REFERENCES compliance_rulesets (id) ON DELETE RESTRICT,
    trigger         text        NOT NULL DEFAULT 'manual',
    status          audit_status NOT NULL DEFAULT 'queued',
    verdict         audit_verdict,
    score           numeric(5, 2),
    total_rules     integer     NOT NULL DEFAULT 0,
    passed_count    integer     NOT NULL DEFAULT 0,
    failed_count    integer     NOT NULL DEFAULT 0,
    warning_count   integer     NOT NULL DEFAULT 0,
    started_at      timestamptz,
    completed_at    timestamptz,
    error_message   text,
    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT compliance_audits_trigger_chk
        CHECK (trigger IN ('manual', 'document_ingested', 'scheduled', 'deadline_approaching')),
    CONSTRAINT compliance_audits_score_chk
        CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
    CONSTRAINT compliance_audits_verdict_chk
        CHECK ((status = 'completed') = (verdict IS NOT NULL))
);

CREATE INDEX compliance_audits_tender_idx ON compliance_audits (tender_id, created_at DESC);
CREATE INDEX compliance_audits_open_idx   ON compliance_audits (status, created_at)
    WHERE status IN ('queued', 'running');

-- One row per rule evaluation. Severity and rule code are snapshotted so a
-- historical finding keeps its original meaning if the rule is later edited.
CREATE TABLE compliance_findings (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    audit_id           uuid        NOT NULL REFERENCES compliance_audits (id) ON DELETE CASCADE,
    rule_id            uuid        NOT NULL REFERENCES compliance_rules (id) ON DELETE RESTRICT,
    rule_code_snapshot text        NOT NULL,
    severity_snapshot  rule_severity NOT NULL,
    status             finding_status NOT NULL,
    document_id        uuid        REFERENCES tender_documents (id) ON DELETE SET NULL,
    version_id         uuid        REFERENCES document_versions (id) ON DELETE SET NULL,
    message            text        NOT NULL,
    evidence           jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX compliance_findings_audit_idx    ON compliance_findings (audit_id, severity_snapshot);
CREATE INDEX compliance_findings_failing_idx  ON compliance_findings (audit_id)
    WHERE status IN ('fail', 'warning');
CREATE INDEX compliance_findings_document_idx ON compliance_findings (document_id)
    WHERE document_id IS NOT NULL;

-- Append-only trail. A compliance product has to be able to answer
-- "who changed what, when" without relying on mutable rows.
CREATE TABLE audit_trail (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    entity_type     text        NOT NULL,
    entity_id       uuid        NOT NULL,
    action          text        NOT NULL,
    actor_type      text        NOT NULL DEFAULT 'system',
    actor_id        uuid,
    payload         jsonb       NOT NULL DEFAULT '{}'::jsonb,
    occurred_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT audit_trail_actor_type_chk CHECK (actor_type IN ('user', 'system', 'worker'))
);

CREATE INDEX audit_trail_entity_idx ON audit_trail (entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_trail_org_idx    ON audit_trail (organization_id, occurred_at DESC);

-- -----------------------------------------------------------------------------
-- updated_at maintenance
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER organizations_set_updated_at    BEFORE UPDATE ON organizations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER users_set_updated_at            BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER tenders_set_updated_at          BEFORE UPDATE ON tenders
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER tender_documents_set_updated_at BEFORE UPDATE ON tender_documents
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
