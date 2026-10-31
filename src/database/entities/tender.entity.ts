import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { TenderStatus } from '../enums';
import { TenderDocument } from './tender-document.entity';
import { numericTransformer } from '../transformers/numeric.transformer';

@Entity({ name: 'tenders' })
export class Tender {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId!: string;

  @Column({ name: 'tender_code', type: 'text' })
  tenderCode!: string;

  @Column({ type: 'text' })
  title!: string;

  @Column({ name: 'buyer_name', type: 'text' })
  buyerName!: string;

  @Column({ name: 'buyer_lpse_code', type: 'text', nullable: true })
  buyerLpseCode!: string | null;

  @Column({ name: 'work_category', type: 'text', nullable: true })
  workCategory!: string | null;

  @Column({ name: 'required_sbu_codes', type: 'text', array: true, default: () => "'{}'" })
  requiredSbuCodes!: string[];

  /**
   * Postgres numeric comes back from the driver as a string to avoid silent
   * precision loss. We keep it a string in the domain and parse only where a
   * comparison needs it — money is never a JS number in this codebase.
   */
  @Column({
    name: 'estimated_value',
    type: 'numeric',
    precision: 18,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  estimatedValue!: string | null;

  @Column({ type: 'char', length: 3, default: 'IDR' })
  currency!: string;

  @Column({ name: 'submission_deadline', type: 'timestamptz', nullable: true })
  submissionDeadline!: Date | null;

  @Column({ name: 'source_url', type: 'text', nullable: true })
  sourceUrl!: string | null;

  @Column({ type: 'enum', enum: TenderStatus, enumName: 'tender_status', default: TenderStatus.Monitoring })
  status!: TenderStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @OneToMany(() => TenderDocument, (document) => document.tender)
  documents?: TenderDocument[];
}
