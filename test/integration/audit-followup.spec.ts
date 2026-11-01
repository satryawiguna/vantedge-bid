import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { rm } from 'node:fs/promises';
import { buildPdf } from '../helpers/pdf-fixture';
import { seedOrganization, seedTender, waitUntil } from '../helpers/seed';
import { DocumentsService } from '../../src/modules/documents/documents.service';
import { ComplianceService } from '../../src/modules/compliance/compliance.service';
import { ComplianceQueueService } from '../../src/modules/compliance/compliance.queue';
import { IngestionReconciler } from '../../src/modules/ingestion/ingestion.reconciler';

/**
 * Audit follow-up, end to end, through the real processors.
 *
 * Nothing here calls claimPending/restorePending/schedule to stage a state. The
 * only things done by hand are the two controlled delays (a gate inside the
 * audit, a throw inside the audit) — both wrap the real ComplianceService, so
 * the processor, the queue service, the state table and BullMQ all run for real.
 */
const describeIfServices =
  process.env.DATABASE_URL && process.env.REDIS_URL ? describe : describe.skip;

describeIfServices('compliance audit follow-up', () => {
  let apiRef: TestingModule;
  let workerRef: TestingModule;
  let dataSource: DataSource;
  let documents: DocumentsService;
  let compliance: ComplianceService;
  let auditQueue: ComplianceQueueService;

  const storageRoot = `/tmp/vantedge-followup-${process.pid}-${Date.now()}`;
  let orgId: string;
  let tenderId: string;

  type Event = { kind: 'start' | 'end'; n: number };
  const events: Event[] = [];
  let calls = 0;
  let gate: Promise<void> | null = null;
  let openGate: () => void = () => undefined;
  let failNext = false;
  const published: string[] = [];

  const pdfOf = (title: string, marker: string, extra: string[] = []) =>
    buildPdf([
      title,
      `Nomor : ${marker}`,
      'Diberikan kepada : PT Karya Bali Mandiri',
      ...extra,
      'Berlaku sampai dengan 14 Maret 2029',
    ]);

  const upload = async (typeCode: string, buffer: Buffer): Promise<string> => {
    const result = await documents.ingest({
      context: { organizationId: orgId, userId: null },
      tenderId,
      dto: { documentTypeCode: typeCode },
      file: {
        buffer,
        size: buffer.byteLength,
        mimetype: 'application/pdf',
        originalname: 'doc.pdf',
      } as Express.Multer.File,
    });
    const versionId = result.body.versionId;
    await waitUntil(async () => {
      const [row] = await dataSource.query('SELECT lifecycle FROM document_versions WHERE id = $1', [
        versionId,
      ]);
      return row.lifecycle === 'processed';
    }, `version ${versionId} never processed`);
    return versionId;
  };

  const audits = () =>
    dataSource.query(
      `SELECT id, status, started_at, completed_at FROM compliance_audits
        WHERE tender_id = $1 ORDER BY created_at`,
      [tenderId],
    ) as Promise<Array<{ id: string; status: string; started_at: Date; completed_at: Date | null }>>;

  const state = async () => {
    const [row] = await dataSource.query(
      'SELECT pending, scheduled_job_id FROM tender_audit_state WHERE tender_id = $1',
      [tenderId],
    );
    return row as { pending: boolean; scheduled_job_id: string | null } | undefined;
  };

  const findingsFor = async (auditId: string, versionId: string): Promise<number> => {
    const [row] = await dataSource.query(
      'SELECT count(*)::int AS n FROM compliance_findings WHERE audit_id = $1 AND version_id = $2',
      [auditId, versionId],
    );
    return row.n;
  };

  const quiet = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  beforeAll(async () => {
    process.env.STORAGE_DRIVER = 'local';
    process.env.STORAGE_LOCAL_ROOT = storageRoot;
    process.env.INGESTION_RECONCILE_INTERVAL_MS = '0';
    process.env.INGESTION_RECONCILE_GRACE_MS = '100';
    process.env.AUDIT_DEBOUNCE_MS = '100';
    process.env.AUDIT_MAX_ATTEMPTS = '1';

    const { AppModule } = await import('../../src/app.module');
    const { WorkerModule } = await import('../../src/worker.module');

    apiRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await apiRef.init();
    dataSource = apiRef.get(DataSource);
    documents = apiRef.get(DocumentsService, { strict: false });

    orgId = await seedOrganization(dataSource, 'followup');
    tenderId = await seedTender(dataSource, orgId, { mandatorySlots: true });

    workerRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    workerRef.useLogger(false);
    await workerRef.init();

    compliance = workerRef.get(ComplianceService, { strict: false });
    auditQueue = workerRef.get(ComplianceQueueService, { strict: false });

    const realAudit = compliance.auditTender.bind(compliance);
    jest.spyOn(compliance, 'auditTender').mockImplementation(async (params) => {
      const n = ++calls;
      events.push({ kind: 'start', n });
      try {
        if (failNext) {
          failNext = false;
          throw new Error('compliance engine exploded');
        }
        const result = await realAudit(params);
        // Hold the job active *after* the audit has read the tender, so its
        // snapshot predates anything processed while it is parked here.
        if (n === 1 && gate) await gate;
        return result;
      } finally {
        events.push({ kind: 'end', n });
      }
    });

    const realPublish = auditQueue.publish.bind(auditQueue);
    jest.spyOn(auditQueue, 'publish').mockImplementation(async (payload, jobId, delay) => {
      published.push(jobId);
      return realPublish(payload, jobId, delay);
    });
  }, 90_000);

  afterAll(async () => {
    // Never leave an audit parked on the gate: closing the worker waits for it.
    openGate();
    await workerRef?.close();
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM organizations WHERE id = $1', [orgId]);
    }
    await apiRef?.close();
    await rm(storageRoot, { recursive: true, force: true });
  }, 30_000);

  it('runs a follow-up audit after the active one finishes, covering the new document', async () => {
    gate = new Promise<void>((resolve) => (openGate = resolve));

    // Document 1 processes, the normal path requests an audit, audit A starts
    // and is held open.
    const sbuVersion = await upload('SBU', pdfOf('SERTIFIKAT BADAN USAHA', 'FU-SBU', ['Klasifikasi : BG009']));
    await waitUntil(async () => events.some((e) => e.kind === 'start' && e.n === 1), 'audit A never started');

    // Document 2 is processed while A is active. Its ingestion requests another
    // audit through the normal application path.
    const nibVersion = await upload('NIB', pdfOf('NOMOR INDUK BERUSAHA', 'FU-NIB'));

    // The intent is recorded durably...
    await waitUntil(async () => (await state())?.pending === true, 'pending intent not recorded');

    // ...and no second audit of this tender runs alongside the active one.
    await quiet(600);
    expect(events.filter((e) => e.kind === 'start')).toHaveLength(1);
    // A's work is recorded; its job is still active. Nothing else has started.
    expect(await audits()).toHaveLength(1);

    openGate();

    // Audit B is scheduled by the processor and runs after A has ended.
    await waitUntil(async () => events.some((e) => e.kind === 'end' && e.n === 2), 'follow-up never ran', 30_000);
    const order = events.map((e) => `${e.kind}${e.n}`);
    expect(order.slice(0, 4)).toEqual(['start1', 'end1', 'start2', 'end2']);

    const history = await audits();
    expect(history).toHaveLength(2);
    const [auditA, auditB] = history;
    expect(auditA.status).toBe('completed');
    expect(auditB.status).toBe('completed');

    // B saw the document that arrived during A; A, which began earlier, did not.
    expect(await findingsFor(auditB.id, nibVersion)).toBeGreaterThan(0);
    expect(await findingsFor(auditA.id, nibVersion)).toBe(0);
    expect(await findingsFor(auditA.id, sbuVersion)).toBeGreaterThan(0);

    // A is history, not overwritten.
    const reread = (await audits())[0];
    expect(reread.id).toBe(auditA.id);
    expect(reread.completed_at).toEqual(auditA.completed_at);

    // With nothing further requested, nothing further runs.
    await quiet(800);
    expect(await audits()).toHaveLength(2);
    expect(events.filter((e) => e.kind === 'start')).toHaveLength(2);
    expect(await state()).toMatchObject({ pending: false, scheduled_job_id: null });
  }, 90_000);

  it('can request an audit again after one failed terminally, by its real job id', async () => {
    const startsBefore = events.filter((e) => e.kind === 'start').length;
    const publishedBefore = published.length;
    failNext = true;

    await upload('SBU', pdfOf('SERTIFIKAT BADAN USAHA', 'FU-SBU-2', ['Klasifikasi : BG009']));

    await waitUntil(async () => published.length > publishedBefore, 'audit never scheduled');
    const failedJobId = published[published.length - 1];
    expect(failedJobId).toContain(tenderId);

    // The job is in BullMQ's failed set — not merely absent.
    await waitUntil(
      async () => (await auditQueue.getJobState(failedJobId)) === 'failed',
      'audit job never reached the failed state',
    );
    expect(events.filter((e) => e.kind === 'start')).toHaveLength(startsBefore + 1);

    // The failure put the intent back, and released the job slot.
    await waitUntil(async () => (await state())?.pending === true, 'intent not restored');
    expect((await state())?.scheduled_job_id).toBeNull();

    // The reconciler reschedules owed work under a new id, while the retained
    // failed job still sits under the old one.
    await quiet(200);
    const reconciler = workerRef.get(IngestionReconciler, { strict: false });
    expect(await reconciler.reconcileAudits()).toBe(1);

    const retryJobId = published[published.length - 1];
    expect(retryJobId).not.toBe(failedJobId);
    expect(await auditQueue.getJobState(failedJobId)).toBe('failed');

    await waitUntil(
      async () => (await audits()).filter((a) => a.status === 'completed').length === 3,
      'retry audit never completed',
    );
    expect(await state()).toMatchObject({ pending: false, scheduled_job_id: null });
  }, 90_000);

  it('is not blocked by a retained failed job when a new document arrives', async () => {
    const publishedBefore = published.length;
    failNext = true;
    await upload('SBU', pdfOf('SERTIFIKAT BADAN USAHA', 'FU-SBU-3', ['Klasifikasi : BG009']));
    await waitUntil(async () => published.length > publishedBefore, 'audit never scheduled');
    const failedJobId = published[published.length - 1];
    await waitUntil(
      async () => (await auditQueue.getJobState(failedJobId)) === 'failed',
      'audit job never reached the failed state',
    );

    const completedBefore = (await audits()).filter((a) => a.status === 'completed').length;

    // A fresh request through the normal path.
    await upload('SBU', pdfOf('SERTIFIKAT BADAN USAHA', 'FU-SBU-4', ['Klasifikasi : BG009']));

    await waitUntil(
      async () =>
        (await audits()).filter((a) => a.status === 'completed').length > completedBefore,
      'a new request was blocked by the retained failed job',
    );
    expect(published[published.length - 1]).not.toBe(failedJobId);
    expect(await auditQueue.getJobState(failedJobId)).toBe('failed');
  }, 90_000);
});
