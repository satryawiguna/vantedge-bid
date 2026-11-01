# Submission review — corrections pass and release verification

> **Historical, point-in-time record** of two final passes made on 2026-10-31/11-01. Counts and results below were executed on those dates against the working tree at commit `271d3c5` plus uncommitted changes. They are not re-verified by this file; re-run the commands in [09 — Testing and reliability](../09-testing-and-reliability.md) for current results.

## Corrections pass (four defects, each reproduced or mutation-checked)

| # | Defect | Fix | Regression test |
|---|---|---|---|
| 1 | An idempotency takeover after a partial failure filed a second logical document (reproduced: documents 1→2, ledger rows 1→2) | Migration `006` adds `idempotency_keys.version_id`, written in the filing transaction under the owner token; a takeover by the same fingerprint recovers that version | `test/integration/idempotent-takeover.spec.ts` |
| 2 | An explicit `documentId` of the wrong type returned the existing version as a valid retry (reproduced: 202) | `loadExplicitSlot` validates before the content-based retry lookup | `test/integration/explicit-slot.spec.ts` |
| 3 | Concurrent recovery could write `queued` over `processed` (mutation-confirmed; not reproduced on the original code) | Promotion is `UPDATE … WHERE lifecycle = 'pending'`; losers report the persisted state | `test/integration/concurrent-promotion.spec.ts` |
| 4 | A request arriving during an active audit scheduled a parallel audit instead of a follow-up (reproduced); one test asserted `['failed', null]` against a job id that could never match | The job slot is held for the whole run and freed by an atomic `finishRun`; failure handler acts only on the final attempt | `test/integration/audit-followup.spec.ts`; fixed `audit-isolation.spec.ts` |

Each regression test was run against a deliberate mutation of its fix and failed (ignore `version_id`: 2 failures; remove slot check: 1; drop the lifecycle condition: 2; remove follow-up scheduling: 2; free the slot at run start: 1). Jest was also pinned to one worker, because the integration suites share one Redis queue and their workers consumed each other's jobs when run in parallel.

## Release verification (executed 2026-10-31, fresh scratch database)

| Check | Result |
|---|---|
| `npm test` (serial, committed config) | 155 passed, 0 failed, 0 skipped — 68 unit + 87 integration, 18 suites |
| `npm run typecheck`, `npx tsc --noEmit`, `npm run build` | pass |
| `docker compose config --quiet` | pass |
| Migrations 001–006 on an empty database, then again | applied 6; second run "up to date"; 15 domain tables plus `schema_migrations` |
| Native API + worker, local storage: `/healthz`, `/readyz`, `/docs`, seed, one upload | all 200 / processed / audit completed |
| Docker runtime (`docker compose up`) | **not run** — daemon unavailable |
| S3 / MinIO | **not run** — all tests used local-disk storage |
| ERD PNG | **not regenerated** — no renderer or documented process |

Remaining risk noted then: two concurrent first requests that both see an unpublished audit job as not live can each schedule one (an occasional extra audit, pre-existing and harmless).
