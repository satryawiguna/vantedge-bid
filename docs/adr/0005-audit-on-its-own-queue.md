# ADR 0005 — Compliance audits run on their own queue

**Status:** accepted · **Date:** 2026-10-31
**Amends:** [ADR 0002](0002-async-ingestion.md), which placed the post-ingestion
audit inside the ingestion job.

## Context

The audit triggered after a document is ingested originally ran inside the
ingestion job's `try` block. Two problems followed from that, and they are
different problems that happened to share a cause.

**Failure domains were fused.** An audit that threw was caught by the ingestion
handler, which marked the *document* failed and let BullMQ retry it. So a
compliance-engine fault was reported as a bad document, and the system responded
by re-parsing a file that had parsed perfectly. The two failures have nothing to
do with each other and were being treated as one.

**Work was amplified.** Each ingested document triggered a full audit of the
whole tender. Measured on a 41-document upload session: 41 audits and 2,193
finding rows, each audit re-evaluating every rule against every document.

## Decision

Ingestion-triggered audits are published to a separate BullMQ queue,
`compliance-audit`. The ingestion job's only remaining involvement is a request,
issued in a `finally` block after the ingestion outcome is already committed,
and only for documents that actually reached `processed`.

A burst of ingestions must collapse onto one audit. Nothing is lost by
collapsing: the audit evaluates the tender's current state when it runs, so the
survivor sees everything the dropped requests would have.

**How that collapsing is implemented changed once, and the change matters.**
The first version used one deterministic job id per tender, `audit-<tenderId>`,
and leaned on BullMQ ignoring an add whose id is already present. That is
correct only while the job is waiting. It fails in two states that a busy
tenant reaches routinely:

- While the job is **active**, an add resolves to the *running* job and returns
  it. The request is dropped, and the document that triggered it is never
  audited — a silent correctness hole in a compliance product, not a
  performance detail.
- A **failed** job is retained under that id. For as long as it sits there, the
  tender cannot be audited again at all.

So intent and schedule are now separate facts. `tender_audit_state` (migration
004) records per tender that an audit is **owed** (`pending`) and which run is
**scheduled** to carry it (`scheduled_job_id`, unique per run). The queue
schedules; Postgres remembers.

- A request sets `pending` and, if nothing live is scheduled, claims the right
  to schedule with a conditional `UPDATE … WHERE scheduled_job_id IS NULL` and
  publishes. Exactly one of several simultaneous callers wins that claim, so
  the de-duplication survives concurrency rather than depending on id
  collisions.
- A run calls `claimPending` **before** reading any documents. Anything that
  sets the flag after that point is work the run demonstrably did not see.
  `claimPending` clears `pending` but **keeps `scheduled_job_id`** for as long as
  the run is active, so a request arriving mid-audit finds the slot occupied
  and only sets the flag; it does not schedule a second audit beside the
  running one. (An earlier version cleared the id at run start, which let the
  follow-up start — after the debounce, with worker concurrency 2 — while the
  first audit was still running. That contradicted this ADR's own description
  of the follow-up.)
- On completion `finishRun` frees the slot (`UPDATE … WHERE scheduled_job_id =
  <this job> RETURNING pending`) and the processor schedules one follow-up if
  `pending` was set. Release and read are one statement, serialised with
  `requestAudit`'s upsert by the row lock, so a request is either seen by
  `finishRun` or finds the slot free — never lost between the two.
- A run that fails **for good** (final BullMQ attempt only — `failed` also fires
  for attempts that will be retried) restores `pending` and frees its slot, and
  `IngestionReconciler.reconcileAudits` schedules for any tender whose intent
  has no live job — covering a failed run and a publish that never reached the
  broker. The retry gets a new job id, so the retained failed job never blocks
  it.

The manual audit endpoint stays synchronous. It is a pure in-memory evaluation
over an already-loaded snapshot and the caller is waiting for the result.

## Consequences

**Good.** An audit failure can no longer corrupt a successful ingestion: it
fails its own job, retries on its own schedule, and is recorded as a failed
`compliance_audits` row. The two have independent retry policies, which they
should, because a transient database blip and an unparseable PDF call for
different responses. Measured amplification on the same 40-document burst fell
from 41 audits and 2,193 findings to **1 audit and 33 findings**.

**Bad.** Compliance state is now eventually consistent with respect to
ingestion: for the length of the debounce window, a tender's latest audit may
not include the document that was just processed. For a tool whose job is to be
checked before a submission deadline, seconds of staleness is not a meaningful
cost — but it is a real change from the previous behaviour.

A document finishing while an audit is already running is covered by the
`pending` flag rather than missed: the processor schedules one follow-up run, at
the cost of an occasional extra audit. That is the right trade — an extra audit
is wasted work, a skipped one is a wrong verdict.

**Cost.** One extra table, one row per audited tender, and a state machine that
has to be read to be understood. The previous version was three lines of job
options. The reason to accept the complexity is that the simple version was
wrong in a way no test short of a concurrent one would reveal, which is why
`test/integration/audit-scheduling.spec.ts` exercises coalescing, the
active-job follow-up and failure recovery directly.

`removeOnComplete` stays true for this queue, but the design no longer depends
on it: job ids are unique per run, so a retained job — completed or failed —
cannot occupy the name the next run needs. What it does depend on is
`claimPending` clearing `scheduled_job_id`, which is what frees the slot for
the next request.

**Also considered.** Keeping the audit inline and merely moving the `try/catch`.
That fixes the failure-domain problem in five lines and does nothing about
amplification. Since the queue solves both and the project already runs BullMQ
with a worker process, the extra machinery is one queue and one processor rather
than new infrastructure.
