import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { FindingStatus, RuleSeverity } from '../enums';
import { ComplianceAudit } from './compliance-audit.entity';

/**
 * One row per rule evaluation.
 *
 * Rule code and severity are snapshotted at evaluation time so a historical
 * finding keeps its original meaning even if the rule is later re-tuned.
 */
@Entity({ name: 'compliance_findings' })
export class ComplianceFinding {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'audit_id', type: 'uuid' })
  auditId!: string;

  @Column({ name: 'rule_id', type: 'uuid' })
  ruleId!: string;

  @Column({ name: 'rule_code_snapshot', type: 'text' })
  ruleCodeSnapshot!: string;

  @Column({ name: 'severity_snapshot', type: 'enum', enum: RuleSeverity, enumName: 'rule_severity' })
  severitySnapshot!: RuleSeverity;

  @Column({ type: 'enum', enum: FindingStatus, enumName: 'finding_status' })
  status!: FindingStatus;

  @Column({ name: 'document_id', type: 'uuid', nullable: true })
  documentId!: string | null;

  @Column({ name: 'version_id', type: 'uuid', nullable: true })
  versionId!: string | null;

  @Column({ type: 'text' })
  message!: string;

  /** Whatever the evaluator looked at, so a human can check its work. */
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  evidence!: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @ManyToOne(() => ComplianceAudit, (audit) => audit.findings)
  @JoinColumn({ name: 'audit_id' })
  audit?: ComplianceAudit;
}
