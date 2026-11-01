# 02 — Domain and workflows

**Purpose:** define the entities and the workflows that connect them. **Related:** [04](04-data-model-and-erd.md), [05](05-document-ingestion.md), [06](06-compliance-engine.md).
**Sources:** [ERD.md](ERD.md), `src/database/enums.ts`, migrations `001`–`006`. **Last verified:** 2026-11-01.

## Entities
| Entity | Table | Meaning |
|---|---|---|
| Organization | `organizations` (+ `users`) | The tenant. Every tenant-owned row carries `organization_id`. |
| Tender | `tenders` | A bid being prepared (code, buyer, deadline, required SBU codes, estimated value). |
| Document type | `document_types` | Reference data: SBU, NIB, KSWP, SKK_PERSONIL … with MIME/size limits and `allows_multiple`. |
| Tender document (**slot**) | `tender_documents` | "This bid needs an SBU." The logical requirement; points at its current version. |
| Document version | `document_versions` | One uploaded file for a slot. Lifecycle `pending → queued → processing → processed`, or `failed`/`quarantined`. |
| Extraction | `document_extractions` | Fields read from a version (expiry, holder NPWP, classification codes, amounts…). |
| Ingestion job | `ingestion_jobs` | Ledger of queue work for a version; `published_at` records that the broker accepted it. |
| Ruleset / rule | `compliance_rulesets`, `compliance_rules` | Versioned regulation as data; each rule names a code evaluator. |
| Audit / finding | `compliance_audits`, `compliance_findings` | One evaluation run and its per-rule results (severity snapshotted). |
| Audit state | `tender_audit_state` | Durable "an audit is owed" intent and the job carrying it. |
| Idempotency key | `idempotency_keys` | Claim on a request; `owner_token`, `version_id`. |
| Audit trail | `audit_trail` | Append-only (by convention) record of who changed what. |

## Workflows
1. **Register a tender** → `POST /v1/tenders` also opens an empty slot for every document type that is mandatory by default, so a missing document shows up as an empty slot in the completeness rule rather than as nothing.
2. **Upload a document** → validate → record a `pending` version → store bytes → promote to `queued` (pointer, ledger row) → publish → **202**. [05](05-document-ingestion.md).
3. **Process** → worker extracts fields, version becomes `processed` (or `quarantined` if unreadable), then *requests* an audit.
4. **Audit** → debounced per tender; one run evaluates every active rule against the tender's current documents; a request arriving mid-run produces one follow-up. [06](06-compliance-engine.md).
5. **Correct a document** → a new upload to the same slot is a new version; old versions and old audits are never overwritten.
6. **Recover** → retries, takeover of a dead request's idempotency claim, and reconcilers repair the gaps between Postgres, storage and Redis. [05](05-document-ingestion.md), [03](03-system-architecture.md).
