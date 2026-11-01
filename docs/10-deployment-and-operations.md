# 10 — Deployment and operations

**Purpose:** configuration, services and operating notes. **Related:** [03](03-system-architecture.md), [07](07-security-and-tenancy.md), [root README](../README.md#quick-start).
**Sources:** `.env.example`, `src/config/*`, `docker-compose.yml`, `Dockerfile`, `package.json`, `src/modules/health`. **Last verified:** 2026-11-01 (files read; `docker compose config` passed 2026-10-31; compose containers were **not** run; a native API+worker run answered `/healthz`, `/readyz`, `/docs` with 200).

## Environment variables (see `.env.example`)
| Group | Variables |
|---|---|
| Runtime | `NODE_ENV`, `PORT`, `LOG_LEVEL` |
| Postgres | `DATABASE_URL`, `DATABASE_POOL_SIZE` |
| Redis/queues | `REDIS_URL`, `INGESTION_QUEUE_NAME`, `INGESTION_CONCURRENCY`, `INGESTION_MAX_ATTEMPTS`, `INGESTION_RECONCILE_INTERVAL_MS` (0 disables), `INGESTION_RECONCILE_GRACE_MS` |
| Audits | `AUDIT_DEBOUNCE_MS`, `AUDIT_MAX_ATTEMPTS` |
| Idempotency | `IDEMPOTENCY_CLAIM_LEASE_MS` |
| Storage | `STORAGE_DRIVER` (`s3`\|`local`), `STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`, `STORAGE_FORCE_PATH_STYLE`, `STORAGE_LOCAL_ROOT` |
| Limits | `UPLOAD_MAX_BYTES` (default 50 MiB) |
| Demo | `DEMO_MODE` (`true`/`false`, default `false`; `true` is refused under `NODE_ENV=production`, with an unset/unrecognised `NODE_ENV`, or with any other value). Compose only: `API_NODE_ENV` sets the api container's `NODE_ENV` (default `production`; use `demo` together with `DEMO_MODE=true` to enable `GET /v1/demo/organizations` in Docker) |

## Docker Compose
Services: `postgres` (16), `redis` (7, append-only), `migrate` (one-shot `node dist/database/migrator`), `api`, `worker`. Volumes: `postgres-data`, `redis-data`, `storage-data`.

Host ports for Postgres and Redis default to 5432/6379. When those are taken (a local Postgres or Redis, another container), set `POSTGRES_HOST_PORT` and `REDIS_HOST_PORT` — most simply in a git-ignored `.env` copied from `.env.example`, which `docker compose` and `npm run seed` both read — and keep `DATABASE_URL`/`REDIS_URL` on the same ports. Command-line form: `POSTGRES_HOST_PORT=5433 REDIS_HOST_PORT=6380 docker compose up -d --build`. Container-to-container traffic is unaffected. `npm run seed` uses `DATABASE_URL` from `.env` (or `POSTGRES_HOST_PORT` if only that is set); an explicit `DATABASE_URL=… npm run seed` overrides both.

**Storage in Compose is local disk** (`STORAGE_DRIVER=local`, `/data/storage` on the shared `storage-data` volume). MinIO's public Docker image is no longer published, so Compose runs no S3 service. The local driver is single-host: every `api` and `worker` replica must mount the same volume. To use S3, set `STORAGE_DRIVER=s3` plus the `STORAGE_ENDPOINT`/credential variables against any S3-compatible service; that path is not exercised by Compose or by the tests.

## Running
```bash
npm run migrate                       # apply db/migrations in order; checksums applied files
npm run start:dev                     # API         (or: npm run build && npm start)
npm run start:worker:dev              # worker      (or: npm run start:worker)
npm run seed                          # demo organisation/tender, prints curl commands
```
`npm run samples` regenerates the PDFs in `samples/` (tracked files). The migrator refuses a changed already-applied migration; correct mistakes with a **new** migration.

## Health and observability
`/healthz` (liveness), `/readyz` (database + queue checks with latency), `/metrics/queue` (ingestion queue depth), Swagger at `/docs`. Logging is structured JSON via `nestjs-pino` (pretty-printed in development). Operational signals worth watching: ingestion jobs with `published_at IS NULL` and `state = 'queued'`, `tender_audit_state` rows with `pending` and no live job, versions stuck in `pending`.

## Scaling
Run more worker replicas for queue depth; API replicas are stateless. Reconciliation is safe on every instance (`SKIP LOCKED`). Database connections are the first limit; the README discusses pooling.
