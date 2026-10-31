import {
  ComplianceRule,
  DocumentExtraction,
  DocumentType,
  DocumentVersion,
  Organization,
  Tender,
  TenderDocument,
} from '../../../database/entities';
import { FindingStatus } from '../../../database/enums';

/** One document slot with everything an evaluator needs, already joined. */
export interface DocumentSnapshot {
  document: TenderDocument;
  type: DocumentType;
  version: DocumentVersion | null;
  extraction: DocumentExtraction | null;
}

export interface EvaluationContext {
  organization: Organization;
  tender: Tender;
  documents: DocumentSnapshot[];
  /** Fixed per audit run, so every rule sees the same instant. */
  now: Date;
}

export interface Finding {
  status: FindingStatus;
  message: string;
  documentId?: string | null;
  versionId?: string | null;
  evidence?: Record<string, unknown>;
}

/**
 * A rule evaluator.
 *
 * Pure: context and rule in, findings out. No database, no clock, no I/O —
 * which is what makes the whole ruleset unit-testable without a container, and
 * what makes a verdict explainable from its evidence alone.
 */
export interface RuleEvaluator {
  readonly key: string;
  evaluate(rule: ComplianceRule, context: EvaluationContext): Finding[];
}

/** Narrow a rule's JSONB params without scattering casts through the evaluators. */
export function param<T>(rule: ComplianceRule, name: string, fallback: T): T {
  const value = rule.params?.[name];
  return value === undefined || value === null ? fallback : (value as T);
}

/** Documents this rule applies to: its own type, or all of them. */
export function scopedDocuments(
  rule: ComplianceRule,
  context: EvaluationContext,
): DocumentSnapshot[] {
  if (!rule.documentTypeCode) return context.documents;
  return context.documents.filter((entry) => entry.type.code === rule.documentTypeCode);
}

export function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

export function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}
