import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { DocumentLifecycle } from '../enums';
import { TenderDocument } from './tender-document.entity';
import { DocumentExtraction } from './document-extraction.entity';

/**
 * The physical file. Immutable once written — a correction creates a new row
 * with the next version_no, so nothing a past audit cited can change underneath
 * it.
 */
@Entity({ name: 'document_versions' })
export class DocumentVersion {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId!: string;

  @Column({ name: 'document_id', type: 'uuid' })
  documentId!: string;

  @Column({ name: 'version_no', type: 'int' })
  versionNo!: number;

  @Column({ name: 'original_filename', type: 'text' })
  originalFilename!: string;

  @Column({ name: 'storage_bucket', type: 'text' })
  storageBucket!: string;

  @Column({ name: 'storage_key', type: 'text' })
  storageKey!: string;

  @Column({ name: 'mime_type', type: 'text' })
  mimeType!: string;

  @Column({
    name: 'size_bytes',
    type: 'bigint',
    transformer: {
      to: (value: number): string => String(value),
      from: (value: string): number => Number.parseInt(value, 10),
    },
  })
  sizeBytes!: number;

  @Column({ name: 'checksum_sha256', type: 'char', length: 64 })
  checksumSha256!: string;

  @Column({ name: 'page_count', type: 'int', nullable: true })
  pageCount!: number | null;

  @Column({
    type: 'enum',
    enum: DocumentLifecycle,
    enumName: 'document_lifecycle',
    default: DocumentLifecycle.Pending,
  })
  lifecycle!: DocumentLifecycle;

  @Column({ name: 'uploaded_by', type: 'uuid', nullable: true })
  uploadedBy!: string | null;

  @CreateDateColumn({ name: 'uploaded_at', type: 'timestamptz' })
  uploadedAt!: Date;

  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt!: Date | null;

  @Column({ name: 'failure_reason', type: 'text', nullable: true })
  failureReason!: string | null;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  metadata!: Record<string, unknown>;

  @ManyToOne(() => TenderDocument, (document) => document.versions)
  @JoinColumn({ name: 'document_id' })
  document?: TenderDocument;

  @OneToOne(() => DocumentExtraction, (extraction) => extraction.version)
  extraction?: DocumentExtraction;
}
