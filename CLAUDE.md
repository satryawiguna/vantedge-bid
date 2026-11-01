# CLAUDE.md — Vantedge Bid

Vantedge Bid is a NestJS/TypeScript backend for **tender document ingestion and compliance auditing** (PostgreSQL, Redis/BullMQ, S3-compatible storage). Shared working rules:

@AGENTS.md

Orientation (kept short on purpose):

@docs/00-project-overview.md

## Source of truth (highest first)
1. **Application code** — runtime behaviour.
2. **`db/migrations/*.sql`** — schema (forward-only; never edit an applied one).
3. **Integration tests** (`test/integration/`) — evidence for multi-component behaviour.
4. **`docs/ERD.md`** — canonical data relationships. **`docs/adr/`** — decision records.
5. **`README.md`** — public overview. **`docs/NN-*.md`** — deeper context ([index](docs/README.md)).

## Read on demand (do not preload)
- Schema, constraints, migrations → `docs/04-data-model-and-erd.md`, `docs/ERD.md`
- Upload path, slots/versions, recovery → `docs/05-document-ingestion.md`
- Rules, audits, scheduling → `docs/06-compliance-engine.md`
- Tenancy and what is missing → `docs/07-security-and-tenancy.md`
- Endpoints and errors → `docs/08-api-contracts.md`
- Tests and how to run them → `docs/09-testing-and-reliability.md`
- Config and operations → `docs/10-deployment-and-operations.md`
- Limitations → `docs/11-known-gaps-and-roadmap.md`

## Design invariants — do not break
- Keep the **logical slot** (`tender_documents`) separate from the **physical version** (`document_versions`); never overwrite a version or rewrite a historical audit.
- **Checksum is content, not request identity.** Request identity is the idempotency key + fingerprint (+ `owner_token`, `version_id`).
- PostgreSQL is durable state: **commit intent, then publish**. Lifecycle transitions are monotonic and conditional (`pending → queued → processing → processed`); a processed version never regresses.
- Preserve idempotency and tenant boundaries (`organization_id` on every query; foreign tenants get 404).
- Ingestion failure and audit failure stay separate. Compliance rules stay data + a **closed evaluator registry**, not a DSL.
- Explicit SQL migrations only; TypeORM `synchronize` stays off.

## Workflow
1. Inspect `git status` and the relevant code/docs first; preserve uncommitted changes.
2. Identify the source of truth for the change; for non-trivial work state the plan before editing.
3. Add or update a regression test; run `npx tsc --noEmit`, `npm run build`, and the tests (integration needs Postgres + Redis; see docs/09).
4. Review your own diff (`git diff`, `git diff --check`); update affected docs in the same change.
5. Report verification honestly (passed / failed / skipped / not run). **Never commit or push without an explicit instruction.**

## Subagents (`.claude/agents/`)
Use only when the work is independent or benefits from isolated context; not for simple edits, and not all at once.
- `architecture-reviewer` — module boundaries, coupling, over-abstraction (read-only)
- `database-reviewer` — schema, migrations, entity mappings, constraints, transactions (read-only)
- `reliability-reviewer` — concurrency, idempotency, queue lifecycle, recovery, races (read-only)
- `security-reviewer` — tenancy, upload and storage safety, secrets, missing controls (read-only)
- `documentation-reviewer` — README/ERD/ADR/API-doc accuracy against code and migrations (read-only)
- `test-engineer` — writes and evaluates tests; does not edit application code unless asked

Reviewers cannot edit; they report findings, and the main session decides what to change.

## Commands
`npm run build` · `npx tsc --noEmit` · `npm run typecheck` · `npm test` · `npm run migrate` · `npm run start:dev` / `start:worker:dev` · `npm run seed`
