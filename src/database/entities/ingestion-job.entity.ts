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

  /**
   * Deterministic, derived from the **version** id — `ingest-<versionId>`.
   *
   * It was originally derived from the content checksum, which stopped being
   * unique once the same bytes could legitimately belong to two slots: the
   * second version's publish collided with the first job's id and was rejected.
   * One job per version is the identity the pipeline actually needs, and it
   * still makes enqueue idempotent under retry.
   */
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

  /**
   * When the broker accepted this job.
   *
   * NULL on a `queued` row means the database recorded the intent but the
   * publish never completed — the process died in the window between commit and
   * publish. `IngestionReconciler` republishes exactly those.
   */
  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt!: Date | null;

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
