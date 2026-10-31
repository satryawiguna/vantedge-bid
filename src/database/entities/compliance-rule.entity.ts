import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { RuleSeverity } from '../enums';
import { ComplianceRuleset } from './compliance-ruleset.entity';

/**
 * Rules are data; evaluators are code.
 *
 * `evaluator` names a registered handler and `params` configures it. Changing a
 * threshold is an UPDATE, not a deployment. The evaluator set is deliberately
 * closed rather than an expression DSL: in a compliance product the ability to
 * explain a verdict matters more than the ability to express every rule.
 */
@Entity({ name: 'compliance_rules' })
export class ComplianceRule {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'ruleset_id', type: 'uuid' })
  rulesetId!: string;

  @Column({ type: 'text' })
  code!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  /** NULL means the rule is evaluated at tender level, not against one document. */
  @Column({ name: 'document_type_code', type: 'text', nullable: true })
  documentTypeCode!: string | null;

  @Column({ type: 'enum', enum: RuleSeverity, enumName: 'rule_severity', default: RuleSeverity.Major })
  severity!: RuleSeverity;

  @Column({ type: 'text' })
  evaluator!: string;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  params!: Record<string, unknown>;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @ManyToOne(() => ComplianceRuleset, (ruleset) => ruleset.rules)
  @JoinColumn({ name: 'ruleset_id' })
  ruleset?: ComplianceRuleset;
}
