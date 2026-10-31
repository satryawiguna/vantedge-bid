import { ComplianceRule } from '../../../database/entities';
import { FindingStatus } from '../../../database/enums';
import { EvaluationContext, Finding, RuleEvaluator, param, scopedDocuments } from './types';

/**
 * Do the documents all belong to the same company?
 *
 * Contractors routinely operate several legal entities and keep a shared
 * document folder. Submitting a sister company's SBU alongside your own NPWP
 * is an easy mistake and a fatal one.
 */
export class FieldConsistencyEvaluator implements RuleEvaluator {
  readonly key = 'field_consistency';

  evaluate(rule: ComplianceRule, context: EvaluationContext): Finding[] {
    const field = param<'holder_npwp' | 'holder_name'>(rule, 'field', 'holder_name');
    const fuzzy = param(rule, 'fuzzy', false);

    const expected =
      field === 'holder_npwp' ? context.organization.npwp : context.organization.name;

    if (!expected) {
      return [
        {
          status: FindingStatus.Inconclusive,
          message: `The organisation profile has no ${field} recorded to compare against.`,
        },
      ];
    }

    const scoped = scopedDocuments(rule, context).filter(
      (entry) => entry.version !== null && entry.extraction !== null,
    );

    const checked = scoped.filter((entry) =>
      field === 'holder_npwp'
        ? entry.extraction!.holderNpwp !== null
        : entry.extraction!.holderName !== null,
    );

    if (checked.length === 0) {
      return [
        {
          status: FindingStatus.NotApplicable,
          message: `No document yielded a ${field} value to compare.`,
        },
      ];
    }

    return checked.map((entry): Finding => {
      const actual =
        field === 'holder_npwp' ? entry.extraction!.holderNpwp! : entry.extraction!.holderName!;

      const matches = fuzzy
        ? normaliseCompanyName(actual) === normaliseCompanyName(expected)
        : normaliseDigits(actual) === normaliseDigits(expected);

      return matches
        ? {
            status: FindingStatus.Pass,
            message: `${entry.type.name} matches the organisation ${field}.`,
            documentId: entry.document.id,
            versionId: entry.version!.id,
          }
        : {
            status: FindingStatus.Fail,
            message:
              `${entry.type.name} shows "${actual}" where the organisation profile ` +
              `says "${expected}". Check you are not submitting another entity's document.`,
            documentId: entry.document.id,
            versionId: entry.version!.id,
            evidence: { field, expected, actual },
          };
    });
  }
}

/**
 * How much of this audit rests on uncertain reading?
 *
 * Reported as its own finding rather than silently weighting the others: the
 * user should be able to see that three checks passed only because the parser
 * was guessing.
 */
export class ExtractionConfidenceEvaluator implements RuleEvaluator {
  readonly key = 'extraction_confidence';

  evaluate(rule: ComplianceRule, context: EvaluationContext): Finding[] {
    const minConfidence = param(rule, 'min_confidence', 0.7);

    const scored = scopedDocuments(rule, context).filter(
      (entry) => entry.version !== null && entry.extraction !== null,
    );

    if (scored.length === 0) {
      return [
        {
          status: FindingStatus.NotApplicable,
          message: 'No processed documents to assess.',
        },
      ];
    }

    const low = scored.filter((entry) => entry.extraction!.confidence < minConfidence);

    if (low.length === 0) {
      return [
        {
          status: FindingStatus.Pass,
          message: `All ${scored.length} processed document(s) were read with adequate confidence.`,
          evidence: { minConfidence, assessed: scored.length },
        },
      ];
    }

    return low.map((entry): Finding => ({
      status: FindingStatus.Warning,
      message:
        `${entry.type.name} was read with ${Math.round(entry.extraction!.confidence * 100)}% ` +
        'confidence. Verify its details by hand before relying on this audit.',
      documentId: entry.document.id,
      versionId: entry.version!.id,
      evidence: { confidence: entry.extraction!.confidence, minConfidence },
    }));
  }
}

/** Strip legal-form prefixes and punctuation: "PT. Karya Jaya" ≈ "PT KARYA JAYA". */
function normaliseCompanyName(value: string): string {
  return value
    .toUpperCase()
    .replace(/\b(PT|CV|UD|PD)\b\.?/g, '')
    .replace(/[^A-Z0-9]/g, '');
}

function normaliseDigits(value: string): string {
  return value.replace(/\D/g, '');
}
