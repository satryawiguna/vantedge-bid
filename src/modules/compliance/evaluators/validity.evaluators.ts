import { ComplianceRule } from '../../../database/entities';
import { FindingStatus } from '../../../database/enums';
import {
  EvaluationContext,
  Finding,
  RuleEvaluator,
  daysBetween,
  param,
  parseDate,
  scopedDocuments,
} from './types';

/**
 * The single most common cause of disqualification: a certificate that is valid
 * today and expired on the day the bid is opened.
 *
 * Note what it compares against. Checking expiry against *now* is the mistake
 * the manual process makes — a bid prepared three weeks early passes the desk
 * check and fails at opening. This compares against the submission deadline.
 */
export class NotExpiredAtDeadlineEvaluator implements RuleEvaluator {
  readonly key = 'not_expired_at_deadline';

  evaluate(rule: ComplianceRule, context: EvaluationContext): Finding[] {
    const graceDays = param(rule, 'grace_days', 0);
    const deadline = context.tender.submissionDeadline;

    return scopedDocuments(rule, context)
      .filter((entry) => entry.version !== null)
      .map((entry): Finding => {
        const base = {
          documentId: entry.document.id,
          versionId: entry.version!.id,
        };

        if (!entry.extraction) {
          return {
            ...base,
            status: FindingStatus.Inconclusive,
            message: `${entry.type.name} has not been processed yet.`,
          };
        }

        const expiresAt = parseDate(entry.extraction.expiresAt);
        if (!expiresAt) {
          return {
            ...base,
            status: FindingStatus.Inconclusive,
            message:
              `No expiry date could be read from ${entry.type.name}. ` +
              'Check it by hand before submitting.',
            evidence: { confidence: entry.extraction.confidence },
          };
        }

        if (!deadline) {
          return {
            ...base,
            status: FindingStatus.Inconclusive,
            message: 'The tender has no submission deadline recorded.',
            evidence: { expiresAt: entry.extraction.expiresAt },
          };
        }

        const marginDays = daysBetween(deadline, expiresAt) + graceDays;

        if (marginDays < 0) {
          return {
            ...base,
            status: FindingStatus.Fail,
            message:
              `${entry.type.name} expires on ${entry.extraction.expiresAt}, ` +
              `${Math.abs(marginDays)} day(s) before the submission deadline.`,
            evidence: {
              expiresAt: entry.extraction.expiresAt,
              deadline: deadline.toISOString(),
              marginDays,
            },
          };
        }

        // Valid, but only just. Renewal takes weeks, so a warning here is worth
        // more than a pass that arrives too late to act on.
        if (marginDays <= 30) {
          return {
            ...base,
            status: FindingStatus.Warning,
            message:
              `${entry.type.name} expires ${marginDays} day(s) after the deadline. ` +
              'Renew it before the contract period starts.',
            evidence: { expiresAt: entry.extraction.expiresAt, marginDays },
          };
        }

        return {
          ...base,
          status: FindingStatus.Pass,
          message: `${entry.type.name} is valid until ${entry.extraction.expiresAt}.`,
          evidence: { expiresAt: entry.extraction.expiresAt, marginDays },
        };
      });
  }
}

/**
 * Freshness, for documents whose value is their recency.
 *
 * A KSWP confirms tax status *as at* its issue date; a three-month-old one
 * confirms nothing useful and committees routinely reject it.
 */
export class IssuedWithinDaysEvaluator implements RuleEvaluator {
  readonly key = 'issued_within_days';

  evaluate(rule: ComplianceRule, context: EvaluationContext): Finding[] {
    const maxAgeDays = param(rule, 'max_age_days', 30);
    const reference = context.tender.submissionDeadline ?? context.now;

    return scopedDocuments(rule, context)
      .filter((entry) => entry.version !== null)
      .map((entry): Finding => {
        const base = { documentId: entry.document.id, versionId: entry.version!.id };
        const issuedAt = parseDate(entry.extraction?.issuedAt ?? null);

        if (!issuedAt) {
          return {
            ...base,
            status: FindingStatus.Inconclusive,
            message: `No issue date could be read from ${entry.type.name}.`,
          };
        }

        const ageDays = daysBetween(issuedAt, reference);

        return ageDays <= maxAgeDays
          ? {
              ...base,
              status: FindingStatus.Pass,
              message: `${entry.type.name} was issued ${ageDays} day(s) before the deadline.`,
              evidence: { issuedAt: entry.extraction!.issuedAt, ageDays, maxAgeDays },
            }
          : {
              ...base,
              status: FindingStatus.Fail,
              message:
                `${entry.type.name} will be ${ageDays} days old at the deadline, ` +
                `older than the ${maxAgeDays}-day limit. Request a fresh one.`,
              evidence: { issuedAt: entry.extraction!.issuedAt, ageDays, maxAgeDays },
            };
      });
  }
}

/**
 * Bid security has to stay valid for a stated period *after* the deadline,
 * covering the evaluation window — not merely be valid on the day.
 */
export class ValidForDaysAfterDeadlineEvaluator implements RuleEvaluator {
  readonly key = 'valid_for_days_after_deadline';

  evaluate(rule: ComplianceRule, context: EvaluationContext): Finding[] {
    const minDays = param(rule, 'min_days', 60);
    const deadline = context.tender.submissionDeadline;

    const scoped = scopedDocuments(rule, context).filter((entry) => entry.version !== null);

    if (scoped.length === 0) {
      return [
        {
          status: FindingStatus.NotApplicable,
          message: 'No bid security document is attached to this tender.',
        },
      ];
    }

    return scoped.map((entry): Finding => {
      const base = { documentId: entry.document.id, versionId: entry.version!.id };
      const expiresAt = parseDate(entry.extraction?.expiresAt ?? null);

      if (!expiresAt || !deadline) {
        return {
          ...base,
          status: FindingStatus.Inconclusive,
          message: 'Either the validity date or the tender deadline is unknown.',
        };
      }

      const coverDays = daysBetween(deadline, expiresAt);

      return coverDays >= minDays
        ? {
            ...base,
            status: FindingStatus.Pass,
            message: `Bid security covers ${coverDays} day(s) past the deadline.`,
            evidence: { coverDays, minDays },
          }
        : {
            ...base,
            status: FindingStatus.Fail,
            message:
              `Bid security covers only ${coverDays} day(s) past the deadline; ` +
              `${minDays} are required.`,
            evidence: { coverDays, minDays, expiresAt: entry.extraction!.expiresAt },
          };
    });
  }
}
