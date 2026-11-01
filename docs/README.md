# Documentation index

The numbered documents give structured project context. They **link to** the canonical sources instead of repeating them; where two places seem to disagree, trust the order in [Sources of truth](#sources-of-truth).

| Doc | Topic |
|---|---|
| [00 — Project overview](00-project-overview.md) | What the product is, modules, stack, status |
| [01 — Challenge scope](01-challenge-scope.md) | Brief, implemented scope, deliberate exclusions |
| [02 — Domain and workflows](02-domain-and-workflows.md) | Entities and the workflows that connect them |
| [03 — System architecture](03-system-architecture.md) | Processes, queues, data flow, failure boundaries |
| [04 — Data model and ERD](04-data-model-and-erd.md) | Tables, constraints, migrations (ERD itself: [ERD.md](ERD.md)) |
| [05 — Document ingestion](05-document-ingestion.md) | Upload path, validation, slots/versions, recovery |
| [06 — Compliance engine](06-compliance-engine.md) | Rules, audits, scheduling, follow-up |
| [07 — Security and tenancy](07-security-and-tenancy.md) | What exists, and what does not |
| [08 — API contracts](08-api-contracts.md) | Endpoints, errors, idempotency |
| [09 — Testing and reliability](09-testing-and-reliability.md) | Test layout, commands, verification status |
| [10 — Deployment and operations](10-deployment-and-operations.md) | Config, Compose, migrations, health |
| [11 — Known gaps and roadmap](11-known-gaps-and-roadmap.md) | Limitations and next steps |

Other material: [ERD.md](ERD.md) (canonical data-relationship description), [adr/](adr/) (decision records), [reviews/](reviews/) (historical review reports — point-in-time, not current).

## Sources of truth

1. Application code — runtime behaviour.
2. `db/migrations/*.sql` — schema (applied migrations are never edited; see [ADR 0001](adr/0001-sql-first-schema.md)).
3. Integration tests — evidence for multi-component behaviour.
4. [ERD.md](ERD.md) — data relationships; [adr/](adr/) — why decisions were made.
5. The [root README](../README.md) — public overview; these documents — deeper context.

Each numbered document carries a "Last verified" line. It names what was actually checked and when; it is not a promise that later edits are covered.
