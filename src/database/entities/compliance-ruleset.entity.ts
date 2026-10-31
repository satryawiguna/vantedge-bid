import { Column, CreateDateColumn, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { ComplianceRule } from './compliance-rule.entity';

/**
 * An immutable, versioned snapshot of the regulation in force.
 *
 * Audits reference the ruleset they ran under, so a verdict rendered months ago
 * can still be explained after the rules change. Editing a published ruleset is
 * not supported by design — you publish a new version.
 */
@Entity({ name: 'compliance_rulesets' })
export class ComplianceRuleset {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  code!: string;

  @Column({ type: 'int' })
  version!: number;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ name: 'effective_from', type: 'date' })
  effectiveFrom!: string;

  @Column({ name: 'effective_to', type: 'date', nullable: true })
  effectiveTo!: string | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @OneToMany(() => ComplianceRule, (rule) => rule.ruleset)
  rules?: ComplianceRule[];
}
