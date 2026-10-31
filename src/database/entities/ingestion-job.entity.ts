import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { IngestionJobState } from '../enums';

/**
 * Durable mirror of queue state.
 *
 * BullMQ owns the live job; Redis is a cache and its completed jobs are trimmed.
 * This table is the queryable history behind retry analysis, dead-letter review
 * and throughput dashboards — questions the broker cannot answer a week later.
 */
@Entity({ name: 'ingestion_jobs' })
export class IngestionJob {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId!: string;

  @Column({ name: 'version_id', type: 'uuid' })
  versionId!: string;

  @Column({ name: 'queue_name', type: 'text' })
  queueName!: string;

  /** Deterministic, derived from the content checksum — makes enqueue idempotent. */
  @Column({ name: 'job_key', type: 'text' })
  jobKey!: string;

  @Column({
    type: 'enum',
    enum: IngestionJobState,
    enumName: 'ingestion_job_state',
    default: IngestionJobState.Queued,
  })
  state!: IngestionJobState;

  @Column({ type: 'int', default: 0 })
  attempt!: number;

  @Column({ name: 'max_attempts', type: 'int', default: 5 })
  maxAttempts!: number;

  @Column({ type: 'int', default: 100 })
  priority!: number;

  @CreateDateColumn({ name: 'enqueued_at', type: 'timestamptz' })
  enqueuedAt!: Date;

  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt!: Date | null;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt!: Date | null;

  @Column({ name: 'duration_ms', type: 'int', nullable: true })
  durationMs!: number | null;

  @Column({ name: 'error_class', type: 'text', nullable: true })
  errorClass!: string | null;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage!: string | null;
}
