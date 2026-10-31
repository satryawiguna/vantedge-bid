import {
  ComplianceRule,
  DocumentExtraction,
  DocumentType,
  DocumentVersion,
  Organization,
  Tender,
  TenderDocument,
} from '../../src/database/entities';
import { DocumentLifecycle, RuleSeverity } from '../../src/database/enums';
import { DocumentSnapshot, EvaluationContext } from '../../src/modules/compliance/evaluators/types';

export function makeRule(overrides: Partial<ComplianceRule> = {}): ComplianceRule {
  return {
    id: 'rule-1',
    rulesetId: 'ruleset-1',
    code: 'TEST.RULE',
    name: 'Test rule',
    description: null,
    documentTypeCode: null,
    severity: RuleSeverity.Blocker,
    evaluator: 'noop',
    params: {},
    isActive: true,
    createdAt: new Date(),
    ...overrides,
  } as ComplianceRule;
}

export function makeDocumentType(code: string, name = code): DocumentType {
  return {
    code,
    name,
    category: 'kualifikasi',
    description: null,
    hasExpiry: true,
    isMandatoryDefault: true,
    allowedMimeTypes: ['application/pdf'],
    maxSizeBytes: 10_485_760,
    createdAt: new Date(),
  } as DocumentType;
}

export function makeSnapshot(params: {
  typeCode: string;
  isMandatory?: boolean;
  lifecycle?: DocumentLifecycle;
  hasVersion?: boolean;
  extraction?: Partial<DocumentExtraction> | null;
}): DocumentSnapshot {
  const type = makeDocumentType(params.typeCode);

  const document = {
    id: `doc-${params.typeCode}`,
    organizationId: 'org-1',
    tenderId: 'tender-1',
    documentTypeCode: params.typeCode,
    title: type.name,
    isMandatory: params.isMandatory ?? true,
    currentVersionId: params.hasVersion === false ? null : `ver-${params.typeCode}`,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as TenderDocument;

  const version =
    params.hasVersion === false
      ? null
      : ({
          id: `ver-${params.typeCode}`,
          organizationId: 'org-1',
          documentId: document.id,
          versionNo: 1,
          originalFilename: `${params.typeCode}.pdf`,
          storageBucket: 'tender-documents',
          storageKey: `key/${params.typeCode}`,
          mimeType: 'application/pdf',
          sizeBytes: 1024,
          checksumSha256: 'a'.repeat(64),
          pageCount: 1,
          lifecycle: params.lifecycle ?? DocumentLifecycle.Processed,
          uploadedBy: null,
          uploadedAt: new Date(),
          processedAt: new Date(),
          failureReason: null,
          metadata: {},
        } as DocumentVersion);

  const extraction =
    params.extraction === null || params.extraction === undefined
      ? null
      : ({
          id: `ext-${params.typeCode}`,
          versionId: version!.id,
          textStorageKey: null,
          documentNumber: null,
          issuer: null,
          holderName: null,
          holderNpwp: null,
          issuedAt: null,
          expiresAt: null,
          classificationCodes: [],
          monetaryValue: null,
          confidence: 1,
          extractorVersion: 'test',
          raw: { textLength: 1000 },
          createdAt: new Date(),
          ...params.extraction,
        } as DocumentExtraction);

  return { document, type, version, extraction };
}

export function makeContext(params: {
  documents: DocumentSnapshot[];
  deadline?: string | null;
  estimatedValue?: string | null;
  requiredSbuCodes?: string[];
  organization?: Partial<Organization>;
}): EvaluationContext {
  return {
    organization: {
      id: 'org-1',
      slug: 'karya-bali',
      name: 'PT Karya Bali Mandiri',
      npwp: '012345678901234',
      nib: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...params.organization,
    } as Organization,
    tender: {
      id: 'tender-1',
      organizationId: 'org-1',
      tenderCode: 'LPSE-2026-0001',
      title: 'Pembangunan Gedung',
      buyerName: 'Dinas PU',
      buyerLpseCode: null,
      workCategory: 'bangunan_gedung',
      requiredSbuCodes: params.requiredSbuCodes ?? [],
      estimatedValue: params.estimatedValue ?? null,
      currency: 'IDR',
      submissionDeadline:
        params.deadline === null || params.deadline === undefined
          ? null
          : new Date(params.deadline),
      sourceUrl: null,
      status: 'preparing',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as Tender,
    documents: params.documents,
    now: new Date('2026-06-01T00:00:00Z'),
  };
}
