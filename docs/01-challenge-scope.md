# 01 — Challenge scope

**Purpose:** separate what the brief asked for from what was built and what was deliberately left out. **Related:** [00](00-project-overview.md), [11](11-known-gaps-and-roadmap.md).
**Sources:** [root README](../README.md) ("What runs, and what is only designed", "Deliberate scope boundaries"). **Last verified:** 2026-11-01.

The original brief text is **not stored in this repository**. The objectives below are reconstructed from what the README states about it ("the two modules in the brief"); nothing here is a quotation of the brief.

## Objectives (as the README states them)
- A **Tender Documents** module: upload a tender's document package, validate, process, extract fields.
- A **Compliance Audit** module: audit the package against a versioned ruleset before submission.
- A PostgreSQL schema with an ERD, an ingestion REST API, a queue and worker, request idempotency and de-duplication, and OpenAPI documentation.

## Requirements as implemented
| Area | Implemented |
|---|---|
| Functional | Tender registration; document ingestion with eight validation checks; slot/version model; asynchronous extraction; rule-based audits with per-finding evidence; audit history |
| Non-functional | Durable state in PostgreSQL; idempotent uploads; crash recovery for the API↔storage↔broker gaps; asynchronous scaling via a separate worker; tenant-scoped queries; 155 automated tests |

## Deliverables
Source, six migrations, ERD ([ERD.md](ERD.md)), five ADRs, README, OpenAPI at `/docs`, Docker Compose, CI workflow, tests.

## Deliberately excluded
Authentication, RLS, malware scanning, expiry/deadline scheduler, pagination, rate limiting, wired-up presigned uploads, OCR, AI/LLM-based compliance (described only as a vision in the README). Details and rationale: [11](11-known-gaps-and-roadmap.md).

## Acceptance evidence
`npm test` (104 unit + 106 integration at the last full run — see [09](09-testing-and-reliability.md) for what was verified and when), `npm run build`, `npm run typecheck`, migrations applying cleanly to an empty database.
