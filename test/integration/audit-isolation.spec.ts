import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { buildPdf } from '../helpers/pdf-fixture';
import { ComplianceService } from '../../src/modules/compliance/compliance.service';

/**
 * A failing compliance audit must not damage a successful ingestion.
 *
 * The audit used to run inside the ingestion job's try/catch. An audit that
 * threw was caught by the ingestion handler, which marked the *document*
 * failed and had BullMQ retry the extraction — retrying a file parse to fix a
 * compliance-engine problem, and blaming a document that was read perfectly.
 *
 * The audit now runs on its own queue, so the isolation is structural rather
 * than a matter of where a catch block happens to sit. This suite holds that
 * property down: the compliance service is replaced with one that always
 * throws, and the ingestion outcome is checked for damage.
 */
const describeIfServices =
  process.env.DATABASE_URL && process.env.REDIS_URL ? describe : describe.skip;

describeIfServices('compliance audit failure isolation', () => {
  let app: INestApplication;
  let workerRef: TestingModule;
  let dataSource: DataSource;

  const orgId = randomUUID();
  const runId = randomUUID();
  const storageRoot = `/tmp/vantedge-audit-iso-${runId}`;
  let tenderId: string;
  let auditAttempts = 0;

  beforeAll(async () => {
    process.env.STORAGE_DRIVER = 'local';
    process.env.STORAGE_LOCAL_ROOT = storageRoot;
    process.env.INGESTION_RECONCILE_INTERVAL_MS = '0';
    process.env.AUDIT_DEBOUNCE_MS = '200';
    // One attempt, so the job reaches a terminal failed state quickly instead
    // of backing off for a quarter of a minute.
    process.env.AUDIT_MAX_ATTEMPTS = '1';

    const { AppModule } = await import('../../src/app.module');
    const { WorkerModule } = await import('../../src/worker.module');

    const apiRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = apiRef.createNestApplication({ logger: false });
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.init();
    dataSource = app.get(DataSource);

    await dataSource.query(
      `INSERT INTO organizations (id, slug, name, npwp)
       VALUES ($1, $2, 'PT Karya Bali Mandiri', '012345678901234')`,
      [orgId, `audit-iso-${runId.slice(0, 8)}`],
    );
    tenderId = randomUUID();
    await dataSource.query(
      `INSERT INTO tenders
         (id, organization_id, tender_code, title, buyer_name, required_sbu_codes,
          estimated_value, submission_deadline, status)
       VALUES ($1, $2, $3, 'Pembangunan Gedung', 'Dinas PU', ARRAY['BG009'],
               15000000000.00, $4, 'preparing')`,
      [tenderId, orgId, `LPSE-AI-${runId.slice(0, 8)}`, new Date(Date.now() + 45 * 86_400_000).toISOString()],
    );
    await dataSource.query(
      `INSERT INTO tender_documents (organization_id, tender_id, document_type_code, title, is_mandatory)
       SELECT $1, $2, code, name, true FROM document_types WHERE is_mandatory_default`,
      [orgId, tenderId],
    );

    // Only the worker's compliance service is broken. The API keeps a real one,
    // which is what lets the last test show the tender is still auditable.
    workerRef = await Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(ComplianceService)
      .useValue({
        auditTender: () => {
          auditAttempts += 1;
          return Promise.reject(new Error('compliance engine exploded'));
        },
      })
      .compile();
    workerRef.useLogger(false);
    await workerRef.init();
  }, 90_000);

  afterAll(async () => {
    await workerRef?.close();
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM organizations WHERE id = $1', [orgId]);
    }
    await app?.close();
    await rm(storageRoot, { recursive: true, force: true });
  }, 30_000);

  it('leaves the document processed and the ingestion job completed', async () => {
    const response = await request(app.getHttpServer())
      .post(`/v1/tenders/${tenderId}/documents`)
      .set('X-Organization-Id', orgId)
      .field('documentTypeCode', 'SBU')
      .attach(
        'file',
        buildPdf([
          'SERTIFIKAT BADAN USAHA',
          `Nomor : ISO-${runId.slice(0, 8)}`,
          'Diberikan kepada : PT Karya Bali Mandiri',
          'Klasifikasi : BG009',
          'Berlaku sampai dengan 14 Maret 2029',
        ]),
        { filename: 'sbu.pdf', contentType: 'application/pdf' },
      )
      .expect(202);

    const versionId: string = response.body.versionId;

    await waitUntil(async () => {
      const [row] = await dataSource.query(
        'SELECT lifecycle FROM document_versions WHERE id = $1',
        [versionId],
      );
      return row?.lifecycle === 'processed';
    }, 'document never reached processed');

    // Give the audit job its chance to run and fail.
    await waitUntil(async () => auditAttempts > 0, 'audit was never attempted');
    await new Promise((resolve) => setTimeout(resolve, 500));

    const [version] = await dataSource.query(
      'SELECT lifecycle, failure_reason, processed_at FROM document_versions WHERE id = $1',
      [versionId],
    );
    const [job] = await dataSource.query(
      'SELECT state, error_message FROM ingestion_jobs WHERE version_id = $1',
      [versionId],
    );

    expect(version.lifecycle).toBe('processed');
    expect(version.failure_reason).toBeNull();
    expect(version.processed_at).not.toBeNull();
    expect(job.state).toBe('completed');
    expect(job.error_message).toBeNull();
  }, 60_000);

  it('does not retry the extraction because the audit failed', async () => {
    const [job] = await dataSource.query(
      `SELECT j.attempt FROM ingestion_jobs j
         JOIN document_versions v ON v.id = j.version_id
        WHERE v.organization_id = $1`,
      [orgId],
    );
    // One attempt: the ingestion job succeeded and was never re-queued, even
    // though the audit it triggered blew up.
    expect(job.attempt).toBe(1);
  });

  it('surfaces the audit failure rather than swallowing it', async () => {
    // Observable two ways: the stub recorded the attempt, and the job is on the
    // audit queue's failed set rather than quietly gone.
    expect(auditAttempts).toBeGreaterThan(0);

    const { ComplianceQueueService } = await import(
      '../../src/modules/compliance/compliance.queue'
    );
    const queue = workerRef.get(ComplianceQueueService, { strict: false });

    // Audit job ids are per run (`audit-<tenderId>-<uuid>`), so the tender id
    // alone names no job: looking it up returns null whether or not anything
    // failed, which is why an earlier version of this assertion could not fail.
    // Find the real job on the queue's failed set instead.
    const bull = (
      queue as unknown as {
        queue: { getJobs(types: string[]): Promise<Array<{ id?: string }>> };
      }
    ).queue;
    const failed = (await bull.getJobs(['failed'])).filter((job) => job.id?.includes(tenderId));
    expect(failed.length).toBeGreaterThan(0);
    expect(await queue.getJobState(failed[0].id as string)).toBe('failed');
  });

  it('can still audit the tender successfully afterwards', async () => {
    // The API's compliance service was never broken, so a manual audit proves
    // the failure was confined to the worker's attempt.
    const audit = await request(app.getHttpServer())
      .post(`/v1/tenders/${tenderId}/compliance-audits`)
      .set('X-Organization-Id', orgId)
      .expect(201);

    expect(audit.body.status).toBe('completed');
    expect(audit.body.verdict).toBeDefined();

    const sbuFindings = audit.body.findings.filter((f: { message: string }) =>
      f.message.includes('Sertifikat Badan Usaha'),
    );
    expect(sbuFindings.length).toBeGreaterThan(0);
    expect(sbuFindings.some((f: { status: string }) => f.status === 'pass')).toBe(true);
  }, 30_000);
});

async function waitUntil(
  predicate: () => Promise<boolean>,
  message: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
