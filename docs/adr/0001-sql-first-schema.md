# ADR 0001 — SQL-first schema, ORM as a mapping layer

**Status:** accepted · **Date:** 2026-10-31

## Context

The service is a compliance product. Its correctness guarantees — a bid bond
amount that cannot be negative, a checksum that cannot repeat within a tenant,
exactly one active ruleset version — are only real if the database enforces
them. Application-level validation is bypassed by a background worker, a
migration script, or a future second service written in another language.

Schema-from-ORM tooling (TypeORM `synchronize`, Prisma's schema language)
expresses tables and simple indexes well, but expresses partial indexes, check
constraints, deferrable foreign keys, native enums, generated identity columns
and trigger functions poorly or not at all. Those are exactly the features this
schema depends on.

## Decision

The schema is authored as hand-written SQL migrations under `db/migrations/`
and is the single source of truth. The ORM is configured with
`synchronize: false` and is used only to map rows to typed objects and to build
queries.

## Consequences

**Good.** Constraints live where they are enforced. Migrations are reviewable as
SQL in a pull request. The schema can be applied to any Postgres — local Docker,
Supabase, RDS — without the application being present. The DDL is portable
documentation.

**Bad.** Entity definitions and SQL can drift — a column renamed in a migration
but not in its entity fails at runtime, on whichever endpoint happens to touch
it first. Mitigated by `test/integration/schema-drift.spec.ts`, which selects
one row through every entity against a freshly migrated database, so every
mapped column name is emitted and checked. CI runs it on each push.

**Also considered.** Prisma, for its developer experience and type safety. It
was rejected because partial indexes and check constraints have to be smuggled
in through `migration.sql` escape hatches anyway, which produces the same
hand-written SQL with an extra abstraction on top of it.
