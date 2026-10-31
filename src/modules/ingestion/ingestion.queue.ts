import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { AppError } from '../../common/errors/app-error';
import { ErrorCode } from '../../common/errors/error-codes';
import { INGESTION_QUEUE, IngestionJobPayload } from './ingestion.constants';

@Injectable()
export class IngestionQueueService {
  private readonly logger = new Logger(IngestionQueueService.name);
  private readonly maxAttempts: number;

  constructor(
    @InjectQueue(INGESTION_QUEUE) private readonly queue: Queue<IngestionJobPayload>,
    config: ConfigService,
  ) {
    this.maxAttempts = config.get<number>('queue.maxAttempts', 5);
  }

  /**
   * Enqueue one document for processing.
   *
   * The job id is the content checksum, which makes the enqueue idempotent at
   * the broker: a retried request, a duplicated storage event or a double-click
   * all resolve to the same job, and BullMQ silently ignores the second add.
   * Without this, at-least-once delivery upstream becomes duplicated work here.
   */
  async enqueue(payload: IngestionJobPayload, priority: number): Promise<string> {
    // BullMQ reserves ':' in custom ids — it is the Redis key separator.
    const jobId = `ingest-${payload.checksum}`;

    try {
      await this.queue.add('ingest-document', payload, {
        jobId,
        priority,
        attempts: this.maxAttempts,
        // Exponential backoff: a storage blip clears in seconds, a dependency
        // outage needs minutes. Fixed delays either hammer a struggling
        // dependency or waste time on a transient one.
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: { age: 86_400, count: 10_000 },
        // Failures are kept longer: they are the ones a human has to look at.
        removeOnFail: { age: 604_800 },
      });
      return jobId;
    } catch (error) {
      this.logger.error({ err: error, versionId: payload.versionId }, 'Failed to enqueue document');
      throw AppError.internal(
        ErrorCode.QUEUE_UNAVAILABLE,
        'The document was stored but could not be queued for processing.',
        error,
      );
    }
  }

  async getJobState(jobId: string): Promise<string | null> {
    const job = await this.queue.getJob(jobId);
    return job ? job.getState() : null;
  }

  async counts(): Promise<Record<string, number>> {
    return this.queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused');
  }
}
