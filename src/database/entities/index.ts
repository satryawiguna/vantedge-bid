import { Organization } from './organization.entity';
import { User } from './user.entity';
import { Tender } from './tender.entity';
import { DocumentType } from './document-type.entity';
import { TenderDocument } from './tender-document.entity';
import { DocumentVersion } from './document-version.entity';
import { DocumentExtraction } from './document-extraction.entity';
import { IngestionJob } from './ingestion-job.entity';
import { ComplianceRuleset } from './compliance-ruleset.entity';
import { ComplianceRule } from './compliance-rule.entity';
import { ComplianceAudit } from './compliance-audit.entity';
import { ComplianceFinding } from './compliance-finding.entity';
import { AuditTrailEntry } from './audit-trail.entity';

export {
  Organization,
  User,
  Tender,
  DocumentType,
  TenderDocument,
  DocumentVersion,
  DocumentExtraction,
  IngestionJob,
  ComplianceRuleset,
  ComplianceRule,
  ComplianceAudit,
  ComplianceFinding,
  AuditTrailEntry,
};

export const ENTITIES = [
  Organization,
  User,
  Tender,
  DocumentType,
  TenderDocument,
  DocumentVersion,
  DocumentExtraction,
  IngestionJob,
  ComplianceRuleset,
  ComplianceRule,
  ComplianceAudit,
  ComplianceFinding,
  AuditTrailEntry,
];
