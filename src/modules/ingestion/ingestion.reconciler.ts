import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { DocumentType } from '../../database/entities';
import { IngestionQueueService } from './ingestion.queue';
import { ComplianceQueueService } from '../compliance/compliance.queue';
import {
  DEFAULT_PRIORITY,
  IngestionJobPayload,
  PRIORITY_BY_CATEGORY,
  ingestionJobId,
} from './ingestion.constants';

/**
 * Republishes ingestion work the broker never received.
 *
 * The API commits the `ingestion_jobs` row and then publishes (ADR 0002). That
 * ordering is what stops a worker seeing state that is not yet durable, but it
 * leaves a window: the process can die between the commit and the publish, and
 * the database is then left holding intent nobody will act on.
 *
 * `resumeIfStalled` already repairs that when the client retries. This covers
 * the case where nobody retries — which is the normal case, because a client
 * that received no response usually gives up rather than repeating itself.
 *
 * It is a reconciler over the existing ledger, not an outbox framework:
 * `ingestion_jobs` is already the outbox, and `published_at` is the only thing
 * it was missing.
 */
@Injectable()
export class IngestionReconciler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IngestionReconciler.name);
  private timer?: NodeJS.Timeout;

  /**
   * How long a committed-but-unpublished row is left alone.
   *
   * It must exceed the time between the commit and the publish in a healthy
   * request, or the reconciler would race live traffic and publish jobs the API
   * is about to publish itself. That gap is a single UPDATE and one Redis round
   * trip — milliseconds — so thirty seconds is several orders of magnitude of
   * headroom. Republishing is idempotent anyway (the job id is deterministic),
   * so the cost of being wrong here is a no-op rather than duplicated work.
   */
  private readonly graceMs: number;
  private readonly intervalMs: number;
  private readonly batchSize = 50;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly queue: IngestionQueueService,
    private readonly auditQueue: ComplianceQueueService,
    config: ConfigService,
  ) {
    this.graceMs = config.get<number>('queue.reconcileGraceMs', 30_000);
    this.intervalMs = config.get<number>('queue.reconcileIntervalMs', 30_000);
  }

  onModuleInit(): void {
    if (this.intervalMs <= 0) {
      this.logger.log('Ingestion reconciler disabled by configuration');
      return;
    }
    this.timer = setInterval(() => {
      void this.reconcile().catch((error: unknown) => {
        this.logger.error({ err: error }, 'Ingestion reconciliation failed');
      });
      void this.reconcileAudits().catch((error: unknown) => {
        this.logger.error({ err: error }, 'Audit reconciliation failed');
      });
    }, this.intervalMs);
    // Do not hold the process open purely to run housekeeping.
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * One reconciliation pass. Returns how many jobs were republished.
   *
   * Public and directly callable so a test can drive it deterministically
   * instead of waiting for a timer.
   */
  async reconcile(): Promise<number> {
    const cutoff = new Date(Date.now() - this.graceMs);

    // One transaction per pass. SKIP LOCKED is what makes this safe to run on
    // every API and worker instance at once: each pass takes rows nobody else
    // is holding, so instances divide the backlog instead of contending or
    // double-publishing.
    return this.dataSource.transaction(async (manager) => {
      const rows = await manager.query<Array<ReconcileRow>>(
        `SELECT j.id, j.job_key, j.version_id, j.priority, j.organization_id,
                v.storage_bucket, v.storage_key, v.checksum_sha256, v.mime_type,
                d.id   AS document_id,
                d.tender_id,
                d.document_type_code
           FROM ingestion_jobs j
           JOIN document_versions v ON v.id = j.version_id
           JOIN tender_documents  d ON d.id = v.document_id
          WHERE j.published_at IS NULL
            AND j.state = 'queued'
            AND j.enqueued_at < $1
          ORDER BY j.enqueued_at
          LIMIT $2
            FOR UPDATE OF j SKIP LOCKED`,
        [cutoff, this.batchSize],
      );

      if (rows.length === 0) return 0;

      const types = await manager.getRepository(DocumentType).find();
      const categoryByCode = new Map(types.map((type) => [type.code, type.category]));

      let republished = 0;

      for (const row of rows) {
        const jobId = ingestionJobId(row.version_id);

        // Deterministic ids make republishing a no-op when the job is in fact
        // live, so a lost acknowledgement cannot turn into duplicated work.
        if ((await this.queue.getJobState(jobId)) !== null) {
          await manager.query('UPDATE ingestion_jobs SET published_at = now() WHERE id = $1', [
            row.id,
          ]);
          continue;
        }

        const payload: IngestionJobPayload = {
          versionId: row.version_id,
          documentId: row.document_id,
          tenderId: row.tender_id,
          organizationId: row.organization_id,
          documentTypeCode: row.document_type_code,
          storageBucket: row.storage_bucket,
          storageKey: row.storage_key,
          checksum: row.checksum_sha256,
          mimeType: row.mime_type,
        };

        const priority =
          PRIORITY_BY_CATEGORY[categoryByCode.get(row.document_type_code) ?? ''] ??
          row.priority ??
          DEFAULT_PRIORITY;

        await this.queue.enqueue(payload, priority, jobId);
        await manager.query('UPDATE ingestion_jobs SET published_at = now() WHERE id = $1', [
          row.id,
        ]);

        republished += 1;
        this.logger.warn(
          { versionId: row.version_id, jobKey: row.job_key },
          'Republished an ingestion job that was committed but never reached the broker',
        );
      }

      return republished;
    });
  }

  /**
   * Reschedule audits that are owed but have nothing live carrying them.
   *
   * `tender_audit_state.pending` is durable; the BullMQ job is not. A worker
   * that restarts mid-audit, or one whose job exhausted its retries, leaves
   * intent recorded with no job to act on it. Without this sweep the tender
   * would wait for the next upload to notice — and a tender whose last upload
   * has already happened would simply never be audited.
   *
   * Returns how many were rescheduled.
   */
  async reconcileAudits(): Promise<number> {
    const cutoff = new Date(Date.now() - this.graceMs);

    // Claim inside the transaction, publish outside it.
    //
    // Publishing inside would deadlock against itself: the rows are held by
    // `FOR UPDATE`, and the scheduling path writes `scheduled_job_id` on a
    // different connection, which then waits for a lock this transaction will
    // not release until it returns.
    const claimed = await this.dataSource.transaction(async (manager) => {
      const rows = await manager.query<
        Array<{ tender_id: string; organization_id: string; scheduled_job_id: string | null }>
      >(
        `SELECT tender_id, organization_id, scheduled_job_id
           FROM tender_audit_state
          WHERE pending
            AND requested_at < $1
          ORDER BY requested_at
          LIMIT $2
            FOR UPDATE SKIP LOCKED`,
        [cutoff, this.batchSize],
      );

      const toPublish: Array<{ organizationId: string; tenderId: string; jobId: string }> = [];

      for (const row of rows) {
        // Something may already be carrying it; only step in when nothing is.
        if (row.scheduled_job_id) {
          const state = await this.auditQueue.getJobState(row.scheduled_job_id);
          if (
            state === 'waiting' ||
            state === 'delayed' ||
            state === 'prioritized' ||
            state === 'active'
          ) {
            continue;
          }
        }

        const jobId = `audit-${row.tender_id}-${randomUUID()}`;
        await manager.query(
          'UPDATE tender_audit_state SET scheduled_job_id = $2 WHERE tender_id = $1',
          [row.tender_id, jobId],
        );

        toPublish.push({
          organizationId: row.organization_id,
          tenderId: row.tender_id,
          jobId,
        });
      }

      return toPublish;
    });

    for (const entry of claimed) {
      await this.auditQueue.publish(
        { organizationId: entry.organizationId, tenderId: entry.tenderId },
        entry.jobId,
      );
      this.logger.warn(
        { tenderId: entry.tenderId },
        'Rescheduled a compliance audit that was owed with no job to run it',
      );
    }

    return claimed.length;
  }
}

interface ReconcileRow {
  id: string;
  job_key: string;
  version_id: string;
  priority: number;
  organization_id: string;
  storage_bucket: string;
  storage_key: string;
  checksum_sha256: string;
  mime_type: string;
  document_id: string;
  tender_id: string;
  document_type_code: string;
}
