/**
 * Mirrors of the Postgres enum types declared in db/migrations/001_init_schema.sql.
 *
 * These are hand-maintained on purpose: the database owns the schema (ADR 0001),
 * and the CI schema-drift check fails the build if these fall out of step.
 */

export enum TenderStatus {
  Draft = 'draft',
  Monitoring = 'monitoring',
  Preparing = 'preparing',
  Submitted = 'submitted',
  Won = 'won',
  Lost = 'lost',
  Cancelled = 'cancelled',
}

export enum DocumentLifecycle {
  Pending = 'pending',
  Queued = 'queued',
  Processing = 'processing',
  Processed = 'processed',
  Failed = 'failed',
  Quarantined = 'quarantined',
}

export enum IngestionJobState {
  Queued = 'queued',
  Active = 'active',
  Completed = 'completed',
  Failed = 'failed',
  DeadLetter = 'dead_letter',
}

export enum RuleSeverity {
  Blocker = 'blocker',
  Critical = 'critical',
  Major = 'major',
  Minor = 'minor',
  Info = 'info',
}

export enum FindingStatus {
  Pass = 'pass',
  Fail = 'fail',
  Warning = 'warning',
  NotApplicable = 'not_applicable',
  Inconclusive = 'inconclusive',
}

export enum AuditStatus {
  Queued = 'queued',
  Running = 'running',
  Completed = 'completed',
  Failed = 'failed',
}

export enum AuditVerdict {
  Compliant = 'compliant',
  CompliantWithWarnings = 'compliant_with_warnings',
  NonCompliant = 'non_compliant',
}

/** Severities that make an audit non-compliant rather than merely warned. */
export const BLOCKING_SEVERITIES: ReadonlySet<RuleSeverity> = new Set([
  RuleSeverity.Blocker,
  RuleSeverity.Critical,
]);
