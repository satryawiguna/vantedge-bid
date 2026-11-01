> **Historical, point-in-time document.** Copied verbatim from `FINAL-RELIABILITY-PASS-vantedge-bid.md` (originally kept outside the repository). It records an earlier reliability pass; later passes changed the code and tests further. For the current design see [docs/README.md](../README.md).

# Vantedge Bid — Final Reliability Correction Pass

**Date:** 31 October 2026 · **Branch:** `main` · **Nothing was committed or pushed.**

---

## A. What this pass changed

Five items were in scope. Four were code; one was documentation. All five are done,
and the four code items were each verified by reverting the fix and confirming a
test goes red.

| # | Item | Status | Verified by |
|---|---|---|---|
| 1 | Pending-version recovery | Fixed | `promotion-recovery.spec.ts` — mutation caught |
| 2 | Concurrency-safe slot allocation | Fixed | `concurrency.spec.ts` — mutation caught |
| 3 | Reliable audit scheduling | Fixed | `audit-scheduling.spec.ts` — mutation caught |
| 4 | Idempotency lease ownership | Fixed | `concurrency.spec.ts` — mutation caught |
| 5 | Documentation synchronisation | Done | Re-read against schema and code |

### 1 · `pending` and `queued` are not the same kind of unfinished

`resumeIfStalled` treated both as "republish". A `queued` version has a committed
lifecycle, a slot pointer and an `ingestion_jobs` row, so only the publish can be
missing. A `pending` version has none of those: publishing it hands a worker a
version with no ledger row to update and a slot still pointing elsewhere. The
extraction then succeeds into a document the tender does not reference, and the
audit reports it missing.

The method now branches on lifecycle. `pending` goes through
`completePendingPromotion`, which runs the same promotion path a first upload
does — restore the object if missing, commit lifecycle + pointer + ledger row in
one transaction, publish only after.

### 2 · Slot allocation under real concurrency

The emptiness test could not be `current_version_id IS NULL`, because the pointer
is set after the version transaction commits. It is now `NOT EXISTS (SELECT 1 FROM
document_versions …)`. That predicate cannot be locked with `FOR UPDATE` — the
contended case is a row that does not exist yet — so a transaction-scoped
advisory lock on `slot:<tender>:<type-code>` serialises the lookup and the insert
together. `current_version_id` also only moves forward now: the `UPDATE` compares
`version_no`, so a slow earlier version cannot demote a newer one.

`document_types.allows_multiple` (migration 004) distinguishes "the same document
uploaded twice" from "two documents of the same kind" — `SKK_PERSONIL` and
`SURAT_DUKUNGAN` are the multi-instance types in the seed.

### 3 · Audit intent outlives the broker

Coalescing by reusing one BullMQ job id per tender is correct only while the job
is waiting. A request arriving while the audit was **active** resolved to the
running job and was dropped, so the document that triggered it was never audited.
A retained **failed** job held that id for a week and blocked the tender entirely.

`tender_audit_state` now records that an audit is owed (`pending`) and which run
is scheduled to carry it (`scheduled_job_id`, unique per run). Requests coalesce
by claiming that column with a conditional `UPDATE`. A run takes the flag before
reading any documents, so a document landing mid-audit is a fact rather than an
inference, and the processor schedules one follow-up. A failed run restores the
flag; `reconcileAudits` covers a publish that never reached the broker.

### 4 · Claims have an owner, not just an age

A lease let an abandoned claim be taken over, but completion and release were
keyed on `(organization_id, key)` alone. A request that was slow rather than dead
could come back and delete its successor's claim, or write its own response under
it. `idempotency_keys.owner_token` is minted on every acquisition, including a
takeover, and both mutations are conditional on still holding it.

### 5 · Documentation

- `docs/ERD.md` — `tender_audit_state` added to the relationship map and the
  module-2 diagram with its full state machine; `document_types.allows_multiple`
  added; new sections on claim ownership, concurrent slot allocation, and the
  `pending` vs `queued` recovery distinction; the migration list now names 003,
  004 and 005.
- `README.md` — audit scheduling rewritten to describe the durable-intent design;
  the four-identities table and claim-ownership paragraphs; a new subsection on
  mutation-verifying tests.
- `docs/adr/0005` — Decision and Consequences rewritten; the old
  `audit-<tenderId>` scheme is now recorded as a superseded approach with the
  reason it failed, rather than as the design.
- `src/database/entities/ingestion-job.entity.ts` — the `jobKey` comment said
  "derived from the content checksum"; it is derived from the version id.
- `db/migrations/005_correct_schema_comments.sql` — new, no structural change.
  Two inline comments in 001 had outlived their design and 001 has shipped, so
  `COMMENT ON COLUMN` corrects the record where introspection tools read it.

---

## B. Corrections to claims made in earlier passes

Three statements from the previous pass did not survive checking, and the record
is corrected rather than quietly left standing.

1. **"Audit coalescing is covered by an integration test."** It was not. The test
   went through `requestAudit`, whose own pre-check won the race before the claim
   inside `schedule()` was contended. Reverting that claim left all 137 tests
   green. A test that races `schedule()` directly was added; it now fails with
   5 published jobs instead of 1.

2. **"Claim ownership is covered."** The test re-typed the service's SQL and so
   only proved that Postgres honours an equality predicate. Removing the
   ownership condition from the service changed nothing. The test now calls
   `claimIdempotencyKey`, `completeClaim` and `releaseClaim`.

3. **"The advisory lock was mutation-verified (6 failures → 5)."** That result was
   an artefact of an invalid mutation: removing the lock call left an untyped
   `$1` parameter, and Postgres failed to plan the statement. The six failures
   were bind errors, not the race. With valid SQL the lock could be deleted
   outright and every slot-allocation test still passed.

   Racing two transactions did not fix this: the outcome varied between runs, so
   the test passed against broken code often enough to be useless. The suite now
   asks a second connection, via `pg_try_advisory_xact_lock`, whether the lock on
   that `(tender, document type)` is held during allocation and free after commit
   — deterministic, and it names the key, so a lock taken on the wrong key fails
   too.

Two mechanical lessons, recorded in the README because they cost real time: a
mutation must be *valid* SQL or the resulting failures look like a working test,
and mutation runs need `--no-cache` — a cached ts-jest transform made one
mutation look survivable twice.

---

## C. Verification actually run

All of the following were executed in this session.

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm run typecheck` (includes tests) | clean |
| `npm run build` | clean |
| `npm test` (no services) | 6 suites, **68 passed**, 72 skipped |
| `npm test` (Postgres + Redis) | **14 suites, 140 passed, 0 failed** |
| Fresh database migration | 5 migrations applied in order, from an empty database |
| Migration re-run | "Database is up to date." — idempotent |
| Schema assertions | 15 tables; `allows_multiple` true for `SKK_PERSONIL` and `SURAT_DUKUNGAN`; `tender_audit_state` has its PK, both FKs and the partial index |
| `docker compose config --quiet` | exit 0 |
| Mutation runs (4, with `--no-cache`) | each caught by the intended test |

The services had to be rebuilt this session — the container's Postgres data
directory had been reinitialised — so the migration run was genuinely from
scratch rather than against an existing schema.

### Claims deliberately not made

- **Docker was not executed.** Only `docker compose config --quiet` ran; there is
  no Docker daemon in this environment. The compose file is syntactically valid
  and nothing more is claimed.
- **S3 was not exercised.** Every storage test ran against the local-disk driver.
  `S3StorageService.head()` and `put()` are typechecked and follow the SDK's
  documented contract, but no call was made to an S3-compatible service. The
  atomicity argument for S3 rests on PUT being atomic by specification, not on a
  test.
- **The application is not production-ready.** Authentication, authorisation and
  RLS are absent; `X-Organization-Id` is trusted as supplied. Tenant isolation is
  enforced in the service layer and tested there, but not at the database
  boundary.

---

## D. Remaining risks

**Material, and unchanged by this pass:**

1. **No authentication or authorisation.** The tenant is whatever the caller puts
   in a header.
2. **No RLS policy exists.** There is no `CREATE POLICY` in any migration. Most
   tables carry `organization_id` so policies *can* be written;
   `document_extractions` and `compliance_findings` do not and would need the
   column first.
3. **No malware scanning.** `quarantined` means encrypted, corrupt or
   unparseable — it does not mean a file was scanned.
4. **Rulesets are mutable.** Nothing stops an `UPDATE` to a ruleset an audit has
   already cited, so reproducibility is enforced by convention. A trigger
   rejecting changes to a referenced ruleset is the missing piece.

**Narrower, introduced or left by this pass:**

5. **Two tests reach private methods** (`resolveDocumentSlot`, the three claim
   methods) through a typed cast. That is deliberate — they are the narrowest
   surface on which these invariants are expressible, and the alternative was a
   test that passes against broken code — but it couples those tests to internal
   names.
6. **Audit follow-up can produce one extra audit.** When a document lands while a
   run is in progress, the processor schedules another pass. An extra audit is
   wasted work; a skipped one is a wrong verdict, so the trade is deliberate.
7. **The reconciler is interval-driven, not scheduled.** There is no cron-based
   expiry detection, and none is claimed.
8. **Throughput figures in the README are a projection**, labelled as such, not a
   load-test result.

---

## E. Git state

- **Branch:** `main`
- **Commits:** three, unchanged — `271d3c5`, `f680764`, `120816b`
- **Initial status:** dirty (19 modified, 12 untracked)
- **Final status:** dirty (19 modified, 14 untracked — `005_correct_schema_comments.sql`
  and this report's source changes are the additions)
- **No commit, amend, rebase, reset, force-push or push was performed.** No stash
  was created. Migrations 001, 002 and 003 were not modified.
