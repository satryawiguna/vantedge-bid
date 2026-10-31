import { DocumentLifecycle, FindingStatus, RuleSeverity } from '../../src/database/enums';
import {
  DocumentReadableEvaluator,
  MandatoryDocumentsPresentEvaluator,
} from '../../src/modules/compliance/evaluators/completeness.evaluators';
import {
  IssuedWithinDaysEvaluator,
  NotExpiredAtDeadlineEvaluator,
} from '../../src/modules/compliance/evaluators/validity.evaluators';
import {
  ClassificationMatchEvaluator,
  MonetaryThresholdEvaluator,
} from '../../src/modules/compliance/evaluators/substance.evaluators';
import { FieldConsistencyEvaluator } from '../../src/modules/compliance/evaluators/consistency.evaluators';
import { makeContext, makeRule, makeSnapshot } from '../helpers/compliance-fixtures';

describe('NotExpiredAtDeadlineEvaluator', () => {
  const evaluator = new NotExpiredAtDeadlineEvaluator();
  const rule = makeRule({ documentTypeCode: 'SBU', evaluator: 'not_expired_at_deadline' });

  it('fails a certificate that expires before the submission deadline', () => {
    const context = makeContext({
      deadline: '2026-12-15T10:00:00Z',
      documents: [makeSnapshot({ typeCode: 'SBU', extraction: { expiresAt: '2026-12-10' } })],
    });

    const [finding] = evaluator.evaluate(rule, context);
    expect(finding.status).toBe(FindingStatus.Fail);
    expect(finding.message).toContain('before the submission deadline');
    expect(finding.evidence).toMatchObject({ expiresAt: '2026-12-10' });
  });

  it('passes a certificate with comfortable margin', () => {
    const context = makeContext({
      deadline: '2026-12-15T10:00:00Z',
      documents: [makeSnapshot({ typeCode: 'SBU', extraction: { expiresAt: '2027-06-30' } })],
    });

    expect(evaluator.evaluate(rule, context)[0].status).toBe(FindingStatus.Pass);
  });

  it('warns when the certificate expires soon after the deadline', () => {
    // Technically compliant, but renewal takes weeks — the warning is the
    // actionable part.
    const context = makeContext({
      deadline: '2026-12-15T10:00:00Z',
      documents: [makeSnapshot({ typeCode: 'SBU', extraction: { expiresAt: '2026-12-25' } })],
    });

    expect(evaluator.evaluate(rule, context)[0].status).toBe(FindingStatus.Warning);
  });

  it('compares against the deadline rather than today', () => {
    // The whole point of the rule. A certificate valid now but expired at the
    // deadline must fail, or the tool reproduces the manual mistake it exists
    // to prevent.
    const context = makeContext({
      deadline: '2027-01-31T10:00:00Z',
      documents: [makeSnapshot({ typeCode: 'SBU', extraction: { expiresAt: '2026-08-01' } })],
    });

    expect(evaluator.evaluate(rule, context)[0].status).toBe(FindingStatus.Fail);
  });

  it('is inconclusive rather than passing when no date could be read', () => {
    const context = makeContext({
      deadline: '2026-12-15T10:00:00Z',
      documents: [makeSnapshot({ typeCode: 'SBU', extraction: { expiresAt: null } })],
    });

    expect(evaluator.evaluate(rule, context)[0].status).toBe(FindingStatus.Inconclusive);
  });
});

describe('MandatoryDocumentsPresentEvaluator', () => {
  const evaluator = new MandatoryDocumentsPresentEvaluator();
  const rule = makeRule({ evaluator: 'mandatory_documents_present' });

  it('fails a mandatory slot with no upload', () => {
    const context = makeContext({
      documents: [makeSnapshot({ typeCode: 'SBU', hasVersion: false, extraction: null })],
    });

    expect(evaluator.evaluate(rule, context)[0].status).toBe(FindingStatus.Fail);
  });

  it('treats a quarantined document as missing', () => {
    // From the committee's side there is no difference between a document you
    // never uploaded and one nobody can open.
    const context = makeContext({
      documents: [
        makeSnapshot({ typeCode: 'SBU', lifecycle: DocumentLifecycle.Quarantined, extraction: null }),
      ],
    });

    expect(evaluator.evaluate(rule, context)[0].status).toBe(FindingStatus.Fail);
  });

  it('is inconclusive while a document is still processing', () => {
    const context = makeContext({
      documents: [
        makeSnapshot({ typeCode: 'SBU', lifecycle: DocumentLifecycle.Processing, extraction: null }),
      ],
    });

    expect(evaluator.evaluate(rule, context)[0].status).toBe(FindingStatus.Inconclusive);
  });

  it('ignores optional slots', () => {
    const context = makeContext({
      documents: [
        makeSnapshot({ typeCode: 'SURAT_DUKUNGAN', isMandatory: false, hasVersion: false, extraction: null }),
      ],
    });

    expect(evaluator.evaluate(rule, context)[0].status).toBe(FindingStatus.NotApplicable);
  });
});

describe('ClassificationMatchEvaluator', () => {
  const evaluator = new ClassificationMatchEvaluator();
  const rule = makeRule({ documentTypeCode: 'SBU', evaluator: 'classification_match' });

  it('fails when the certificate covers the wrong subclassification', () => {
    const context = makeContext({
      requiredSbuCodes: ['SI003'],
      documents: [
        makeSnapshot({ typeCode: 'SBU', extraction: { classificationCodes: ['BG009'] } }),
      ],
    });

    const [finding] = evaluator.evaluate(rule, context);
    expect(finding.status).toBe(FindingStatus.Fail);
    expect(finding.message).toContain('SI003');
  });

  it('passes when at least one required code is held', () => {
    const context = makeContext({
      requiredSbuCodes: ['BG009'],
      documents: [
        makeSnapshot({ typeCode: 'SBU', extraction: { classificationCodes: ['BG009', 'BG004'] } }),
      ],
    });

    expect(evaluator.evaluate(rule, context)[0].status).toBe(FindingStatus.Pass);
  });

  it('is not applicable when the announcement names no classification', () => {
    const context = makeContext({
      documents: [makeSnapshot({ typeCode: 'SBU', extraction: { classificationCodes: ['BG009'] } })],
    });

    expect(evaluator.evaluate(rule, context)[0].status).toBe(FindingStatus.NotApplicable);
  });
});

describe('MonetaryThresholdEvaluator', () => {
  const evaluator = new MonetaryThresholdEvaluator();
  const rule = makeRule({
    documentTypeCode: 'JAMINAN_PENAWARAN',
    evaluator: 'monetary_threshold',
    params: { min_percent: 1.0 },
    severity: RuleSeverity.Blocker,
  });

  it('fails a bid bond below the required percentage', () => {
    const context = makeContext({
      estimatedValue: '15000000000.00', // Rp 15 bn, so 1% = Rp 150 m
      documents: [
        makeSnapshot({
          typeCode: 'JAMINAN_PENAWARAN',
          extraction: { monetaryValue: '149000000.00' },
        }),
      ],
    });

    const [finding] = evaluator.evaluate(rule, context);
    expect(finding.status).toBe(FindingStatus.Fail);
    expect(finding.evidence).toMatchObject({ requiredMinimum: '150000000.00' });
  });

  it('passes a bid bond exactly at the threshold', () => {
    // Exactness matters: this is the case a float comparison gets wrong.
    const context = makeContext({
      estimatedValue: '15000000000.00',
      documents: [
        makeSnapshot({
          typeCode: 'JAMINAN_PENAWARAN',
          extraction: { monetaryValue: '150000000.00' },
        }),
      ],
    });

    expect(evaluator.evaluate(rule, context)[0].status).toBe(FindingStatus.Pass);
  });

  it('stays exact on values past the safe integer range', () => {
    // Rp 92 trillion in cents exceeds Number.MAX_SAFE_INTEGER; a float would
    // round and could pass a bond that is one rupiah short.
    const context = makeContext({
      estimatedValue: '92000000000000.00',
      documents: [
        makeSnapshot({
          typeCode: 'JAMINAN_PENAWARAN',
          extraction: { monetaryValue: '919999999999.99' },
        }),
      ],
    });

    expect(evaluator.evaluate(rule, context)[0].status).toBe(FindingStatus.Fail);
  });
});

describe('FieldConsistencyEvaluator', () => {
  const evaluator = new FieldConsistencyEvaluator();

  it("catches a sister company's document", () => {
    const rule = makeRule({
      evaluator: 'field_consistency',
      params: { field: 'holder_npwp', reference: 'organization.npwp' },
    });

    const context = makeContext({
      documents: [
        makeSnapshot({ typeCode: 'SBU', extraction: { holderNpwp: '999888777666555' } }),
      ],
    });

    const [finding] = evaluator.evaluate(rule, context);
    expect(finding.status).toBe(FindingStatus.Fail);
    expect(finding.message).toContain('another entity');
  });

  it('tolerates legal-form punctuation when matching company names', () => {
    const rule = makeRule({
      evaluator: 'field_consistency',
      params: { field: 'holder_name', fuzzy: true },
    });

    const context = makeContext({
      documents: [
        makeSnapshot({ typeCode: 'SBU', extraction: { holderName: 'PT. KARYA BALI MANDIRI' } }),
      ],
    });

    expect(evaluator.evaluate(rule, context)[0].status).toBe(FindingStatus.Pass);
  });
});

describe('DocumentReadableEvaluator', () => {
  const evaluator = new DocumentReadableEvaluator();
  const rule = makeRule({ evaluator: 'document_readable', params: { min_text_length: 200 } });

  it('fails a document that yielded almost no text', () => {
    const context = makeContext({
      documents: [makeSnapshot({ typeCode: 'SBU', extraction: { raw: { textLength: 12 } } })],
    });

    const [finding] = evaluator.evaluate(rule, context);
    expect(finding.status).toBe(FindingStatus.Fail);
    expect(finding.message).toContain('scan');
  });
});

describe('IssuedWithinDaysEvaluator', () => {
  const evaluator = new IssuedWithinDaysEvaluator();
  const rule = makeRule({
    documentTypeCode: 'KSWP',
    evaluator: 'issued_within_days',
    params: { max_age_days: 30 },
  });

  it('fails a stale taxpayer status confirmation', () => {
    const context = makeContext({
      deadline: '2026-12-15T10:00:00Z',
      documents: [makeSnapshot({ typeCode: 'KSWP', extraction: { issuedAt: '2026-09-01' } })],
    });

    expect(evaluator.evaluate(rule, context)[0].status).toBe(FindingStatus.Fail);
  });

  it('passes a recently issued one', () => {
    const context = makeContext({
      deadline: '2026-12-15T10:00:00Z',
      documents: [makeSnapshot({ typeCode: 'KSWP', extraction: { issuedAt: '2026-12-01' } })],
    });

    expect(evaluator.evaluate(rule, context)[0].status).toBe(FindingStatus.Pass);
  });
});
