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
