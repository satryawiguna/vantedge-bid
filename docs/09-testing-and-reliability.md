# 09 — Testing and reliability

**Purpose:** how the system is tested, how to run it, and what was actually verified. **Related:** [05](05-document-ingestion.md), [06](06-compliance-engine.md), [reviews/submission-review.md](reviews/submission-review.md).
**Sources:** `test/`, `jest.config.js`, `.github/workflows/ci.yml`. **Last verified:** layout and commands read 2026-11-01. **Test results below are historical** unless stated.

## Layout
- `test/unit/` — pure logic: file validation and signatures, field extraction, evaluators, request fingerprint, returning-rows helper, demo-mode configuration rules, `DemoModeGuard`, the demo service's response shaping, and the production start-up refusal.
- `test/integration/` — real PostgreSQL, Redis and (where named) real workers: ingestion, concurrency, recovery, promotion recovery, idempotent takeover, explicit slot validation, concurrent promotion, the demo organization directory (enabled and disabled), worker pipeline, audit scheduling / isolation / follow-up, schema drift.
- `test/helpers/` — real-PDF fixtures, compliance fixtures, seeding and `waitUntil`.
Integration suites skip themselves when `DATABASE_URL`/`REDIS_URL` are unset.

## Strategy
- Tests call the production service/processor methods; they do not re-type the service's SQL (an earlier ownership test did, and could not fail).
- **Concurrency** tests use barriers or real overlapping requests; **live-worker** tests (`worker-pipeline`, `concurrent-promotion`, `audit-followup`) run the real BullMQ processors.
- **Mutation checks:** each regression test is run against a deliberate break of its fix. Mutations must stay valid SQL/TypeScript, and runs use `--no-cache`.
- Only the integration suites need services; local-disk storage is used throughout, so **S3/MinIO behaviour is not covered by tests**.

## Commands
```bash
npm test               # unit only if DATABASE_URL/REDIS_URL are unset; everything otherwise
npm run typecheck && npx tsc --noEmit && npm run build
```
For integration runs use a **disposable** database and an **empty** Redis DB index (e.g. `redis://localhost:6379/9`) after `npm run migrate`, with `STORAGE_DRIVER=local`. `jest.config.js` sets `maxWorkers: 1`: the suites share Redis queue names, and in parallel one suite's worker consumes another's jobs.

## Verification status
Last full run (2026-11-01, fresh database, empty Redis DB, committed config, executed after the demo directory was added): **210 passed, 0 failed, 0 skipped — 104 unit + 106 integration, 22 suites**; `tsc --noEmit`, `npm run typecheck`, `npm run build` and `docker compose config --quiet` passed. The demo suites were each run against a deliberate mutation and failed (guard always open: 3 integration + 2 unit failures; full rows returned: 1; no `id` tie-breaker: 1; no maximum limit: 1; start-up check removed: 3). The empty-table case is covered at service level with a stubbed repository, because emptying `organizations` would be destructive on a developer database. Not verified: Docker runtime for the demo flag, S3/MinIO, production-scale load. The earlier 155-test figure (68 + 87) predates the demo directory.
