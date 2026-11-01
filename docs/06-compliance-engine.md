# 06 — Compliance engine

**Purpose:** how rules become verdicts and how audits are scheduled. **Related:** [05](05-document-ingestion.md), [ADR 0003](adr/0003-rules-as-data.md), [ADR 0005](adr/0005-audit-on-its-own-queue.md).
**Sources:** `src/modules/compliance/*`, `db/migrations/002_seed_reference_data.sql`, `004`; evidence in `test/integration/{audit-followup,audit-scheduling,audit-isolation}.spec.ts`, `test/unit/evaluators.spec.ts`. **Last verified:** 2026-11-01 (code read; tests last executed 2026-10-31).

## Rules and evaluators
Rules are rows (`compliance_rules`): a code, a severity (`blocker`…`info`), a document type, an `evaluator` key and JSONB `params`. Evaluators are a **closed registry** of pure TypeScript functions over a pre-loaded snapshot (no I/O) — deliberately not an expression DSL ([ADR 0003](adr/0003-rules-as-data.md)). Ten evaluators are registered (`mandatory_documents_present`, `document_readable`, `conditionally_required`, `not_expired_at_deadline`, `issued_within_days`, `valid_for_days_after_deadline`, `field_consistency`, `extraction_confidence`, `classification_match`, `monetary_threshold`). Rule codes seeded in `002` include `DOC.MANDATORY_PRESENT`, `DOC.READABLE`, `SBU.NOT_EXPIRED`, `SBU.CLASSIFICATION_MATCH`, `SKK.NOT_EXPIRED`, `KSWP.FRESH`, `BOND.NOT_EXPIRED`, `BOND.AMOUNT_SUFFICIENT` and `BOND.REQUIRED_ABOVE_THRESHOLD` (the migration is the complete list). Finding statuses: `pass`, `fail`, `warning`, `not_applicable`, `inconclusive`.

## Rulesets
Versioned (`UNIQUE (code, version)`), one active per code. Selection requires both `is_active` **and** the effective-date window (`effective_from <= today < effective_to`). Findings snapshot rule code and severity, so a past audit stays explainable after rules change. Immutability of a cited ruleset is a **convention**, not enforced.

## Audit lifecycle
`auditTender` writes a `running` audit row first, evaluates, then completes it (`completed` with a verdict, or `failed`). Verdicts: `compliant`, `compliant_with_warnings`, `non_compliant`. History is append-only in practice: every run is a new row.
The manual endpoint (`POST /v1/tenders/:id/compliance-audits`) runs **synchronously** and does not use the queue or `tender_audit_state`.

## Scheduling after ingestion
State is split ([ADR 0005](adr/0005-audit-on-its-own-queue.md)): `tender_audit_state.pending` = an audit is owed; `scheduled_job_id` = the run carrying it (unique per run: `audit-<tenderId>-<uuid>`).
- **Coalescing:** requests while a job is waiting/delayed only set `pending`; the debounce (`AUDIT_DEBOUNCE_MS`) lets a burst collapse onto one audit. Exactly one concurrent caller wins the conditional claim and publishes.
- **Active run:** a run clears `pending` when it starts but **keeps** `scheduled_job_id` until it ends, so a request mid-audit schedules nothing — a tender never has two ingestion-triggered audits at once.
- **Follow-up:** `finishRun` frees the slot and returns `pending` in one statement; if set, the processor schedules one follow-up, which starts after the active audit ended and sees newly processed documents.
- **Failure:** the `failed` handler acts only on the *final* attempt: it restores `pending` and frees the slot. The reconciler (or the next request) schedules a new run under a fresh id; a retained failed BullMQ job never blocks it.
