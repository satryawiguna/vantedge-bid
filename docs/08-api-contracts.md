# 08 — API contracts

**Purpose:** the HTTP surface as implemented. **Related:** [05](05-document-ingestion.md), [06](06-compliance-engine.md), [07](07-security-and-tenancy.md).
**Sources:** `src/modules/*/*.controller.ts`, `src/common/errors/*`, `src/main.ts`. Authoritative machine-readable form: Swagger UI at `/docs`, JSON at `/docs/openapi.json`. **Last verified:** 2026-11-01 (endpoint list taken from the controllers; `/healthz`, `/readyz`, `/docs` also exercised on a native run 2026-10-31).

## Conventions
- URI versioning: business endpoints are under `/v1`; probes are version-neutral.
- Every tenant-scoped `/v1` endpoint (tenders, documents, compliance) requires `X-Organization-Id: <uuid>` (optional `X-User-Id`), enforced by `OrganizationContextGuard`. Two `/v1` routes do not: `GET /v1/document-types` (global reference data, no guard) and `GET /v1/demo/organizations` (guarded by `DemoModeGuard` instead). No other authentication.
- Errors are RFC 7807 problem details (`application/problem+json`) with a machine-readable `code` from `error-codes.ts`.

## Endpoints
| Method | Path | Success | Notes |
|---|---|---|---|
| POST | `/v1/tenders` | 201 | Register a tender; opens a slot for each mandatory-by-default type |
| GET | `/v1/tenders` | 200 | List this organisation's tenders (capped, no pagination) |
| GET | `/v1/tenders/:tenderId` | 200 | Tender with its document slots |
| POST | `/v1/tenders/:tenderId/documents` | **202** | Multipart ingest; see below |
| GET | `/v1/documents/versions/:versionId/status` | 200 | Lifecycle, failure reason, extraction |
| GET | `/v1/document-types` | 200 | Reference data and limits (no `X-Organization-Id` needed) |
| POST | `/v1/tenders/:tenderId/compliance-audits` | 201 | **Synchronous** audit |
| GET | `/v1/tenders/:tenderId/compliance-audits` | 200 | History (capped) |
| GET | `/v1/compliance-audits/:auditId` | 200 | Report with findings, worst first. `totals.rules` is the number of findings (`compliance_audits.total_rules = findings.length`), not the number of rules |
| GET | `/healthz`, `/readyz`, `/metrics/queue` | 200 | Liveness; database+queue readiness; ingestion queue depth |
| GET | `/v1/demo/organizations` | 200 | **Demo only, disabled by default** (404 unless `DEMO_MODE=true` in a non-production environment); see below |

## Demo organization directory
`GET /v1/demo/organizations?limit=50&offset=0` — a read-only evaluation aid so a reviewer can find an `X-Organization-Id`. Swagger tag **Demo**. Not organisation management: there is no create, update or delete, and no other organisation endpoint exists.
- **Query:** `limit` integer 1–100 (default 50); `offset` integer ≥ 0 (default 0). Unknown or invalid parameters → **400**.
- **No `X-Organization-Id` required** (it lists tenants).
- **Response 200:** `{ "data": [{ "id", "slug", "name", "createdAt" }], "pagination": { "total", "limit", "offset" } }`, ordered `createdAt DESC, id DESC`. Only those four fields are returned (an explicit DTO; NPWP, NIB and user data are never selected). An empty table gives `data: []`, `total: 0`, still 200; nothing is created on request.
- **Disabled → 404**, identical to an unknown route (non-disclosing), unless `DEMO_MODE=true` **and** `NODE_ENV` ∈ {`development`, `test`, `demo`}. The check runs in a guard on every request. The application also refuses to start with `NODE_ENV=production` + `DEMO_MODE=true`, an invalid `DEMO_MODE`, or `DEMO_MODE=true` with an unset/unrecognised `NODE_ENV`. Default: off.

## Ingest
Multipart fields: `file` (required), `documentTypeCode` (required), `documentId`, `title`, `isMandatory`. Header `Idempotency-Key` optional. Response body: `documentId`, `versionId`, `versionNo`, `lifecycle`, `checksum`, `documentTypeCode`, `sizeBytes`, `jobId` (`ingest-<versionId>`), `statusUrl`, `deduplicated`; `Location` header points at the status URL. `lifecycle` reports the *persisted* state, which may already be past `queued` on a recovered request.

## Idempotency
- Same key + same request (tender, form fields, file bytes) → stored response with `Idempotent-Replay: true`.
- Same key + different request → **409** `idempotency_key_reused`.
- Same key + same request still running → **409** `idempotent_request_in_progress`.
- A request that died after filing its version is recovered by the next same-key request once the lease (`IDEMPOTENCY_CLAIM_LEASE_MS`) expires, without creating a second document. Keys live 24 hours.

## Error codes (typical status)
`validation_failed`/`file_missing`/`file_empty` 400 · `tender_not_found`/`document_not_found`/`document_type_not_found` 404 · `idempotency_key_reused`/`idempotent_request_in_progress`/`duplicate_document` 409 · `file_too_large` 413 · `unsupported_media_type`/`file_signature_mismatch`/`file_encrypted` 415 · `tender_deadline_passed` 422 · `storage_unavailable` and `internal_error` 500 (storage failures are raised through `AppError.internal`). `duplicate_document` is produced by the global exception filter on any unique-constraint violation. `queue_unavailable` is defined in `error-codes.ts` but nothing in `src/` currently throws it. The code list is in `src/common/errors/error-codes.ts`; exact statuses are set where each error is thrown.
