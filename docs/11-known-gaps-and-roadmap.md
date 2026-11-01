# 11 — Known gaps and roadmap

**Purpose:** be honest about what is missing; keep plans separate from facts. **Related:** [01](01-challenge-scope.md), [07](07-security-and-tenancy.md), [root README](../README.md#known-gaps-stated-rather-than-discovered).
**Sources:** README "Known gaps", the code. **Last verified:** 2026-11-01. Nothing in the Roadmap section exists.

## Current limitations (real, unfixed)
- No authentication/authorisation; no RLS; no composite tenant foreign keys.
- No malware scanning; no rate limiting. No pagination on the main API: `GET /v1/tenders` is capped at 100 rows and the audit history at 20. Only the demo organisation directory (`GET /v1/demo/organizations`) supports `limit`/`offset`.
- No expiry/deadline scheduler: `scheduled` and `deadline_approaching` audit triggers are accepted by the schema but never produced, so a certificate that expires inside a complete package is not noticed until something else triggers an audit.
- Ruleset and `audit_trail` immutability are conventions, not constraints.
- Presigned upload flow exists only as an unused `StorageService` method.
- Extraction is heuristic (text-layer PDFs, Indonesian keyword patterns); no OCR.
- The S3 storage path is exercised by neither the tests nor Compose (Compose uses local-disk storage because MinIO's public image is no longer available); no load testing. Local-disk storage is single-host only.
- Two concurrent first requests that see an unpublished audit job as not live can each schedule one — an occasional redundant audit. Observed as an intermittent failure of `audit-scheduling.spec.ts` › "coalesces several requests that arrive before the audit starts" (2 of 7 runs on 2026-11-01; see [09](09-testing-and-reliability.md)).
- An ingestion job that was published and then lost from Redis is not re-driven by the reconciler (it only handles `published_at IS NULL`); the version stays `queued` until the client retries the same upload.
- Extraction heuristics can misattribute fields: in a live run the bid-bond guarantor's name was read as the holder name, producing an `IDENTITY.NAME_CONSISTENT` failure (severity `major`, non-blocking).
- Residual jobs left in a shared Redis by earlier runs can fail harmlessly for tenders that no longer exist.

## Technical debt
- The ERD PNG that predates the recent work lives outside the repository and is stale; a renderer and a documented generation step are needed (e.g. `@mermaid-js/mermaid-cli`).
- Entities are hand-mapped over SQL; `schema-drift.spec.ts` guards drift but only for mapped columns.

## Possible next steps (not implemented)
1. Authentication (JWT) behind the existing guard seam, then RLS and composite tenant keys.
2. A repeatable scheduler for expiry/deadline re-audits.
3. Pagination, rate limiting, malware scanning on the `pending → queued` step.
4. Wire up presigned uploads and cover S3/MinIO in CI.
5. A documented ERD image build and a link/markdown check in CI.
6. AI-assisted extraction/audit narration — only as an advisory layer; see the README's production-vision section for the reasoning about where AI must not decide.
