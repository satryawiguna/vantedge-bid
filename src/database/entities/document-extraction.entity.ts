import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { DocumentVersion } from './document-version.entity';
import { numericTransformer } from '../transformers/numeric.transformer';

/**
 * Structured fields pulled out of a document version. Separate from the version
 * row because extraction is re-runnable: a better parser replaces this row and
 * leaves the immutable file record alone.
 *
 * Full document text is NOT stored here — only a storage key pointing at the
 * object store, so the table stays small enough to keep in cache.
 */
@Entity({ name: 'document_extractions' })
export class DocumentExtraction {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'version_id', type: 'uuid' })
  versionId!: string;

  @Column({ name: 'text_storage_key', type: 'text', nullable: true })
  textStorageKey!: string | null;

  @Column({ name: 'document_number', type: 'text', nullable: true })
  documentNumber!: string | null;

  @Column({ type: 'text', nullable: true })
  issuer!: string | null;

  @Column({ name: 'holder_name', type: 'text', nullable: true })
  holderName!: string | null;

  @Column({ name: 'holder_npwp', type: 'text', nullable: true })
  holderNpwp!: string | null;

  @Column({ name: 'issued_at', type: 'date', nullable: true })
  issuedAt!: string | null;

  @Column({ name: 'expires_at', type: 'date', nullable: true })
  expiresAt!: string | null;

  @Column({ name: 'classification_codes', type: 'text', array: true, default: () => "'{}'" })
  classificationCodes!: string[];

  @Column({
    name: 'monetary_value',
    type: 'numeric',
    precision: 18,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  monetaryValue!: string | null;

  /**
   * Fields that only some document types carry — KBLI codes on an NIB, the
   * qualification grade on an SBU, the guarantor on a bid bond.
   *
   * A field graduates to its own column once a compliance rule, a filter or a
   * join depends on it. `expires_at` and `holder_npwp` are columns for exactly
   * that reason; `certificate_grade` is not, because nothing reads it yet.
   */
  @Column({ name: 'extracted_data', type: 'jsonb', default: () => "'{}'::jsonb" })
  extractedData!: Record<string, unknown>;

  @Column({
    type: 'numeric',
    precision: 4,
    scale: 3,
    default: 1.0,
    transformer: {
      to: (value: number): number => value,
      from: (value: string): number => Number.parseFloat(value),
    },
  })
  confidence!: number;

  @Column({ name: 'extractor_version', type: 'text' })
  extractorVersion!: string;

  /** Diagnostics about the extraction run, not about the document. */
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  raw!: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @OneToOne(() => DocumentVersion, (version) => version.extraction)
  @JoinColumn({ name: 'version_id' })
  version?: DocumentVersion;
}
