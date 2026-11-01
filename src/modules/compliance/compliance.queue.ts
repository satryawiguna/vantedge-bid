import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource, EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { returningRows } from '../../database/returning-rows';
import {
  COMPLIANCE_AUDIT_QUEUE,
  ComplianceAuditJobPayload,
} from '../ingestion/ingestion.constants';

/**
 * Durable per-tender audit intent, scheduled through BullMQ.
 *
 * The split matters: `tender_audit_state` records that an audit is *owed*, and
 * the queue records that one is *scheduled*. Earlier this relied on the queue
 * alone, with one deterministic job id per tender, which fails in two ways that
 * only show up under load:
 *
 * - A request arriving while an audit was **active** resolved to the running
 *   job and was silently dropped — BullMQ returns the existing job rather than
 *   queueing another — so the document that triggered it was never audited.
 * - A **failed** job was retained for a week under that same id, and the tender
 *   could not be audited again for as long as it sat there.
 *
 * Giving each run its own job id removes both. Coalescing then comes from the
 * `pending` flag and the recorded `scheduled_job_id` rather than from id
 * collisions.
 */
@Injectable()
export class ComplianceQueueService {
  private readonly logger = new Logger(ComplianceQueueService.name);
  private readonly debounceMs: number;
  private readonly maxAttempts: number;

  constructor(
    @InjectQueue(COMPLIANCE_AUDIT_QUEUE)
    private readonly queue: Queue<ComplianceAuditJobPayload>,
    @InjectDataSource() private readonly dataSource: DataSource,
    config: ConfigService,
  ) {
    this.debounceMs = config.get<number>('queue.auditDebounceMs', 3_000);
    this.maxAttempts = config.get<number>('queue.auditMaxAttempts', 3);
  }

  /**
   * Record that this tender is owed an audit, and schedule one if nothing is
   * already waiting to run.
   *
   * Requests that arrive while a job is still waiting collapse onto it: the
   * audit evaluates the tender's state when it finally runs, so the survivor
   * sees everything the dropped requests would have.
   *
   * Requests that arrive while a job is *active* are not scheduled at all. The
   * run keeps `scheduled_job_id` for as long as it is running, so this method
   * sees the slot as taken; the request only leaves `pending` set, and
   * `finishRun` hands that to the processor, which schedules one follow-up when
   * the active run ends. A tender therefore never has two audits running at
   * once, and the follow-up is guaranteed to start after the active one ended.
   */
  async requestAudit(payload: ComplianceAuditJobPayload, delayMs = this.debounceMs): Promise<void> {
    const { organizationId, tenderId } = payload;

    try {
      const [state] = await this.dataSource.query<Array<{ scheduled_job_id: string | null }>>(
        `INSERT INTO tender_audit_state (tender_id, organization_id, pending, requested_at)
              VALUES ($1, $2, true, now())
         ON CONFLICT (tender_id) DO UPDATE
                 SET pending = true, requested_at = now()
           RETURNING scheduled_job_id`,
        [tenderId, organizationId],
      );

      if (state?.scheduled_job_id) {
        // Something is already scheduled, or running. A scheduled job will pick
        // up the intent we just recorded; a running one will find it in
        // `finishRun` and schedule the follow-up.
        if (await this.isJobLive(state.scheduled_job_id)) return;

        // Recorded but no longer live — it failed terminally, or was lost. Clear
        // it conditionally so only one caller moves the slot back to free.
        await this.dataSource.query(
          `UPDATE tender_audit_state SET scheduled_job_id = NULL
            WHERE tender_id = $1 AND scheduled_job_id = $2`,
          [tenderId, state.scheduled_job_id],
        );
      }

      await this.schedule(payload, delayMs);
    } catch (error) {
      // An audit that cannot be scheduled must not fail the ingestion that
      // asked for it. The intent is durable, so the reconciler will pick it up.
      this.logger.error(
        { err: error, tenderId },
        'Could not schedule a compliance audit; intent remains recorded',
      );
    }
  }

  /**
   * Publish a run and record which job carries it.
   *
   * The id is unique per run, so a retained failed job can never occupy the
   * name the next run needs.
   */
  async schedule(payload: ComplianceAuditJobPayload, delayMs = this.debounceMs): Promise<string> {
    const jobId = `audit-${payload.tenderId}-${randomUUID()}`;

    // Claim the right to schedule before publishing. Several ingestions
    // finishing together all reach this point, and without the conditional
    // UPDATE they would each read a null `scheduled_job_id` and each publish a
    // job — the de-duplication the state table exists for, lost to a race.
    // Exactly one caller moves the column from NULL, and only that one adds.
    const claimed = returningRows<{ scheduled_job_id: string }>(
      await this.dataSource.query(
        `UPDATE tender_audit_state SET scheduled_job_id = $2
          WHERE tender_id = $1 AND scheduled_job_id IS NULL
      RETURNING scheduled_job_id`,
        [payload.tenderId, jobId],
      ),
    );

    if (claimed.length === 0) {
      const [current] = await this.dataSource.query<Array<{ scheduled_job_id: string | null }>>(
        'SELECT scheduled_job_id FROM tender_audit_state WHERE tender_id = $1',
        [payload.tenderId],
      );
      return current?.scheduled_job_id ?? jobId;
    }

    await this.publish(payload, jobId, delayMs);
    return jobId;
  }

  /** Publish a job under an id already claimed in `tender_audit_state`. */
  async publish(
    payload: ComplianceAuditJobPayload,
    jobId: string,
    delayMs = this.debounceMs,
  ): Promise<void> {
    await this.queue.add('audit-tender', payload, {
      jobId,
      delay: delayMs,
      attempts: this.maxAttempts,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: true,
      removeOnFail: { age: 604_800 },
    });
  }

  /** The id this tender currently has scheduled, if any. */
  async scheduledJobId(tenderId: string): Promise<string | null> {
    const [row] = await this.dataSource.query<Array<{ scheduled_job_id: string | null }>>(
      'SELECT scheduled_job_id FROM tender_audit_state WHERE tender_id = $1',
      [tenderId],
    );
    return row?.scheduled_job_id ?? null;
  }

  /**
   * Take the outstanding intent for a run that is starting.
   *
   * Clearing `pending` here, before the audit reads any documents, is what
   * makes "a document landed while the audit was running" detectable: anything
   * that sets the flag again after this point is work this run will not cover.
   *
   * `scheduled_job_id` is deliberately left in place. It marks the tender as
   * having a run in flight, which is what stops a request arriving mid-audit
   * from scheduling a second audit alongside this one.
   */
  async claimPending(tenderId: string, manager?: EntityManager): Promise<void> {
    const runner = manager ?? this.dataSource;
    await runner.query(
      `UPDATE tender_audit_state
          SET pending = false, last_audited_at = now()
        WHERE tender_id = $1`,
      [tenderId],
    );
  }

  /**
   * End a run: free the tender's job slot and report whether more is owed.
   *
   * One statement, so the release and the read of `pending` are atomic against
   * `requestAudit`'s upsert (both take the row lock). A request ordered before
   * this statement is seen here and becomes the follow-up; one ordered after it
   * finds the slot free and schedules for itself. There is no gap in which a
   * request sees an active run, returns, and is then missed.
   *
   * Conditional on the slot still naming this job. If it names another (the
   * reconciler replaced it), that job carries the intent and this run has
   * nothing to release or schedule.
   */
  async finishRun(tenderId: string, jobId: string): Promise<{ followUpOwed: boolean }> {
    const rows = returningRows<{ pending: boolean }>(
      await this.dataSource.query(
        `UPDATE tender_audit_state SET scheduled_job_id = NULL
          WHERE tender_id = $1 AND scheduled_job_id = $2
      RETURNING pending`,
        [tenderId, jobId],
      ),
    );
    return { followUpOwed: rows[0]?.pending === true };
  }

  /**
   * Put the intent back after a run failed for good, and free its slot, so the
   * request that triggered it is not forgotten. The reconciler (or the next
   * request) schedules the retry under a fresh job id.
   */
  async restorePending(tenderId: string, jobId?: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE tender_audit_state
          SET pending = true,
              requested_at = now(),
              scheduled_job_id = CASE WHEN $2::text IS NULL OR scheduled_job_id = $2
                                      THEN NULL ELSE scheduled_job_id END
        WHERE tender_id = $1`,
      [tenderId, jobId ?? null],
    );
  }

  async getJobState(jobId: string): Promise<string | null> {
    const job = await this.queue.getJob(jobId);
    return job ? job.getState() : null;
  }

  /**
   * Scheduled (waiting, delayed) or running (active): the slot is genuinely
   * occupied. Anything else — failed, completed, absent — is a slot held by a
   * job that will never release it.
   */
  private async isJobLive(jobId: string): Promise<boolean> {
    const state = await this.getJobState(jobId);
    return (
      state === 'waiting' ||
      state === 'delayed' ||
      state === 'prioritized' ||
      state === 'active' ||
      state === 'waiting-children'
    );
  }
}
