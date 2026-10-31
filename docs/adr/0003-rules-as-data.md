# ADR 0003 — Compliance rules as data, evaluators as code

**Status:** accepted · **Date:** 2026-10-31

## Context

Procurement rules change, and they change on a regulator's schedule rather than
a release schedule. "KSWP must be younger than 30 days" becomes 14 days;
a bid bond threshold moves; a new mandatory document appears. If each of those
is a code change, the product is permanently behind the regulation it exists to
track.

The opposite extreme is equally bad. A general expression language in the
database would make every change a configuration edit — and would make a verdict
impossible to explain, because the logic that produced it was never reviewed by
anyone.

A compliance product is judged on whether its verdicts can be defended.

## Decision

Rules are rows. Each names an `evaluator` — a key resolved at runtime against a
registry of implementations — and supplies its parameters as JSONB. The
evaluator set is **closed**: ten named, unit-tested implementations.

Rules are grouped into **versioned rulesets**. An audit records the
`ruleset_id` it ran under, and each finding snapshots the rule code and severity
at evaluation time.

A rule naming an evaluator the running build does not have produces an
`inconclusive` finding and a logged error, rather than aborting the audit. The
same holds for an evaluator that throws: one malfunctioning rule must not take
the report down with it.

## Consequences

**Good.** Thresholds, severities and applicability change without a deployment.
Every evaluator is a pure function of a pre-loaded snapshot, so the whole
ruleset is testable without a database. Re-running a past audit reproduces the
past verdict, because the ruleset it referenced is immutable. New regulation is
usually a new ruleset version, occasionally a new evaluator.

**Bad.** A genuinely novel rule shape still needs code and a release. Rule
parameters are JSONB and therefore not type-checked by the database — the
evaluator validates them at use, and a malformed parameter degrades one finding
to `inconclusive` rather than failing the audit. Two places now describe
behaviour, the registry and the rule rows, so the seed migration has to stay in
step with the registry.

**Also considered.** JSONLogic or CEL in the database. Rejected: the expressive
power is not the constraint here — explainability is. A verdict a procurement
manager must act on should trace to a named, reviewed check, not to an
expression somebody typed into an admin form.
