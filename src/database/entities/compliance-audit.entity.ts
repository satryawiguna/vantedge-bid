import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { AuditStatus, AuditVerdict } from '../enums';
import { ComplianceFinding } from './compliance-finding.entity';
import { numericTransformer } from '../transformers/numeric.transformer';

@Entity({ name: 'compliance_audits' })
export class ComplianceAudit {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId!: string;

  @Column({ name: 'tender_id', type: 'uuid' })
  tenderId!: string;

  /** Pins the verdict to an immutable ruleset version — this is what makes it reproducible. */
  @Column({ name: 'ruleset_id', type: 'uuid' })
  rulesetId!: string;

  @Column({ type: 'text', default: 'manual' })
  trigger!: 'manual' | 'document_ingested' | 'scheduled' | 'deadline_approaching';

  @Column({ type: 'enum', enum: AuditStatus, enumName: 'audit_status', default: AuditStatus.Queued })
  status!: AuditStatus;

  @Column({ type: 'enum', enum: AuditVerdict, enumName: 'audit_verdict', nullable: true })
  verdict!: AuditVerdict | null;

  @Column({
    type: 'numeric',
    precision: 5,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  score!: string | null;

  @Column({ name: 'total_rules', type: 'int', default: 0 })
  totalRules!: number;

  @Column({ name: 'passed_count', type: 'int', default: 0 })
  passedCount!: number;

  @Column({ name: 'failed_count', type: 'int', default: 0 })
  failedCount!: number;

  @Column({ name: 'warning_count', type: 'int', default: 0 })
  warningCount!: number;

  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt!: Date | null;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @OneToMany(() => ComplianceFinding, (finding) => finding.audit)
  findings?: ComplianceFinding[];
}
