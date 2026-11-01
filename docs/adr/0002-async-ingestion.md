# ADR 0002 — Asynchronous ingestion behind a queue

**Status:** accepted · **Date:** 2026-10-31

## Context

Tender deadlines cluster. An announcement closes at 10:00 and the document
packages for it arrive in the preceding two hours, so the service is quiet and
then abruptly is not. Losing an upload at 09:52 on deadline day is the worst
outcome this system can produce.

Processing a document is CPU-bound and highly variable: a two-page certificate
and a four-hundred-page method statement differ by two orders of magnitude.
Holding an HTTP connection open for the duration couples admission capacity to
the slowest document in the batch — exactly when admission matters most.

## Decision

The ingestion endpoint validates, stores, enqueues and returns `202 Accepted`
with a `statusUrl`. Extraction and the compliance audit run in a separate worker
process consuming a Redis/BullMQ queue.

Three properties make the asynchrony safe rather than merely convenient:

- The queue job id is derived from the version id (`ingest-<versionId>`), so
  enqueueing is idempotent at the broker. (It was originally the content
  checksum; that stopped identifying work once the same bytes could belong to
  two slots.)
- `document_versions` is unique on `(document_id, checksum_sha256)` — the same
  content in the same slot — so a duplicate in one slot is rejected by the
  database even if the broker is bypassed.
- An unreadable document is thrown as `UnrecoverableError` rather than retried,
  so terminal failures leave the retry loop immediately.

Together these turn at-least-once delivery into exactly-once *effect*.

## Consequences

**Good.** Admission cost is bounded and predictable. Workers scale on queue
depth, independently of request rate. A CPU-bound parse cannot block the event
loop that is meant to be accepting uploads. Retry and backoff policy lives in
one place.

**Amended since.** Two parts of this decision were refined once the system was
run under load:

- The post-ingestion audit was moved onto its own queue
  ([ADR 0005](0005-audit-on-its-own-queue.md)), because running it inside the
  ingestion job fused two unrelated failure domains.
- Publication is recorded durably (`ingestion_jobs.published_at`) and swept by
  `IngestionReconciler`, so a process that dies between the commit and the
  publish no longer leaves work nobody will do. The commit-then-publish ordering
  itself is unchanged and remains the point.

**Bad.** The client must poll, so "uploaded" and "checked" are different states
it has to model. Redis becomes a availability dependency for ingestion —
mitigated by `appendonly yes`, so queued jobs survive a restart. A queue can
also hide a problem by absorbing it, which is why oldest-job-age is monitored
rather than depth alone.

**Also considered.** Processing inline and returning `200` with the audit
result. Simpler, and genuinely adequate at low volume — rejected because the
brief's scaling question is precisely the case where it fails, and retrofitting
a queue later means changing the API contract that clients have already built
against.
