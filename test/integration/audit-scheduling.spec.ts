import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { ComplianceQueueService } from '../../src/modules/compliance/compliance.queue';

/**
 * Durable audit intent.
 *
 * Audits were coalesced by reusing one BullMQ job id per tender, which looked
 * like free de-duplication and hid two defects. Both are checked here directly
 * against the queue and the state table, because both only appear in states
 * that an end-to-end upload test cannot reliably reach:
 *
 * - A request arriving while an audit is **active** resolved to the running job
 *   and was dropped. BullMQ returns the existing job rather than queueing
 *   another, so the document that triggered it was never audited.
 * - A **failed** job was retained under that id for a week, and the tender
 *   could not be audited again for as long as it sat there.
 */
const describeIfServices =
  process.env.DATABASE_URL && process.env.REDIS_URL ? describe : describe.skip;

describeIfServices('compliance audit scheduling', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let queue: ComplianceQueueService;

  const orgId = randomUUID();
  const runId = randomUUID();
  let tenderId: string;

  const state = async () => {
    const [row] = await dataSource.query(
      'SELECT pending, scheduled_job_id FROM tender_audit_state WHERE tender_id = $1',
      [tenderId],
    );
    return row;
  };

  /**
   * Scheduled jobs for *this* tender only.
   *
   * The queue is shared with every other suite in this run, so a whole-queue
   * count would be measuring their leftovers as much as this suite's work.
   */
  const scheduledForTender = async (): Promise<number> => {
    const bull = (
      queue as unknown as {
        queue: { getJobs(types: string[], start: number, end: number): Promise<Array<{ id?: string }>> };
      }
    ).queue;
    const jobs = await bull.getJobs(['waiting', 'delayed', 'prioritized', 'active'], 0, 500);
    // Distinct ids: a job moving from delayed to waiting can appear in both
    // lists for an instant, and counting rows rather than jobs would read that
    // as two scheduled runs.
    const ids = jobs.map((job) => job.id).filter((id): id is string => Boolean(id?.includes(tenderId)));
    return new Set(ids).size;
  };

  beforeAll(async () => {
    process.env.STORAGE_DRIVER = 'local';
    process.env.INGESTION_RECONCILE_INTERVAL_MS = '0';
    process.env.AUDIT_DEBOUNCE_MS = '50';

    const { AppModule } = await import('../../src/app.module');
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();

    dataSource = moduleRef.get(DataSource);
    queue = moduleRef.get(ComplianceQueueService, { strict: false });

    await dataSource.query(
      `INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'PT Karya Bali Mandiri')`,
      [orgId, `sched-${runId.slice(0, 8)}`],
    );
    tenderId = randomUUID();
    await dataSource.query(
      `INSERT INTO tenders (id, organization_id, tender_code, title, buyer_name, status)
       VALUES ($1, $2, $3, 'Pembangunan Gedung', 'Dinas PU', 'preparing')`,
      [tenderId, orgId, `LPSE-S-${runId.slice(0, 8)}`],
    );
  }, 60_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM organizations WHERE id = $1', [orgId]);
    }
    await moduleRef?.close();
  }, 30_000);

  /**
   * Each test owns its starting state; none depends on the previous one.
   *
   * Both halves matter. Clearing only the table leaves the previous test's job
   * sitting on the queue under this tender's id, and the next test's count then
   * measures that leftover as well as its own work — which is how a correct
   * implementation gets reported as leaking a second run.
   */
  const reset = async () => {
    await dataSource.query('DELETE FROM tender_audit_state WHERE tender_id = $1', [tenderId]);

    const bull = (
      queue as unknown as {
        queue: {
          getJobs(types: string[], start: number, end: number): Promise<Array<{ id?: string; remove(): Promise<void> }>>;
        };
      }
    ).queue;
    const jobs = await bull.getJobs(['waiting', 'delayed', 'prioritized'], 0, 500);
    await Promise.all(jobs.filter((job) => job.id?.includes(tenderId)).map((job) => job.remove()));
  };

  it('coalesces several requests that arrive before the audit starts', async () => {
    await reset();

    await Promise.all(
      Array.from({ length: 5 }, () => queue.requestAudit({ organizationId: orgId, tenderId })),
    );

    // Five requests, one scheduled run. The audit evaluates the tender's state
    // when it runs, so the survivor covers what the others would have.
    expect(await scheduledForTender()).toBe(1);
    expect((await state()).pending).toBe(true);
  });

  /**
   * The previous test goes through `requestAudit`, and under these timings its
   * own pre-check — "is something already scheduled?" — wins the race before
   * `schedule()` is ever contended. That makes it a poor witness for the claim
   * inside `schedule()`: reverting that claim to a naive length check leaves
   * the test green.
   *
   * So race `schedule()` directly, with no pre-check in front of it. This is
   * the layer that must hold on its own, because the reconciler and the
   * processor's follow-up both call it without going through `requestAudit`.
   *
   * It is also the test that catches the subtlest bug in this area. TypeORM
   * returns `[rows, count]` for `UPDATE … RETURNING`, so `result.length === 0`
   * is *always* false — the tuple has length 2 whether or not a row was
   * touched. Every loser reads itself as the winner and publishes.
   */
  it('lets exactly one of several concurrent schedule calls publish', async () => {
    await reset();
    await dataSource.query(
      `INSERT INTO tender_audit_state (tender_id, organization_id, pending) VALUES ($1, $2, true)`,
      [tenderId, orgId],
    );

    const ids = await Promise.all(
      Array.from({ length: 5 }, () => queue.schedule({ organizationId: orgId, tenderId })),
    );

    // All five callers are told the same job id — the one that was claimed.
    expect(new Set(ids).size).toBe(1);
    // And only that one job exists on the queue.
    expect(await scheduledForTender()).toBe(1);
    expect((await state()).scheduled_job_id).toBe(ids[0]);
  });

  it('keeps the intent when a request arrives while an audit is active', async () => {
    await reset();
    await queue.requestAudit({ organizationId: orgId, tenderId });

    // A run starts: it takes the outstanding intent.
    await queue.claimPending(tenderId);
    expect((await state()).pending).toBe(false);

    // A document finishes while that run is still going. The old design
    // dropped this request, because its job id matched the running job and
    // BullMQ returned that job instead of queueing another.
    await queue.requestAudit({ organizationId: orgId, tenderId });

    // The intent survives in the database whatever the broker did with it.
    expect((await state()).pending).toBe(true);
  });

  it('schedules a follow-up run under a fresh job id', async () => {
    await reset();
    await queue.requestAudit({ organizationId: orgId, tenderId });
    const first = (await state()).scheduled_job_id;
    expect(first).not.toBeNull();

    // The run finishes and finds the flag set again.
    await queue.claimPending(tenderId);
    await queue.restorePending(tenderId);

    const followUp = await queue.schedule({ organizationId: orgId, tenderId });

    expect(followUp).not.toBe(first);
    expect(followUp).toContain(tenderId);
    expect((await state()).scheduled_job_id).toBe(followUp);
  });

  it('is not blocked by a job retained under the previous id', async () => {
    await reset();
    await queue.requestAudit({ organizationId: orgId, tenderId });
    const stale = (await state()).scheduled_job_id;

    // The old design reused one id per tender, so a retained failed job held
    // that name for a week and locked the tender out of auditing. Ids are now
    // minted per run, and the previous job may sit in Redis as long as it likes.
    await queue.claimPending(tenderId);
    await queue.restorePending(tenderId);
    await queue.requestAudit({ organizationId: orgId, tenderId });

    const after = await state();
    expect(after.scheduled_job_id).not.toBe(stale);
    expect(after.scheduled_job_id).not.toBeNull();
  });

  it('survives a restart: the reconciler reschedules owed audits', async () => {
    await reset();
    await queue.requestAudit({ organizationId: orgId, tenderId });

    // Intent recorded, nothing carrying it — what a worker crash leaves.
    await dataSource.query(
      `UPDATE tender_audit_state
          SET pending = true, scheduled_job_id = NULL, requested_at = now() - interval '1 hour'
        WHERE tender_id = $1`,
      [tenderId],
    );

    const { IngestionReconciler } = await import(
      '../../src/modules/ingestion/ingestion.reconciler'
    );
    const reconciler = moduleRef.get(IngestionReconciler, { strict: false });

    expect(await reconciler.reconcileAudits()).toBeGreaterThan(0);
    expect((await state()).scheduled_job_id).not.toBeNull();
  });

  it('does not reschedule a tender that is owed nothing', async () => {
    await reset();
    await queue.requestAudit({ organizationId: orgId, tenderId });
    await queue.claimPending(tenderId);

    const { IngestionReconciler } = await import(
      '../../src/modules/ingestion/ingestion.reconciler'
    );
    const reconciler = moduleRef.get(IngestionReconciler, { strict: false });

    expect(await reconciler.reconcileAudits()).toBe(0);
  });
});
