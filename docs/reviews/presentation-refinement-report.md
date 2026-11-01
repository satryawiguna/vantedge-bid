# Presentation refinement report

**Date:** 2026-11-01 · **Deliverable:** `docs/presentation/Vantedge Bid — Technical Walkthrough — Revised.pptx` (25 slides: 17 main, 1 divider, 7 appendix).
**Baseline:** the 14-slide "Vantedge Bid — Technical Walkthrough" Slides artifact. No `.pptx` of it exists in this repository; the artifact itself was not modified.
**Rule followed:** source code, `db/migrations/*.sql` and executed tests take precedence over earlier slides and docs. No application code, migration or test was changed.

## 1. Summary of changes

- Rebuilt the deck as a structured PowerPoint file (theme, two layouts, sections, speaker notes on every slide) that keeps the original identity: dark `#14181F` / light `#F4F2EC`, orange `#B04516` / `#F08A4B` accents, blue `#3B6FD9`, mono kickers. Fonts: Arial and Courier New stand in for IBM Plex Sans/Mono, so the file renders the same on any machine.
- Added a database overview, an end-to-end business workflow, a live example audit result and a seven-slide technical appendix.
- Corrected or qualified eight claims (section 6). The most significant: Redis losing an already-published ingestion job is **not** recovered automatically, and the fresh test run was **209/210**, not 210/210.
- Updated six documentation files and the README where the review found them inaccurate (section 9).

## 2. New slides

| # | Slide | Purpose |
|---|---|---|
| 5 | 04 · End-to-end workflow | Six stages, each with component, tables and output; marks the ingestion/compliance boundary and when an audit actually runs |
| 7 | 06 · Database overview | 15 tables in six responsibility groups; database-enforced vs convention |
| 12 | 11 · Example audit result | Live response: verdict, score, findings with actual-vs-expected evidence |
| 18 | Appendix divider | Index of A1–A7 with slide numbers |
| 19–20 | A1–A2 · Table catalog | All 15 tables: responsibility, enforced FKs, key constraints |
| 21 | A3 · ERD 1/2 | Tender documents and processing (Mermaid, rendered from `docs/ERD.md`) |
| 22 | A4 · ERD 2/2 | Compliance audit (drawn natively for legibility) |
| 23 | A5 · Ingestion sequence | 12 steps, actor, writes, failure window |
| 24 | A6 · Failure recovery detail | 7 scenarios: persisted state, detector, recovery, auto/client, test evidence |
| 25 | A7 · API demo | Calls and responses captured from a live run |

## 3. Existing slides changed

| Old slide | New slide | Change |
|---|---|---|
| Cover | 1 | States the main/appendix split |
| Problem | 2 | Each example now names its real rule code |
| Scope | 3 | Three columns: asked for, implemented and tested, deliberately not built. Pagination is described accurately |
| Architecture | 4 | Adds the reconciler, both queues and the API/worker split |
| Domain model | 6 | Keeps slot vs version; adds hybrid extraction (ADR 0004) with the JSONB keys `FieldExtractor` actually writes |
| Write path | 8 | Now 9 steps including the worker and status polling, plus four decision callouts |
| Validation gate | 9 | Full error codes; adds the 404/422 checks that run before the gate |
| Failure boundaries | 10 | Adds a Mode column (automatic or client retry) and splits Redis loss into the audit and ingestion cases |
| Compliance engine | 11 | Shows the ruleset → rule → evaluator → finding → audit chain, a real seeded rule, the evaluator's outcomes and the verdict formula. Immutability is qualified |
| Audit scheduling | 13 | Overlap fixed. The title is scoped to ingestion-triggered audits; a limits box names the manual endpoint and the redundant-audit race |
| API contract | 14 | Adds the demo directory and its conditions, and names the routes that need no header |
| Testing | 15 | Replaced with fresh-run figures; historical mutation evidence is labelled as such |
| Known gaps | 16 | Adds three gaps found in this review |
| Decisions | 17 | Unchanged in substance |

## 4. Database tables verified

Method: `npm run migrate` on an empty PostgreSQL 16 database, then `information_schema.tables` and `pg_constraint`.

| Table | Migration |
|---|---|
| organizations, users, tenders, document_types, tender_documents, document_versions, document_extractions, ingestion_jobs, idempotency_keys, compliance_rulesets, compliance_rules, compliance_audits, compliance_findings, audit_trail | `001_init_schema.sql` |
| tender_audit_state | `004_reliability_corrections.sql` |

Other schema facts checked:

- **Total:** 15 domain tables, plus the migrator's `schema_migrations` (`src/database/migrator.ts`).
- **Foreign keys:** 26.
- **Row-level security:** none (0 rows in `pg_policies`).
- **Triggers:** four, all `set_updated_at`. There is no immutability trigger.
- **Columns added later:** `ingestion_jobs.published_at` (003), `idempotency_keys.owner_token` and `document_types.allows_multiple` (004), `idempotency_keys.version_id` (006).
- **Seed data (002):** 20 document types, 17 of them `is_mandatory_default`, and 12 rules in ruleset `LKPP_KONSTRUKSI` v1.

## 5. Workflow diagrams and their sources

| Diagram | Supporting code |
|---|---|
| Architecture (slide 4) | `src/main.ts`, `src/worker.ts`, `worker.module.ts`, `ingestion.reconciler.ts` (`reconcile`, `reconcileAudits`) |
| Business workflow (slide 5) | `TendersService.create`, `DocumentsService.ingest`, `IngestionProcessor.process` / `requestAudit`, `ComplianceQueueService.requestAudit`, `ComplianceService.auditTender` / `completeAudit` |
| Write path (slide 8) and sequence (A5) | `DocumentsService.ingest`, `persist`, `claimIdempotencyKey`, `resolveDocumentSlot`, `nextVersionNumber`, `promoteToQueued`, `completeClaim`; `StorageService.buildObjectKey`; `IngestionQueueService.enqueue` |
| Failure recovery (slide 10, A6) | `resumeIfStalled`, `completePendingPromotion`, `republishIfUnpublished`, `IngestionReconciler`, `IngestionProcessor.recordFailure` / `quarantine`, `ComplianceAuditProcessor.onFailed`, `ComplianceQueueService.finishRun` / `restorePending` |
| Audit scheduling (slide 13) | `ComplianceQueueService` (`requestAudit`, `schedule`, `claimPending`, `finishRun`, `isJobLive`), `ComplianceAuditProcessor` |
| Compliance chain (slide 11) | `EvaluatorRegistry` (10 evaluators), `NotExpiredAtDeadlineEvaluator`, `ComplianceService.evaluate` / `completeAudit` / `resolveRuleset`, `BLOCKING_SEVERITIES` in `src/database/enums.ts` |
| ERD (A3, A4) | `docs/ERD.md` §2, checked against `pg_constraint` |

**Count:** 7 workflow or process diagrams (slides 4, 5, 8, 10, 13, A5, A6) plus 2 ERD slides.

## 6. Claims corrected or qualified

1. **Redis loses jobs, ingestion side.** Earlier slides and `docs/03` implied the reconciler re-drives all lost jobs. `IngestionReconciler.reconcile` selects only `published_at IS NULL`, so a job lost after it was published waits for a client retry (`republishIfUnpublished`). Audits are re-driven by `reconcileAudits`.
2. **Test results.** The earlier slide said 210 passed. The fresh run gave 209 passed and 1 failed; see section 8.
3. **"One audit at a time" and "exactly one follow-up".** These hold for ingestion-triggered audits only. The manual `POST …/compliance-audits` runs synchronously outside this coordination. The documented race can schedule a redundant run, and the test run reproduced it.
4. **Ruleset immutability.** The database blocks deletion of a cited ruleset or rule (`ON DELETE RESTRICT`) but not updates, so immutability is a convention. Findings snapshot the rule code and severity.
5. **Header requirement.** "Every /v1 endpoint requires `X-Organization-Id`" is wrong. `GET /v1/document-types` has no guard, and the demo directory uses `DemoModeGuard`. This was observed live.
6. **Audit totals.** `totals.rules` is the number of findings (`total_rules = findings.length`), not the number of rules. In the live run, 12 rules produced 35 findings.
7. **README audit example.** Its score of 72.73 does not match its own totals under the implemented formula. It is now 70.83 and labelled illustrative.
8. **ERD lifecycle note.** "quarantined (… infected)" implied malware scanning that does not exist. Quarantine means the file yielded no extractable text.

## 7. Remaining limitations, as presented

- No authentication, row-level security or composite tenant keys.
- No expiry or deadline scheduler: the `scheduled` and `deadline_approaching` triggers are never produced.
- No malware scanning, rate limiting or OCR.
- Pagination exists only on the demo directory.
- Ruleset and `audit_trail` immutability are conventions.
- A published ingestion job lost from Redis needs a client retry.
- Concurrent first requests can occasionally schedule a redundant audit.
- Extraction is heuristic. In the live run it read the bid bond's guarantor name as the holder name.
- The S3 path, the Docker runtime and production-scale load were not tested.

**Code observation, not changed:** the worker's lifecycle writes (`IngestionProcessor.setLifecycle` and `finishSuccessfully`) are unconditional updates. A redelivered job therefore re-processes a version (`processing` → `processed`) rather than being refused, which is consistent with at-least-once delivery. CLAUDE.md says "a processed version never regresses", and that holds strictly only for the API-side promotion.

## 8. Verification performed

**Test run**

- Fresh run: PostgreSQL 16, empty Redis DB 9, `STORAGE_DRIVER=local`, `npx jest --no-cache --ci`.
- Result: 22 suites (8 unit, 14 integration), 210 tests (104 unit, 106 integration). **209 passed, 1 failed, 0 skipped.**
- The failure was `audit-scheduling.spec.ts` › "coalesces several requests that arrive before the audit starts" (expected 1 job, got 2).
- That suite alone, rerun six times: 5 passes, 1 failure.

**Build checks:** `npm run typecheck`, `npx tsc --noEmit` and `npm run build` passed.

**Live run** (API + worker, `DEMO_MODE=true`, `NODE_ENV=development`, seeded):

- `/healthz`, `/readyz`, `/metrics/queue`, `/docs` and `GET /v1/demo/organizations` all returned 200.
- Uploaded four sample PDFs (202 each). A same-key retry returned 202 with `Idempotent-Replay: true`.
- The status endpoint without the header returned 400.
- The four uploads produced one ingestion-triggered audit: `non_compliant`, score 48.57, 35 findings. Slide 12 and A7 are taken from this run.

**Deck QA**

- `validate.py` passed.
- The deck was rendered through LibreOffice to PDF and images, and every slide was inspected.
- Fixes made after inspection:
  - left-aligned all titles
  - removed arrow-label overlaps on the architecture slide
  - rebuilt the workflow slide as a 2×3 grid, because component names were breaking mid-word
  - widened the status column on the audit table
  - re-rendered A3 with larger labels and redrew A4 natively
  - shortened wrapping identifiers in A6 and A7

## 9. Documentation updated

| File | Change |
|---|---|
| `docs/03-system-architecture.md` | Redis-loss failure boundary split into the audit and ingestion cases |
| `docs/04-data-model-and-erd.md` | Added a table catalog (15 tables, enforced relationships, conventions) |
| `docs/08-api-contracts.md` | Header requirement scoped correctly; `totals.rules` meaning added |
| `docs/09-testing-and-reliability.md` | Fresh 2026-11-01 run recorded above the historical one |
| `docs/11-known-gaps-and-roadmap.md` | Pagination nuance, intermittent test, lost published job, extractor misattribution |
| `docs/ERD.md` | Quarantine note corrected |
| `README.md` | Audit example labelled illustrative; score made consistent with the formula |

## 10. Items not independently verified

- **Mutation-testing evidence:** taken from `docs/09`, not re-run.
- **Recovery after a lost, already-published ingestion job:** derived from reading the code. No dedicated test covers it.
- **409 `idempotency_key_reused` and the synchronous manual audit endpoint:** covered by the existing tests, not exercised in the live capture.
- **Docker Compose runtime and the S3 driver:** not run.
- **Rendering in PowerPoint itself:** QA used LibreOffice, so minor font-metric differences are possible. All text uses Arial and Courier New to keep these small.
