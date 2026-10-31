import { ComplianceRule } from '../../../database/entities';
import { DocumentLifecycle, FindingStatus } from '../../../database/enums';
import { EvaluationContext, Finding, RuleEvaluator, param, scopedDocuments } from './types';

/**
 * Is every mandatory slot filled with a document that actually processed?
 *
 * A slot holding a quarantined or failed file counts as missing. From the
 * procurement committee's side there is no difference between a document you
 * never uploaded and one nobody can open.
 */
export class MandatoryDocumentsPresentEvaluator implements RuleEvaluator {
  readonly key = 'mandatory_documents_present';

  evaluate(rule: ComplianceRule, context: EvaluationContext): Finding[] {
    const mandatory = context.documents.filter((entry) => entry.document.isMandatory);

    if (mandatory.length === 0) {
      return [
        {
          status: FindingStatus.NotApplicable,
          message: 'No mandatory document slots are defined for this tender yet.',
        },
      ];
    }

    return mandatory.map((entry): Finding => {
      const version = entry.version;

      if (!version) {
        return {
          status: FindingStatus.Fail,
          message: `${entry.type.name} has not been uploaded.`,
          documentId: entry.document.id,
          evidence: { documentTypeCode: entry.type.code },
        };
      }

      if (version.lifecycle !== DocumentLifecycle.Processed) {
        const terminal =
          version.lifecycle === DocumentLifecycle.Failed ||
          version.lifecycle === DocumentLifecycle.Quarantined;

        return {
          status: terminal ? FindingStatus.Fail : FindingStatus.Inconclusive,
          message: terminal
            ? `${entry.type.name} could not be processed: ${version.failureReason ?? 'unknown reason'}.`
            : `${entry.type.name} is still being processed (${version.lifecycle}).`,
          documentId: entry.document.id,
          versionId: version.id,
          evidence: { lifecycle: version.lifecycle, failureReason: version.failureReason },
        };
      }

      return {
        status: FindingStatus.Pass,
        message: `${entry.type.name} is present and processed.`,
        documentId: entry.document.id,
        versionId: version.id,
      };
    });
  }
}

/**
 * Did the file yield enough text to be checkable?
 *
 * A scanned certificate passes every structural check and tells the compliance
 * engine nothing. Surfacing it as a finding is more useful than letting the
 * downstream rules quietly return "no data, so no problem".
 */
export class DocumentReadableEvaluator implements RuleEvaluator {
  readonly key = 'document_readable';

  evaluate(rule: ComplianceRule, context: EvaluationContext): Finding[] {
    const minLength = param(rule, 'min_text_length', 200);

    return scopedDocuments(rule, context)
      .filter((entry) => entry.version !== null)
      .map((entry): Finding => {
        const textLength = Number(entry.extraction?.raw?.['textLength'] ?? 0);

        if (!entry.extraction) {
          return {
            status: FindingStatus.Inconclusive,
            message: `${entry.type.name} has not been processed yet.`,
            documentId: entry.document.id,
            versionId: entry.version!.id,
          };
        }

        return textLength >= minLength
          ? {
              status: FindingStatus.Pass,
              message: `${entry.type.name} is machine readable.`,
              documentId: entry.document.id,
              versionId: entry.version!.id,
              evidence: { textLength },
            }
          : {
              status: FindingStatus.Fail,
              message:
                `${entry.type.name} yielded only ${textLength} characters of text. ` +
                'It is probably a scan — upload a digitally generated copy.',
              documentId: entry.document.id,
              versionId: entry.version!.id,
              evidence: { textLength, minLength },
            };
      });
  }
}

/**
 * A document that is only required above a value threshold.
 *
 * Bid security is the live example: not required on small packages, mandatory
 * above the limit. Encoding the condition as a rule keeps the "when" in the
 * database next to the "what".
 */
export class ConditionallyRequiredEvaluator implements RuleEvaluator {
  readonly key = 'conditionally_required';

  evaluate(rule: ComplianceRule, context: EvaluationContext): Finding[] {
    const threshold = param<number | null>(rule, 'gte', null);
    const estimatedValue = context.tender.estimatedValue
      ? Number.parseFloat(context.tender.estimatedValue)
      : null;

    if (threshold === null || estimatedValue === null) {
      return [
        {
          status: FindingStatus.Inconclusive,
          message: 'The tender has no estimated value recorded, so the condition cannot be tested.',
          evidence: { threshold, estimatedValue },
        },
      ];
    }

    if (estimatedValue < threshold) {
      return [
        {
          status: FindingStatus.NotApplicable,
          message: `Not required below ${formatIdr(threshold)}.`,
          evidence: { estimatedValue, threshold },
        },
      ];
    }

    const present = scopedDocuments(rule, context).some(
      (entry) => entry.version !== null,
    );

    return [
      present
        ? {
            status: FindingStatus.Pass,
            message: `Required above ${formatIdr(threshold)} and present.`,
            evidence: { estimatedValue, threshold },
          }
        : {
            status: FindingStatus.Fail,
            message:
              `This package is valued at ${formatIdr(estimatedValue)}, above the ` +
              `${formatIdr(threshold)} threshold, so ${rule.documentTypeCode} is required.`,
            evidence: { estimatedValue, threshold },
          },
    ];
  }
}

function formatIdr(value: number): string {
  return `Rp ${value.toLocaleString('id-ID')}`;
}
