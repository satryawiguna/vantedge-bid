# ADR 0004 — Hybrid storage for extracted document fields

**Status:** accepted · **Date:** 2026-10-31

## Context

Extraction turns a document into fields, and the fields differ by document type.
An SBU carries subclassification codes and a qualification grade. An NIB carries
KBLI business activity codes. A bid bond carries an amount and a guarantor. A
KSWP carries almost nothing but an issue date.

Two obvious designs both fail:

**A column per field.** The table grows a column every time regulation adds a
document type, most rows are NULL in most columns, and a migration is needed to
capture a field nobody will query.

**Everything in one JSONB blob.** The compliance rules that matter — expiry
against the deadline, NPWP consistency, bid bond threshold — would then read
their inputs out of JSON. Those are the fields with constraints, indexes and
rules depending on them, and burying them costs type checking at the database
level and makes every rule query awkward.

## Decision

Hybrid, with an explicit promotion rule.

**Columns** for fields a compliance rule, a filter, or a join depends on:
`document_number`, `holder_name`, `holder_npwp`, `issued_at`, `expires_at`,
`classification_codes`, `monetary_value`. These carry check constraints and a
partial index on `expires_at`.

**`extracted_data` (JSONB)** for fields specific to one document type:
`kbliCodes`, `qualificationGrade`, `guarantor`, `competencyLevel`.

**A field is promoted to a column when something queries it.** The intermediate
step, for a field queried often enough to matter but not yet worth a migration,
is a GIN or expression index on `extracted_data`. None exists yet, because
nothing queries it yet — an index on a column no query touches is cost with no
return.

`raw` is kept separate from `extracted_data` and holds diagnostics about the
extraction run — text length, streams decoded. Mixing run telemetry into the
document's own fields would mean every query over `extracted_data` has to step
around keys that describe the parser rather than the paper.

## Consequences

**Good.** The rule-bearing fields stay typed, constrained and indexable. A new
document type needs no migration. The promotion rule means the schema follows
actual query patterns instead of predicted ones.

**Bad.** `extracted_data` is not validated by the database, so a malformed value
surfaces at use rather than at write. Evaluators treat a missing or unusable
value as `inconclusive` rather than failing, which is the right default here but
does mean a silent extractor regression shows up as inconclusive findings rather
than as an error. The promotion rule is also a judgement call that needs
applying — left alone, JSONB accumulates fields that should have become columns.

**Also considered.** A key-value table (`extraction_fields(version_id, key,
value)`). Fully flexible and fully untyped, with every read becoming a pivot.
Worse than JSONB on every axis that matters here.
