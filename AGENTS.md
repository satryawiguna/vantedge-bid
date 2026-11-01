# AGENTS.md — shared engineering guidance

Tool-neutral rules for anyone (human or AI agent) changing Vantedge Bid. Project context lives in [docs/README.md](docs/README.md); this file is only the working agreement. Do not copy architecture here — link to it.

## General
- Inspect before editing: `git status`, the relevant code, and the doc that describes it. Make the smallest complete change; no drive-by refactors.
- Runtime behaviour is defined by the code; the schema by `db/migrations/`. If a doc disagrees with them, fix the doc (or report it), not the other way round.
- Never weaken or delete a test to make a change pass. Fix the cause, or explain why the test was wrong.

## Database and migrations
- SQL-first: every schema change is a **new, numbered, forward-only** file in `db/migrations/`. Never edit an applied migration (the migrator checksums them and refuses a changed one).
- TypeORM `synchronize` stays `false`. Entities are a mapping; update them with the migration and keep `test/integration/schema-drift.spec.ts` green.
- Put real invariants in the database (constraints, unique and partial indexes). Application checks are conventions and must be documented as such.

## Transactions, concurrency, queues
- PostgreSQL is the durable record. **Commit intent first, publish to the queue after.** Never publish state that is not yet committed.
- State transitions are monotonic and conditional (`UPDATE … WHERE <expected state>`); decide races in SQL, not from entities read earlier.
- Use `returningRows()` for `UPDATE … RETURNING` row counts: TypeORM returns `[rows, count]`, so `result.length === 0` is always false.
- Idempotency keys identify a *request*; checksums identify *content*. Never use one for the other.
- Await every async call; background timers must `.catch`.

## API, errors, logging
- Throw `AppError` with a code from `error-codes.ts`; keep RFC 7807 responses and status mapping consistent. Unknown or foreign-tenant resources are 404, not 403.
- Validate input at the edge (DTOs, pipes, the upload gate). Log structured data, never secrets, file contents or full request bodies.
- Ingestion failure and compliance-audit failure are separate failure domains; do not couple them.

## Security and tenancy
- Every tenant-owned query filters by `organization_id`. Do not claim controls that do not exist: there is no authentication, no RLS and no composite tenant constraint (see docs/07).
- No secrets in the repo; only `.env.example` is committed.

## Tests
- Integration tests call the real service/processor, not copies of its SQL. Concurrency tests use barriers, not hope.
- A regression test is only trusted after it fails against a deliberate mutation of its fix (valid code/SQL, `--no-cache`).
- Integration suites share Redis queue names: run serially (`jest.config.js` does) and use a disposable database and an **empty** Redis DB index.
- Report results exactly: executed/passed, executed/failed, skipped, not run, not verified.

## Documentation
- Link to canonical sources instead of duplicating: ERD → `docs/ERD.md`, decisions → `docs/adr/`, schema → migrations.
- Add an ADR for a decision that changes architecture; label superseded ones, do not rewrite history.
- Update the affected doc in the same change as the code.

## Git safety
- Never commit, amend, rebase, reset, clean, force-push or push unless explicitly told to. Preserve uncommitted changes you did not make. Do not stage files unasked.
