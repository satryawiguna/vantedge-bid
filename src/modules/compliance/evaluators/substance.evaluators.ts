import { ComplianceRule } from '../../../database/entities';
import { FindingStatus } from '../../../database/enums';
import { EvaluationContext, Finding, RuleEvaluator, param, scopedDocuments } from './types';

/**
 * Does the SBU actually cover the work being tendered?
 *
 * A contractor can hold a perfectly valid certificate for the wrong
 * subclassification — building construction when the package is roadworks —
 * and be eliminated at evaluation. Comparing the codes on the certificate
 * against the ones in the announcement is a check nobody enjoys doing by hand.
 */
export class ClassificationMatchEvaluator implements RuleEvaluator {
  readonly key = 'classification_match';

  evaluate(rule: ComplianceRule, context: EvaluationContext): Finding[] {
    const matchMode = param<'any' | 'all'>(rule, 'match_mode', 'any');
    const required = context.tender.requiredSbuCodes ?? [];

    if (required.length === 0) {
      return [
        {
          status: FindingStatus.NotApplicable,
          message: 'The announcement lists no required SBU subclassification.',
        },
      ];
    }

    return scopedDocuments(rule, context)
      .filter((entry) => entry.version !== null)
      .map((entry): Finding => {
        const base = { documentId: entry.document.id, versionId: entry.version!.id };
        const held = entry.extraction?.classificationCodes ?? [];

        if (held.length === 0) {
          return {
            ...base,
            status: FindingStatus.Inconclusive,
            message:
              'No subclassification codes could be read from the certificate. ' +
              'Verify the classification by hand.',
            evidence: { required },
          };
        }

        const matched = required.filter((code) => held.includes(code));
        const satisfied =
          matchMode === 'all' ? matched.length === required.length : matched.length > 0;

        return satisfied
          ? {
              ...base,
              status: FindingStatus.Pass,
              message: `Certificate covers ${matched.join(', ')}.`,
              evidence: { required, held, matched, matchMode },
            }
          : {
              ...base,
              status: FindingStatus.Fail,
              message:
                `The announcement requires ${required.join(', ')}, ` +
                `but the certificate carries ${held.join(', ')}.`,
              evidence: { required, held, matched, matchMode },
            };
      });
  }
}

/**
 * Is the bid bond large enough?
 *
 * Money is compared as an integer number of rupiah. `estimated_value` and
 * `monetary_value` are both Postgres numeric and arrive as strings; converting
 * them to floats to compare would be the one place in this service where a
 * rounding error changes a verdict.
 */
export class MonetaryThresholdEvaluator implements RuleEvaluator {
  readonly key = 'monetary_threshold';

  evaluate(rule: ComplianceRule, context: EvaluationContext): Finding[] {
    const minPercent = param(rule, 'min_percent', 1);
    const basis = context.tender.estimatedValue;

    if (!basis) {
      return [
        {
          status: FindingStatus.Inconclusive,
          message: 'The tender has no estimated value, so the minimum cannot be computed.',
        },
      ];
    }

    const scoped = scopedDocuments(rule, context).filter((entry) => entry.version !== null);
    if (scoped.length === 0) {
      return [
        {
          status: FindingStatus.NotApplicable,
          message: 'No bid security document is attached to this tender.',
        },
      ];
    }

    const requiredCents = (toCents(basis) * BigInt(Math.round(minPercent * 100))) / 10_000n;

    return scoped.map((entry): Finding => {
      const base = { documentId: entry.document.id, versionId: entry.version!.id };
      const amount = entry.extraction?.monetaryValue ?? null;

      if (!amount) {
        return {
          ...base,
          status: FindingStatus.Inconclusive,
          message: 'No amount could be read from the bid security document.',
          evidence: { requiredMinimum: fromCents(requiredCents) },
        };
      }

      const actualCents = toCents(amount);

      return actualCents >= requiredCents
        ? {
            ...base,
            status: FindingStatus.Pass,
            message: `Bid security of ${formatIdr(amount)} meets the ${minPercent}% minimum.`,
            evidence: { amount, requiredMinimum: fromCents(requiredCents), minPercent },
          }
        : {
            ...base,
            status: FindingStatus.Fail,
            message:
              `Bid security of ${formatIdr(amount)} is below the required ` +
              `${minPercent}% of the package value (${formatIdr(fromCents(requiredCents))}).`,
            evidence: {
              amount,
              requiredMinimum: fromCents(requiredCents),
              estimatedValue: basis,
              minPercent,
            },
          };
    });
  }
}

/** "1500000000.00" -> 150000000000n cents. Exact; never a float. */
function toCents(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
}

function fromCents(cents: bigint): string {
  const sign = cents < 0n ? '-' : '';
  const absolute = cents < 0n ? -cents : cents;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

function formatIdr(value: string): string {
  const [whole] = value.split('.');
  return `Rp ${BigInt(whole).toLocaleString('id-ID')}`;
}
