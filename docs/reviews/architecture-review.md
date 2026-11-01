> **Historical, point-in-time document.** Copied verbatim from `REVIEW-vantedge-bid.md` (originally kept outside the repository). It reviews commit `f680764` and its numbers, file names and findings describe that state, not the current code. For the current design see [docs/README.md](../README.md).

# Vantedge Bid — Architecture, Data Model, API and Test Review

**Reviewed commit:** `f680764` (2 commits, nothing pushed)
**Date:** 2026-10-31
**Repository state during review:** unmodified (`git status` clean throughout)

**Method.** Every finding below was checked against the running system, not
inferred from reading. Where a defect was reproduced, the evidence is quoted.
Where something could not be executed, it is marked **NOT VERIFIED** rather than
assumed.

---

## Headline

Two **CRITICAL** defects were reproduced. Both break the product's central
promise — telling a contractor whether their bid package is complete — and
neither is caught by the existing test suite.

1. **Uploading the same file to a second tender silently discards it.** The API
   answers `202 Accepted`, and the compliance audit then reports the document as
   never uploaded.
2. **Under concurrent load, ~24% of documents become permanently stuck.** They
   are fully processed but report `lifecycle: queued` forever.

The second one is caused by an ordering mistake in code I wrote; the first by a
de-duplication lookup that is scoped too widely. Both are cheap to fix.

---

# A. Architecture Review Report

## A.1 Current architecture

Two processes over one codebase:

- **API** (`src/main.ts` → `AppModule`) — NestJS 11, URI versioning, validates
  and admits uploads, returns `202`.
- **Worker** (`src/worker.ts` → `WorkerModule`) — same modules minus
  controllers, plus the BullMQ processor. Extracts fields, then runs a
  compliance audit.

Shared: PostgreSQL 16 (TypeORM as a mapping layer, `synchronize: false`, schema
owned by hand-written SQL migrations), Redis/BullMQ, an S3-compatible object
store behind an abstract `StorageService`.

Verified: `npm run build` succeeds; both processes boot; `/healthz` and
`/readyz` respond; 12 routes registered; `docker compose config` valid.

## A.2 Design strengths (keep these)

These were checked and are sound. They should not be touched:

- **Slot/version separation** (`tender_documents` vs `document_versions`).
  Correctly models "this tender needs an SBU" apart from "here is the file".
  Re-upload creates version 2 and version 1 survives — verified.
- **Content addressing.** SHA-256 per file, unique per tenant, driving the
  storage key and the queue job id. The *mechanism* is right; its *scope* is
  wrong (see C1).
- **Rules as data, evaluators as code.** `EvaluatorRegistry` is a closed `Map`
  populated in its constructor. No dynamic `require`, no `eval`, no expression
  language. A rule naming an unknown evaluator degrades to `inconclusive` and
  logs, rather than aborting the audit. **This is safe** — see §Security.
- **Finding snapshots.** `rule_code_snapshot` and `severity_snapshot` are
  written at evaluation time, so re-tuning a rule cannot rewrite history.
- **`inconclusive` as a first-class status.** The system can say "I could not
  read this" instead of guessing.
- **Error handling.** One `AppError` type, one terminal filter, RFC 7807
  output. Verified: 5xx bodies carry no internal message and no stack; driver
  errors are translated, not leaked.
- **Fail-fast configuration.** Missing env vars abort at module definition. This
  is genuinely load-bearing — it is why the integration suite must import
  `AppModule` lazily.

## A.3 Main architectural risks

| | Risk | Severity |
|---|---|---|
| C1 | De-duplication is tenant-scoped, not slot-scoped — uploads silently lost | Critical |
| C2 | Queue publish happens before the state transaction commits | Critical |
| H1 | Ruleset immutability is a comment, not a constraint | High |
| H2 | No scheduler — expiry is never detected without a new upload | High |
| H5 | Compliance audit runs inside the ingestion worker's failure boundary | High |

## A.4 Multi-tenant review

**Application layer: holds.** `OrganizationContextGuard` populates a request
context; every tenant-scoped query filters on `organization_id`. Verified by
integration test: organisation B receives `404` (not `403`) on A's tender,
document status and audits.

**Database layer: does not hold.** Three gaps:

- **No composite foreign keys.** `tender_documents` carries `organization_id`
  and `tender_id` as *independent* references. Nothing prevents a row whose
  `organization_id` disagrees with its tender's owner. Same shape in
  `document_versions`, `ingestion_jobs`, `compliance_audits`. A single service
  bug writes cross-tenant data that the database will happily accept.
- **No RLS.** The only mention in the repository is a comment. There is no
  `CREATE POLICY`, no `ALTER TABLE … ENABLE ROW LEVEL SECURITY`.
- **The README's RLS claim is inaccurate.** It states every tenant table carries
  `organization_id`, so one policy per table enforces isolation. Verified
  false — these tenant-owned tables have no `organization_id` column:

  ```
  compliance_findings
  document_extractions
  ```

  RLS on those requires a join-based policy against the parent, which is a
  materially different and more expensive thing than the README describes.

`compliance_rulesets` / `compliance_rules` also lack `organization_id` — but
that is intentional: rulesets are global. It is simply never stated, so a
reviewer cannot tell intent from omission.

## A.5 Document lifecycle review

The intended ordering is sound and well-reasoned: commit metadata as `pending`,
then upload bytes, then flip to `queued`. A crash mid-upload leaves a visible
sweepable row instead of an orphaned object.

**The implementation then breaks it** at the last step. See C2.

## A.6 Compliance audit review

Audit vs verdict separation is correct and enforced by a CHECK constraint
(`(status = 'completed') = (verdict IS NOT NULL)`). Re-running creates a new
audit row; nothing is overwritten — verified.

Two structural problems:

- **The audit runs inside the worker's `try` block** (`ingestion.processor.ts`
  line 76, inside the block whose `catch` calls `recordFailure`). An audit
  failure therefore marks the *document* failed. The document is blamed for a
  compliance-engine problem.
- **Audit amplification.** Every ingested document triggers a full audit of the
  whole tender. Measured on a 41-document burst into one tender:

  ```
  trigger           | status    | count | avg_ms | findings_written
  document_ingested | completed |    41 |     56 |             2193
  ```

  41 audits, 2,193 finding rows, for one tender's upload session. Growth is
  N documents × N slots × R rules.

## A.7 Scalability review

The queue architecture, priority classes, backoff, `UnrecoverableError`
handling and dead-letter mirroring are all real and correct.

Measured limits found:

- Audit amplification above.
- No pagination: `tenders.list` is `take: 100`, audit history is `take: 20`,
  both hard-coded with no parameters and no total count.
- `/metrics/queue` is unauthenticated.

The README's capacity table (throughput per worker count) is **NOT VERIFIED** —
it is an arithmetic projection from an assumed 400 ms per document, not a
measurement. It should say so.

## A.8 Security review

| Control | Status | Note |
|---|---|---|
| Authentication | **Not implemented** | Documented as deliberate; guard has the right shape |
| Tenant authorization | **PARTIAL** | Application yes; database no (A.4) |
| Upload size limits | **PASS** | Multer ceiling + per-type limit, verified `413` |
| MIME allow-list | **PASS** | Verified `415` |
| Magic-byte verification | **PASS** | Verified: shell script named `.pdf` rejected |
| Encrypted-PDF rejection | **PASS** | Verified `415 file_encrypted` |
| Malware scanning | **Not implemented** | **Schema comment over-claims it** — see M6 |
| Path traversal | **PASS** | `LocalStorageService.resolveKey` guards; keys are service-built |
| SQL injection | **PASS** | All raw SQL uses parameter placeholders; no string interpolation found |
| Dynamic evaluator resolution | **PASS** | Closed registry, no dynamic import |
| Error message leakage | **PASS** | Verified: no stack, no internal detail in 5xx |
| Secret management | **PASS** | Env only, `.env` gitignored, `.env.example` has placeholders |
| Audit trail integrity | **FAIL** | Append-only by convention; no grant or trigger prevents `UPDATE`/`DELETE` |
| Rate limiting | **Not implemented** | No throttler; upload endpoint is unbounded per tenant |
| Signed URL expiration | **NOT VERIFIED** | `createUploadUrl` exists but is never called and has no test |

---

# B. ERD Review

## B.1 Relationships — validated

All 14 relationships in `docs/ERD.md` were checked against
`information_schema`. Cardinalities are correct. The deferred circular FK
(`tender_documents.current_version_id` ↔ `document_versions`) is justified and
correctly declared `DEFERRABLE INITIALLY DEFERRED`.

## B.2 ERD / schema drift — FAIL

The `DOCUMENT_EXTRACTIONS` block in the ERD omits columns that exist:

| In schema | In ERD diagram |
|---|---|
| `extracted_data` | **missing** |
| `raw` | **missing** |
| `issuer` | **missing** |
| `text_storage_key` | **missing** |
| `created_at` | missing (acceptable) |

`extracted_data` is described in the ERD's prose but absent from its diagram —
drift introduced by the most recent change.

## B.3 Constraint gaps

| Constraint | Issue |
|---|---|
| Composite tenant FKs | Absent — cross-tenant rows are accepted by the database (A.4) |
| Ruleset immutability | Absent — `UPDATE compliance_rules` on a published ruleset silently rewrites audit history |
| `audit_trail` append-only | Absent — no enforcement |
| `document_versions` unique checksum | Present, but scoped `(organization_id, checksum)` — too wide, causes C1 |

## B.4 Delete behaviour risk

`document_versions` is `ON DELETE CASCADE` from `tender_documents`, and
`compliance_findings.version_id` is `ON DELETE SET NULL`. Hard-deleting one slot
therefore destroys its version history and silently blanks the evidence pointers
of every past audit that cited it. Soft delete is used today, so this is latent
— but nothing enforces that.

---

# C. Database Review

## C1 — CRITICAL — De-duplication is scoped to the tenant, not the document slot

**Current design.** `DocumentsService.findDuplicate` (line 297) looks up by
`(organizationId, checksumSha256)` only. The unique index
`document_versions_org_checksum_key` matches that scope.

**The problem.** A contractor reuses the same SBU, NIB, NPWP and company deed
across every tender they bid for. That is the normal case, not an edge case. The
second upload matches the first by checksum and is discarded.

**Reproduced:**

```
tender1 -> cc1410d2-… dedup: False
tender2 -> cc1410d2-… dedup: True      ← same documentId, different tender
SAME documentId returned for a different tender: True

LPSE-DUP-0002          | SBU | EMPTY   ← tender 2's slot never filled
LPSE-GIANYAR-2026-0042 | SBU | ccee45e4-…
```

Audit on tender 2, after a `202 Accepted`:

```
verdict: non_compliant
  fail   DOC.MANDATORY_PRESENT    Sertifikat Badan Usaha Konstruksi has not been uploaded.
```

**Impact.** The product tells a contractor their bid is missing a document they
did upload, and the API told them it was accepted. This is worse than having no
tool: it produces confident false negatives on the one question the product
exists to answer.

**Recommended fix.** De-duplicate *storage*, not *document records*. Keep the
unique checksum index for object reuse, but always create a `document_versions`
row for the slot being uploaded to, pointing at the already-stored object. The
byte-identical case then costs one row and no upload, and every slot is filled.

This means replacing the unique index on `(organization_id, checksum_sha256)`
with a non-unique index, and adding uniqueness on
`(document_id, checksum_sha256)` so a true retry into the *same* slot still
de-duplicates.

**MVP: required.** **Migration: required.** **Breaking:** the `deduplicated`
response flag changes meaning (same content, same slot) — document it.

## C2 — CRITICAL — Queue publish happens before the state transaction commits

**Current design.** `DocumentsService.promoteToQueued` calls
`this.queue.enqueue(...)` at line 387, and only *then* opens the transaction
(line 402) that sets `lifecycle = queued`, sets `current_version_id`, and
inserts the `ingestion_jobs` row.

**The problem.** The worker can and does start before that transaction commits:

- Worker sets `lifecycle = processing`, then `processed`.
- Worker's `ingestion_jobs` updates match **zero rows** — the row does not exist
  yet.
- The API's transaction then commits and **overwrites** `lifecycle` back to
  `queued`, inserting a fresh job row in state `queued`.

**Reproduced** — 40 concurrent uploads, worker concurrency 5:

```
 lifecycle | job_state | count | job_finished | version_processed_at
 queued    | queued    |    10 |            0 |                   10
 processed | completed |    31 |           31 |                   31
```

10 of 41 (24%) are permanently inconsistent. What the client sees:

```json
{ "lifecycle": "queued",
  "processedAt": "2026-10-31T05:55:53.346Z",
  "extraction": { "documentNumber": "BURST-6-…", "expiresAt": "2029-03-14" } }
```

`lifecycle: queued` with a completed extraction and a `processedAt` timestamp.
A client polling `statusUrl` waits forever. The compliance audit reports those
documents as `inconclusive — still being processed (queued)` — 5 such findings
in the subsequent audit.

**Impact.** Data corruption proportional to concurrency, in exactly the
deadline-day burst the README's scalability chapter is about.

**Recommended fix (simplest correct option).** Move the enqueue *after* the
transaction. The state row becomes the source of truth:

1. Transaction: `lifecycle = queued`, set `current_version_id`, insert
   `ingestion_jobs` row.
2. Commit.
3. Enqueue.
4. If the enqueue fails, the row stays `queued` with no live job — visible and
   recoverable by a sweeper that re-enqueues `queued` rows older than N minutes.

This is the transactional-outbox *pattern* without the infrastructure:
`ingestion_jobs` already is the outbox table. A full outbox with a relay process
is **not** warranted at this scale and should not be introduced.

**MVP: required.** **Migration: none.** **Tests required:** an integration test
that runs a real worker (see E).

## C3 — MEDIUM — Extraction replace is not atomic

`ExtractionService.extract` performs `delete({versionId})` then `insert(...)` as
two statements with no transaction. A crash between them leaves a processed
version with no extraction; two workers on the same version can collide on the
`UNIQUE (version_id)` constraint. Fix: wrap both, or use
`INSERT … ON CONFLICT (version_id) DO UPDATE`.

## C4 — MEDIUM — Job-state updates target every job row for a version

`ingestion.processor.ts` line 181 updates `IngestionJob` by `{ versionId }`. The
schema permits several job rows per version (uniqueness is on
`(queue_name, job_key)`). A re-enqueue produces multiple rows and the update
touches all of them. Fix: key the update on `job_key`.

---

# D. API Review

## D.1 Endpoint inventory (as registered, verified against `/docs/openapi.json`)

| Method | Path | Guard | Documented codes |
|---|---|---|---|
| POST | `/v1/tenders` | tenant | 201 |
| GET | `/v1/tenders` | tenant | 200 |
| GET | `/v1/tenders/{tenderId}` | tenant | 200 |
| POST | `/v1/tenders/{tenderId}/documents` | tenant | 202, 409, 413, 415, 422 |
| GET | `/v1/documents/versions/{versionId}/status` | tenant | 200 |
| POST | `/v1/tenders/{tenderId}/compliance-audits` | tenant | 201 |
| GET | `/v1/tenders/{tenderId}/compliance-audits` | tenant | 200 |
| GET | `/v1/compliance-audits/{auditId}` | tenant | 200 |
| GET | `/v1/document-types` | **none** | 200 |
| GET | `/healthz`, `/readyz`, `/metrics/queue` | **none** | 200 |

No endpoint is documented that does not exist. Good.

## D.2 Gaps

- **M3a — no `securitySchemes`.** The tenant header appears as an ordinary
  parameter. A generated client has no machine-readable notion of auth.
- **M3b — error codes documented on one endpoint only.** Every other operation
  lists only its success code, though all can return 400/404.
- **M3c — no error schema component.** `ProblemDetails` is not in
  `components.schemas`, so clients cannot generate the error type.
- **M2 — no pagination.** No `limit`/`cursor` parameters anywhere;
  `take: 100` and `take: 20` are hard-coded and no total is returned.
- **L2 — unauthenticated endpoints undocumented as such.** Verified:
  `GET /v1/document-types` → `200` with no header; `/metrics/queue` → `200`.
  Reference data is defensible; queue depth is operational information that
  should not be public.
- **L3 — misleading validation error.** `POST /v1/tenders/not-a-uuid/documents`
  returns a `400` complaining about `documentTypeCode`, because body validation
  runs before the path-param pipe. The caller is told the wrong thing.

---

# E. Test Review

## E.1 Inventory (executed, not assumed)

```
npm test                       → 62 passed, 27 skipped  (no services)
DATABASE_URL=… REDIS_URL=… npm test → 89 passed          (no worker running)
```

- 5 unit suites, 62 tests: file signature, validator, field extraction,
  evaluators, idempotency fingerprint.
- 2 integration suites, 27 tests: ingestion flow (12), schema drift (15).

## E.2 — MEDIUM — The integration suite is green only because no worker runs

`test/integration/ingestion.spec.ts:114` asserts `lifecycle === 'queued'`
immediately after upload. With a worker consuming the queue, that assertion is
false. Verified:

```
● document ingestion (integration) › persistence › stores the version…
  Expected: "queued"
  Received: "processing"
```

The suite therefore encodes an assumption that is untrue of every real
deployment, and it is precisely that assumption which hides C2. **The test
suite cannot currently detect the most serious defect in the system.**

Fix: assert membership in the set of valid post-upload states, and add a
separate test that runs a real worker and asserts the *terminal* state.

## E.3 Missing coverage

**Unit:**
- Audit verdict calculation and score arithmetic (evaluators are covered; the
  aggregation in `completeAudit` is not).
- Ruleset selection including the effective-window boundary.
- `fingerprintRequest` is covered; `claimIdempotencyKey` state machine is not.

**Integration:**
- **A worker actually processing to a terminal state** (would catch C2).
- **Concurrent uploads to the same slot** — `nextVersionNumber` takes
  `FOR UPDATE`; that lock is untested.
- **Cross-tender upload of identical content** (would catch C1).
- Worker retry and dead-letter transitions.
- Re-audit after document replacement; audit history preservation.
- Foreign-key and check-constraint violations surfacing as the right HTTP codes.

## E.4 — LOW — Broken script

`package.json` declares `"test:e2e": "jest --config test/jest-e2e.json"`.
Verified: `test/jest-e2e.json` does not exist. Running it fails.

---

# F. Remediation Plan

Ordered. Everything in Phase 1 is required before this is submitted or shipped.

### Phase 1 — Correctness (MVP-required)

| # | Issue | Sev | Fix | Files | Migration | Tests |
|---|---|---|---|---|---|---|
| C1 | Cross-tender de-dup loses uploads | Critical | De-duplicate storage, not records; always create the version row | `documents.service.ts`, `001_init_schema.sql` | **Yes** — index scope change | Integration: same file → two tenders |
| C2 | Enqueue before commit | Critical | Move enqueue after the transaction; add a sweeper for stale `queued` | `documents.service.ts` | No | Integration with a live worker |
| E.2 | Test hides C2 | Medium | Assert valid state set; add terminal-state test | `test/integration/ingestion.spec.ts` | No | — |
| C3 | Extraction replace not atomic | Medium | `ON CONFLICT (version_id) DO UPDATE` | `extraction.service.ts` | No | Re-extraction test |
| C4 | Job update hits all rows | Medium | Key updates on `job_key` | `ingestion.processor.ts` | No | Covered by C2 test |

### Phase 2 — Honesty (MVP-required, cheap)

| # | Issue | Sev | Fix |
|---|---|---|---|
| H4 | README over-claims RLS | High | State that RLS is *not* implemented and that two tables would need join-based policies |
| M6 | Schema comment claims "infected" | Medium | Remove; no malware scanning exists |
| M9 | ERD omits `extracted_data`, `raw`, `issuer`, `text_storage_key` | Medium | Update the diagram |
| A.7 | Throughput table reads as measured | Medium | Label it a projection |
| L1 | `test:e2e` points at a missing config | Low | Remove the script or add the config |
| L6 | Rulesets are global, unstated | Low | One line in the ERD |

### Phase 3 — Integrity (MVP-recommended)

| # | Issue | Sev | Fix | Migration |
|---|---|---|---|---|
| H1 | Ruleset mutability defeats reproducibility | High | Trigger rejecting `UPDATE`/`DELETE` on a ruleset referenced by any audit | Yes |
| H6 | `audit_trail` not append-only | High | Trigger rejecting `UPDATE`/`DELETE` | Yes |
| H3 | Cross-tenant rows accepted | High | Composite FKs `(id, organization_id)` on parents, referenced by children | Yes |
| H5 | Audit inside worker failure boundary | High | Move the audit outside the `try`, or onto its own queue; debounce per tender |  No |

### Phase 4 — Deferred (document as not implemented)

| # | Issue | Sev | Why defer |
|---|---|---|---|
| H2 | No scheduler for `scheduled` / `deadline_approaching` | High | Real gap, but the brief does not require it. Needs `@nestjs/schedule` or a repeatable BullMQ job. **Must be labelled unimplemented today.** |
| M2 | No pagination | Medium | Add with the first client that needs it; state the current caps |
| M3 | OpenAPI incomplete | Medium | Add `securitySchemes` + error schema when auth lands |
| M7 | Hard-delete cascade risk | Medium | Latent while soft delete is used |
| M8 | No rate limiting | Medium | Belongs with authentication |
| L2–L5 | Misc | Low | Document |

---

# G. Implementation Summary

**No files were changed.** Discovery and review only, per the brief. `git
status` is clean.

---

# H. Final Verification Checklist

| Check | Status | Evidence |
|---|---|---|
| ERD matches the SQL schema | **FAIL** | `DOCUMENT_EXTRACTIONS` omits 4 real columns (B.2) |
| Database constraints are valid | **PARTIAL** | Declared constraints apply cleanly; immutability and composite-tenant constraints absent (B.3) |
| Tenant isolation verified | **PARTIAL** | Application layer verified by test; database layer absent; README claim inaccurate (A.4) |
| Document versioning consistent | **PARTIAL** | Versioning verified correct; de-duplication defeats it across tenders (C1) |
| Audit history preserved | **PASS** | Re-run creates a new audit; snapshots verified; nothing overwritten |
| Ruleset reproducibility | **FAIL** | Nothing prevents mutation of a ruleset an audit has used (H1) |
| Document state machine correct | **FAIL** | 24% corruption reproduced under concurrency (C2) |
| API documentation matches implementation | **PARTIAL** | No phantom endpoints; error codes, security scheme and error schema missing (D.2) |
| README commands verified | **PASS** | All 9 referenced commands exist in `package.json`; `test:e2e` is unreferenced but broken (E.4) |
| Unit tests pass | **PASS** | 62/62 executed, no services required |
| Integration tests pass | **PARTIAL** | 27/27 with no worker; 1 fails with a worker running (E.2) |
| Security issues addressed or documented | **PARTIAL** | See A.8; malware claim must be removed; audit-trail integrity and rate limiting absent |
| Scheduler for expiry re-audit | **FAIL** | Enum values exist; no implementation anywhere in `src/` |
| MVP vs future AI clearly separated | **PASS** | README table and "design only" labelling verified accurate |
| Signed-URL upload path | **NOT VERIFIED** | `createUploadUrl` never called, no test |
| Malware scanning / quarantine on infection | **NOT APPLICABLE** | Not implemented; schema comment implying it must be corrected |
| Throughput figures in README | **NOT VERIFIED** | Arithmetic projection, never measured |

---

## Recommended next step

Fix C1, C2 and E.2 together — they are one coherent change to the ingestion
path plus the test that should have caught them. Phase 2 is an hour of
documentation honesty. Phase 3 is three small migrations.

I would not start Phase 4 before the challenge is submitted; it should instead
be stated plainly in the README's limitations section, which is already the
right shape for it.
