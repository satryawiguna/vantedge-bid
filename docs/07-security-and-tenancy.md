# 07 — Security and tenancy

**Purpose:** state precisely which controls exist and which do not. **Related:** [04](04-data-model-and-erd.md), [11](11-known-gaps-and-roadmap.md), [root README](../README.md#known-gaps-stated-rather-than-discovered).
**Sources:** `src/common/guards/organization-context.guard.ts`, `documents.service.ts`, `validation/*`, `src/storage/storage.service.ts`, `.env.example`, `docker-compose.yml`. **Last verified:** 2026-11-01 (code read; tenant isolation tests last executed 2026-10-31).

## What exists
- **Organisation context from a header.** `OrganizationContextGuard` requires a valid UUID `X-Organization-Id` (and validates an optional `X-User-Id`). Controllers receive the context through a decorator; no service reads headers.
- **Tenant-scoped queries.** Services filter by `organization_id`. A tender, slot or version from another organisation reads as **404, not 403** (no existence oracle). Covered by integration tests (tenant isolation; `explicit-slot.spec.ts`).
- **Explicit slot ownership validation.** A supplied `documentId` must exist, belong to the same tender and organisation, not be deleted, and match the requested document type — checked before any retry lookup.
- **Input validation.** Global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`); UUID pipes on path ids; an eight-stage upload gate including size limits and **magic-byte verification**; encrypted PDFs rejected.
- **Storage keys never contain client input.** Keys are `org/<orgId>/<2 hex>/<sha256><ext>` built from the computed checksum and the validated extension; the client filename is sanitised and stored only as metadata.
- **Secrets.** Configuration comes from environment variables validated at start-up (`env.validation.ts`); `.env` is git-ignored; only `.env.example` is committed.

## Demo organization directory (not a security control)
`GET /v1/demo/organizations` lists organisations (`id`, `slug`, `name`, `createdAt` only) for evaluators. It is **not** authentication or authorisation, and `X-Organization-Id` remains a simulated tenant context. Because it exposes a multi-tenant directory it is guarded by `DEMO_MODE`: off by default; on only with an explicit non-production `NODE_ENV` (`development`, `test`, `demo`); answers 404 otherwise; and the application refuses to start with `NODE_ENV=production` and `DEMO_MODE=true`. The guard (`DemoModeGuard`) runs on every request, so protection does not rely on Swagger visibility. Production still requires real authentication and authorisation.

## What does NOT exist
- **No authentication or authorisation.** The header is trusted: anyone who can reach the API can claim any organisation. The guard produces the shape a JWT guard would, so replacing it should not change service signatures.
- **No Row-Level Security.** There is no `CREATE POLICY` in any migration; isolation depends on every query remembering its `organization_id` filter.
- **No database-level composite tenant constraints.** Child rows carry `organization_id` next to a parent id and nothing makes the two agree.
- **No malware scanning** (`quarantined` means unreadable, not infected), **no rate limiting**, **no pagination**.
- **Immutability of rulesets and `audit_trail` is convention**, not enforced by grants or triggers.
- Presigned upload URLs exist as `StorageService.createUploadUrl` but no endpoint uses them and no test covers them.
- The committed `docker-compose.yml` contains **local-development** database credentials (`vantedge`), and `.env.example` contains placeholder S3 credentials (`minioadmin`) for the optional `s3` driver; none may be reused anywhere real.
