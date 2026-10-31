import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Tender } from './tender.entity';
import { DocumentType } from './document-type.entity';
import { DocumentVersion } from './document-version.entity';

/**
 * A required document slot on a tender — "this bid needs an SBU".
 * The file itself lives in DocumentVersion.
 */
@Entity({ name: 'tender_documents' })
export class TenderDocument {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId!: string;

  @Column({ name: 'tender_id', type: 'uuid' })
  tenderId!: string;

  @Column({ name: 'document_type_code', type: 'text' })
  documentTypeCode!: string;

  @Column({ type: 'text' })
  title!: string;

  @Column({ name: 'is_mandatory', type: 'boolean', default: true })
  isMandatory!: boolean;

  @Column({ name: 'current_version_id', type: 'uuid', nullable: true })
  currentVersionId!: string | null;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @ManyToOne(() => Tender, (tender) => tender.documents)
  @JoinColumn({ name: 'tender_id' })
  tender?: Tender;

  @ManyToOne(() => DocumentType)
  @JoinColumn({ name: 'document_type_code', referencedColumnName: 'code' })
  documentType?: DocumentType;

  @OneToMany(() => DocumentVersion, (version) => version.document)
  versions?: DocumentVersion[];
}
