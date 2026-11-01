# 05 — Document ingestion

**Purpose:** how an upload becomes a processed version, and how each failure window is closed. **Related:** [03](03-system-architecture.md), [04](04-data-model-and-erd.md), [08](08-api-contracts.md).
**Sources:** `src/modules/documents/documents.service.ts`, `validation/`, `src/modules/ingestion/*`, `src/storage/*`, [ADR 0002](adr/0002-async-ingestion.md); evidence in `test/integration/{ingestion,recovery,promotion-recovery,idempotent-takeover,explicit-slot,concurrent-promotion,concurrency,worker-pipeline}.spec.ts`. **Last verified:** 2026-11-01 (code read; tests last executed 2026-10-31 — see [09](09-testing-and-reliability.md)).

## Endpoint and validation
`POST /v1/tenders/:tenderId/documents` (multipart: `file`, `documentTypeCode`, optional `documentId`, `title`, `isMandatory`; optional `Idempotency-Key`). Eight checks, cheapest first, each with its own error code: file present, non-empty, size (stricter of global cap and the type's limit), MIME allow-list, **magic bytes match the declared type**, filename extension (logged only), PDF not encrypted, SHA-256 computed. The table is in the [README](../README.md#validation-gate); code in `file-validator.service.ts` and `file-signature.ts`.

## Slots, versions, numbering
- A **slot** (`tender_documents`) is the requirement; a **version** (`document_versions`) is a file. A correction is a new version; nothing is overwritten.
- Single-instance types: every upload goes to the one slot as the next version. Multi-instance types (`allows_multiple`): an upload fills a genuinely empty slot, otherwise opens a new one. Allocation is serialised by `pg_advisory_xact_lock` on `(tender, type)`.
- `version_no` is contiguous per slot (row lock while reading the max). `current_version_id` only moves **forward** by `version_no`.
- **Explicit `documentId`**: validated *before* any retry lookup — exists, same tender and organisation, not deleted, same document type (`loadExplicitSlot`).

## Write path (ordering is the design)
1. Validate → optionally claim the idempotency key.
2. Transaction: resolve slot, insert version as `pending`, link the claim (`version_id`), write audit trail.
3. Store bytes (content-addressed; reused if a complete object of the same size exists).
4. Transaction: **conditional** `pending → queued` (`WHERE lifecycle = 'pending'`); only the request that performed the transition moves the slot pointer and writes the ledger row.
5. Publish to BullMQ (deterministic job id `ingest-<versionId>`), then set `published_at`.
6. Respond **202** with `statusUrl`.

## Recovery
- **Retry in the same slot** (same bytes; checksum identifies a submission only for single-instance types or with an explicit slot): `pending` → complete the promotion; `queued` → republish if no live job; terminal states are left alone.
- **Idempotency takeover**: a request whose claim lease expired is taken over by the *same* fingerprint; the claim's `version_id` lets the successor recover the original version instead of filing another. A different fingerprint gets `409`. A version whose object write failed is reopened to `pending` for the retrying owner.
- **Concurrent recovery**: the conditional transition means a stale request cannot overwrite `processed`; losers return the persisted lifecycle.
- **Reconciler** republishes `queued` rows with `published_at IS NULL` after a grace period.
- **Worker**: retries with exponential backoff to `INGESTION_MAX_ATTEMPTS`; an unreadable document throws `UnrecoverableError` and is quarantined. Ingestion success/failure is independent of audits.
