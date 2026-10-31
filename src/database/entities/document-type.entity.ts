import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * Reference data. The catalogue of tender document types grows with regulation,
 * so it lives in a table rather than a TypeScript enum — adding a type is an
 * INSERT, not a deployment.
 */
@Entity({ name: 'document_types' })
export class DocumentType {
  @PrimaryColumn({ type: 'text' })
  code!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text' })
  category!: 'administrasi' | 'kualifikasi' | 'teknis' | 'harga';

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ name: 'has_expiry', type: 'boolean', default: false })
  hasExpiry!: boolean;

  @Column({ name: 'is_mandatory_default', type: 'boolean', default: true })
  isMandatoryDefault!: boolean;

  @Column({ name: 'allowed_mime_types', type: 'text', array: true })
  allowedMimeTypes!: string[];

  /** bigint arrives as a string from the driver; parsed once at the edge. */
  @Column({
    name: 'max_size_bytes',
    type: 'bigint',
    transformer: {
      to: (value: number): string => String(value),
      from: (value: string): number => Number.parseInt(value, 10),
    },
  })
  maxSizeBytes!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
