import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  COMPLIANCE_AUDIT_QUEUE,
  ComplianceAuditJobPayload,
} from '../ingestion/ingestion.constants';
import { ComplianceService } from './compliance.service';
import { ComplianceQueueService } from './compliance.queue';

/**
 * Runs tender audits off the ingestion path.
 *
 * Nothing here can mark a document failed. An audit that throws fails its own
 * job, retries on its own schedule and is recorded as a failed
 * `compliance_audits` row — the document that triggered it stays `processed`,
 * because that is what the extraction actually determined.
 */
@Processor(COMPLIANCE_AUDIT_QUEUE, { concurrency: 2 })
export class ComplianceAuditProcessor extends WorkerHost {
  private readonly logger = new Logger(ComplianceAuditProcessor.name);

  constructor(
    private readonly compliance: ComplianceService,
    private readonly queue: ComplianceQueueService,
  ) {
    super();
  }

  async process(job: Job<ComplianceAuditJobPayload>): Promise<{ auditId: string }> {
    const { organizationId, tenderId } = job.data;

    // Take the outstanding intent *before* reading any documents. Everything
    // this run will cover is already committed; anything that sets the flag
    // again from here on is work this run cannot have seen.
    await this.queue.claimPending(tenderId);

    const audit = await this.compliance.auditTender({
      organizationId,
      tenderId,
      trigger: 'document_ingested',
    });

    // Release the tender's job slot and learn, atomically, whether a request
    // arrived while this audit ran. Such a request did not schedule anything —
    // the slot was occupied — so this run schedules its follow-up now that it
    // is over. The follow-up therefore starts strictly after this audit ended.
    if (job.id && (await this.queue.finishRun(tenderId, job.id)).followUpOwed) {
      this.logger.log(
        { tenderId },
        'Another audit was requested while this one ran; scheduling a follow-up',
      );
      await this.queue.schedule({ organizationId, tenderId });
    }

    return { auditId: audit.id };
  }

  /**
   * A run that fails has already taken the intent. Put it back, or the request
   * that triggered it would be lost even though nothing audited the tender.
   *
   * Only when the failure is final. BullMQ emits `failed` for every attempt,
   * including ones it will retry; the retrying job still carries the slot and
   * will re-take the intent when it runs, so restoring here would free the slot
   * under a job that is about to run again and invite a duplicate.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<ComplianceAuditJobPayload>, error: Error): Promise<void> {
    const tenderId = job.data?.tenderId;
    if (!tenderId) return;

    const final = job.attemptsMade >= (job.opts?.attempts ?? 1);
    this.logger.error(
      { tenderId, attempt: job.attemptsMade, final, err: error.message },
      final
        ? 'Compliance audit job failed for good; restoring the pending request'
        : 'Compliance audit attempt failed; will retry',
    );
    if (final) await this.queue.restorePending(tenderId, job.id);
  }
}
