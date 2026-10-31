import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { Job, UnrecoverableError } from 'bullmq';
import { DataSource } from 'typeorm';
import {
  AuditTrailEntry,
  DocumentVersion,
  IngestionJob,
} from '../../database/entities';
import { DocumentLifecycle, IngestionJobState } from '../../database/enums';
import { ComplianceService } from '../compliance/compliance.service';
import { ExtractionService } from './extraction/extraction.service';
import { INGESTION_QUEUE, IngestionJobPayload } from './ingestion.constants';

/**
 * The asynchronous half of ingestion.
 *
 * Runs in its own process (`npm run start:worker`), so a surge of document
 * processing cannot starve the API of event-loop time — the API stays
 * responsive while workers saturate CPU. Scaling the two independently is the
 * whole reason the queue exists.
 */
@Processor(INGESTION_QUEUE, {
  concurrency: Number.parseInt(process.env.INGESTION_CONCURRENCY ?? '5', 10),
})
export class IngestionProcessor extends WorkerHost {
  private readonly logger = new Logger(IngestionProcessor.name);
  private readonly maxAttempts: number;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly extraction: ExtractionService,
    private readonly compliance: ComplianceService,
    config: ConfigService,
  ) {
    super();
    this.maxAttempts = config.get<number>('queue.maxAttempts', 5);
  }

  async process(job: Job<IngestionJobPayload>): Promise<{ textLength: number; confidence: number }> {
    const startedAt = Date.now();
    const payload = job.data;
    // Key job bookkeeping on the job id, not the version. The schema allows
    // several job rows per version (uniqueness is on queue_name + job_key), so
    // keying on versionId would update every attempt ever recorded for it.
    const jobKey = job.id!;

    await this.markJobState(jobKey, {
      state: IngestionJobState.Active,
      attempt: job.attemptsMade + 1,
      startedAt: new Date(),
    });
    await this.setLifecycle(payload.versionId, DocumentLifecycle.Processing);

    try {
      const result = await this.extraction.extract({
        versionId: payload.versionId,
        storageKey: payload.storageKey,
        mimeType: payload.mimeType,
        documentTypeCode: payload.documentTypeCode,
      });

      // An unreadable file is a terminal outcome, not a transient fault.
      // Retrying it four more times burns the queue on a document that will
      // never parse, so it is quarantined and taken out of the retry loop.
      if (result.textLength === 0 && payload.mimeType === 'application/pdf') {
        await this.quarantine(
          payload.versionId,
          'No extractable text. The document is likely a scan and needs OCR.',
        );
        throw new UnrecoverableError('Document yielded no extractable text');
      }

      await this.finishSuccessfully(payload, jobKey, startedAt);

      // The audit runs after every ingestion so the tender's compliance state
      // is never stale with respect to its documents.
      await this.compliance.auditTender({
        organizationId: payload.organizationId,
        tenderId: payload.tenderId,
        trigger: 'document_ingested',
      });

      return { textLength: result.textLength, confidence: result.confidence };
    } catch (error) {
      await this.recordFailure(payload, jobKey, job, error, startedAt);
      throw error;
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<IngestionJobPayload>, error: Error): void {
    const exhausted = job.attemptsMade >= this.maxAttempts;
    this.logger[exhausted ? 'error' : 'warn'](
      { versionId: job.data?.versionId, attempt: job.attemptsMade, err: error.message },
      exhausted ? 'Ingestion job moved to dead letter' : 'Ingestion attempt failed; will retry',
    );
  }

  // ---------------------------------------------------------------------------

  private async finishSuccessfully(
    payload: IngestionJobPayload,
    jobKey: string,
    startedAt: number,
  ): Promise<void> {
    const finishedAt = new Date();

    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(DocumentVersion).update(
        { id: payload.versionId },
        { lifecycle: DocumentLifecycle.Processed, processedAt: finishedAt, failureReason: null },
      );

      await manager.getRepository(IngestionJob).update(
        { jobKey },
        {
          state: IngestionJobState.Completed,
          finishedAt,
          durationMs: Date.now() - startedAt,
          errorClass: null,
          errorMessage: null,
        },
      );

      await manager.getRepository(AuditTrailEntry).insert({
        organizationId: payload.organizationId,
        entityType: 'document_version',
        entityId: payload.versionId,
        action: 'processed',
        actorType: 'worker',
        payload: { durationMs: Date.now() - startedAt },
      });
    });
  }

  private async recordFailure(
    payload: IngestionJobPayload,
    jobKey: string,
    job: Job<IngestionJobPayload>,
    error: unknown,
    startedAt: number,
  ): Promise<void> {
    const exhausted = error instanceof UnrecoverableError || job.attemptsMade + 1 >= this.maxAttempts;
    const message = error instanceof Error ? error.message : String(error);

    await this.dataSource.getRepository(IngestionJob).update(
      { jobKey },
      {
        state: exhausted ? IngestionJobState.DeadLetter : IngestionJobState.Failed,
        attempt: job.attemptsMade + 1,
        finishedAt: new Date(),
        durationMs: Date.now() - startedAt,
        errorClass: error instanceof Error ? error.constructor.name : 'Unknown',
        errorMessage: message.slice(0, 2000),
      },
    );

    if (exhausted) {
      // Do not overwrite `quarantined`. A quarantined document has already been
      // classified with a reason the user can act on ("this is a scan, send a
      // digital copy"); demoting it to the generic `failed` would lose that.
      await this.dataSource
        .getRepository(DocumentVersion)
        .createQueryBuilder()
        .update(DocumentVersion)
        .set({ lifecycle: DocumentLifecycle.Failed, failureReason: message.slice(0, 2000) })
        .where('id = :id', { id: payload.versionId })
        .andWhere('lifecycle != :quarantined', { quarantined: DocumentLifecycle.Quarantined })
        .execute();
    }
  }

  private async quarantine(versionId: string, reason: string): Promise<void> {
    await this.dataSource
      .getRepository(DocumentVersion)
      .update({ id: versionId }, { lifecycle: DocumentLifecycle.Quarantined, failureReason: reason });
  }

  private async setLifecycle(versionId: string, lifecycle: DocumentLifecycle): Promise<void> {
    await this.dataSource.getRepository(DocumentVersion).update({ id: versionId }, { lifecycle });
  }

  private async markJobState(jobKey: string, patch: Partial<IngestionJob>): Promise<void> {
    await this.dataSource.getRepository(IngestionJob).update({ jobKey }, patch);
  }
}
