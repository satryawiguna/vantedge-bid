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

- The queue job id is the content checksum, so enqueueing is idempotent at the
  broker.
- `document_versions.checksum_sha256` is unique per organisation, so duplicate
  work is rejected by the database even if the broker is bypassed.
- An unreadable document is thrown as `UnrecoverableError` rather than retried,
  so terminal failures leave the retry loop immediately.

Together these turn at-least-once delivery into exactly-once *effect*.

## Consequences

**Good.** Admission cost is bounded and predictable. Workers scale on queue
depth, independently of request rate. A CPU-bound parse cannot block the event
loop that is meant to be accepting uploads. Retry and backoff policy lives in
one place.

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
