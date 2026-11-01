# 04 — Data model and ERD

**Purpose:** summarise the schema and where each rule is enforced. The diagrams and design reasoning live in **[ERD.md](ERD.md)** — that is the one canonical ERD description; this file does not duplicate it.
**Related:** [05](05-document-ingestion.md), [ADR 0001](adr/0001-sql-first-schema.md). **Sources:** `db/migrations/001–006`, `src/database/entities`. **Last verified:** 2026-11-01 (migrations applied to an empty database; 15 domain tables confirmed through `information_schema`, plus the migrator's own `schema_migrations`).

## Migrations (forward-only; checksummed by the migrator)
| File | Adds |
|---|---|
| `001_init_schema.sql` | 14 domain tables, enums, indexes, constraints |
| `002_seed_reference_data.sql` | document types, ruleset v1, rules |
| `003_ingestion_job_publication.sql` | `ingestion_jobs.published_at`, outbox index |
| `004_reliability_corrections.sql` | `idempotency_keys.owner_token`, `document_types.allows_multiple`, `tender_audit_state` (15th table) |
| `005_correct_schema_comments.sql` | comment corrections only |
| `006_idempotency_operation_link.sql` | `idempotency_keys.version_id` |

TypeORM `synchronize` is `false` (`src/database/data-source.ts`); entities are a hand-written mapping, checked by `test/integration/schema-drift.spec.ts`.

## Key relationships and constraints
- Slot → versions: `tender_documents 1—N document_versions`; `tender_documents.current_version_id` points at the active one. `UNIQUE (document_id, version_no)`.
- **Checksum uniqueness is per slot**: `UNIQUE (document_id, checksum_sha256)` (`document_versions_slot_checksum_key`). The non-unique `(organization_id, checksum_sha256)` index answers "are these bytes stored?" for object reuse. There is deliberately **no** tenant-wide unique checksum.
- No unique constraint on `(tender_id, document_type_code)`: multi-instance types (`allows_multiple`: `SKK_PERSONIL`, `SURAT_DUKUNGAN`) need several slots.
- `document_extractions.version_id` is unique (one extraction per version).
- `ingestion_jobs`: `UNIQUE (queue_name, job_key)`; `job_key = ingest-<versionId>`; partial index for unpublished queued rows.
- `tender_audit_state`: PK `tender_id`; FKs to `tenders` and `organizations` (`ON DELETE CASCADE`); partial index on `requested_at WHERE pending`.
- `idempotency_keys`: PK `(organization_id, key)`; `owner_token` (per acquisition); `version_id` FK to `document_versions` `ON DELETE SET NULL`.
- One active ruleset per code (`compliance_rulesets_one_active_idx`); `UNIQUE (code, version)`.
- Check constraints include slug/NPWP formats, `size_bytes > 0`, checksum hex pattern, confidence in [0,1], attempt bounds, audit verdict ⇔ completed.
- Cross-tenant integrity is **application-enforced** (every query filters `organization_id`); the database has no composite tenant foreign keys — see [07](07-security-and-tenancy.md).

## Table catalog
Verified 2026-11-01 by applying `001`–`006` to an empty PostgreSQL 16 database (`information_schema.tables`, `pg_constraint`): 15 domain tables and 26 foreign keys, plus the migrator's own `schema_migrations`. "FK" below means a database-enforced foreign key; everything else is a convention.

| Table | Responsibility | Database-enforced relationships |
|---|---|---|
| `organizations` | Tenant root | Parent of every tenant-owned table (`ON DELETE CASCADE`) |
| `users` | Members of an organisation | FK `organization_id`; referenced by `document_versions.uploaded_by` (`SET NULL`) |
| `tenders` | A bid being prepared | FK `organization_id`; `UNIQUE (organization_id, tender_code)` |
| `document_types` | Global reference data (20 seeded types) | Referenced by `tender_documents`, `compliance_rules` (`RESTRICT`) |
| `tender_documents` | Slot: one document requirement | FKs `tender_id`, `document_type_code`, `organization_id`; `current_version_id` → `document_versions` (`SET NULL`, deferrable) |
| `document_versions` | One uploaded file; lifecycle | FKs `document_id` (`CASCADE`), `organization_id`, `uploaded_by` (`SET NULL`) |
| `document_extractions` | Fields read from one version | FK `version_id` (`CASCADE`), unique |
| `ingestion_jobs` | Queue ledger / outbox | FKs `version_id` (`CASCADE`), `organization_id` |
| `idempotency_keys` | Request claims | PK `(organization_id, key)`; FK `version_id` (`SET NULL`) |
| `compliance_rulesets` | Versioned regulation (global) | Parent of rules (`CASCADE`); cited by audits (`RESTRICT`) |
| `compliance_rules` | One rule: severity, evaluator, params | FKs `ruleset_id` (`CASCADE`), `document_type_code` (`RESTRICT`, nullable) |
| `compliance_audits` | One evaluation run | FKs `tender_id` (`CASCADE`), `organization_id`, `ruleset_id` (`RESTRICT`) |
| `compliance_findings` | Per-rule result with evidence and snapshots | FKs `audit_id` (`CASCADE`), `rule_id` (`RESTRICT`), `document_id`/`version_id` (`SET NULL`) |
| `tender_audit_state` | Durable audit intent per tender | PK/FK `tender_id` (`CASCADE`); FK `organization_id` |
| `audit_trail` | Who changed what (append-only by convention) | FK `organization_id` only; `entity_id`, `actor_id` are not FKs |

Not enforced by the database: equality of a child's `organization_id` with its parent's, immutability of cited rulesets/rules (deletion is blocked by `RESTRICT`, updates are not), and immutability of `audit_trail`.
