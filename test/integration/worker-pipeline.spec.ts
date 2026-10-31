import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { buildPdf } from '../helpers/pdf-fixture';

/**
 * The API and a real worker, running together, under concurrency.
 *
 * This is the suite that ingestion.spec.ts structurally cannot be: that one
 * asserts state immediately after upload and therefore has to assume nothing is
 * consuming the queue. Every defect that lives in the handover between the two
 * processes is invisible to it.
 *
 * The regression this exists for: the API used to publish the queue job before
 * committing the transaction that recorded it. A worker would pick the job up,
 * drive the version to `processed`, update an `ingestion_jobs` row that did not
 * exist yet — matching zero rows — and then the API's transaction would commit
 * and overwrite `processed` back to `queued`. A 40-upload burst stranded 24% of
 * documents that way: fully extracted, permanently reporting "queued" to a
 * client that polls forever.
 *
 * Needs DATABASE_URL and REDIS_URL; skipped otherwise.
 */
const describeIfServices = process.env.DATABASE_URL && process.env.REDIS_URL ? describe : describe.skip;

const UPLOADS = 24;
const TERMINAL = ['processed', 'failed', 'quarantined'];

describeIfServices('ingestion pipeline with a live worker', () => {
  let app: INestApplication;
  let worker: { close(): Promise<void> };
  let dataSource: DataSource;

  const orgId = randomUUID();
  const runId = randomUUID();
  let tenderId: string;

  beforeAll(async () => {
    process.env.STORAGE_DRIVER = 'local';
    process.env.STORAGE_LOCAL_ROOT = `/tmp/vantedge-worker-test-${runId}`;
    process.env.INGESTION_CONCURRENCY = '5';

    // Lazy: ConfigModule validates env at module definition time.
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
      [orgId, `worker-${runId.slice(0, 8)}`],
    );

    tenderId = randomUUID();
    await dataSource.query(
      `INSERT INTO tenders
         (id, organization_id, tender_code, title, buyer_name, required_sbu_codes,
          estimated_value, submission_deadline, status)
       VALUES ($1, $2, $3, 'Pembangunan Gedung', 'Dinas PU', ARRAY['BG009'],
               15000000000.00, $4, 'preparing')`,
      [tenderId, orgId, `LPSE-W-${runId.slice(0, 8)}`, new Date(Date.now() + 45 * 86_400_000).toISOString()],
    );
    await dataSource.query(
      `INSERT INTO tender_documents (organization_id, tender_id, document_type_code, title, is_mandatory)
       SELECT $1, $2, code, name, true FROM document_types WHERE is_mandatory_default`,
      [orgId, tenderId],
    );

    // Start consuming only once the API is ready, so the race window under
    // test is the real one rather than an artefact of boot ordering.
    // A TestingModule is itself an application context; init() fires the
    // lifecycle hooks that start the BullMQ consumer.
    const workerRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    workerRef.useLogger(false);
    worker = await workerRef.init();
  }, 90_000);

  afterAll(async () => {
    await worker?.close();
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM organizations WHERE id = $1', [orgId]);
    }
    await app?.close();
  }, 30_000);

  it('drives every concurrently uploaded document to a terminal, self-consistent state', async () => {
    const uploads = Array.from({ length: UPLOADS }, (_, index) =>
      request(app.getHttpServer())
        .post(`/v1/tenders/${tenderId}/documents`)
        .set('X-Organization-Id', orgId)
        .field('documentTypeCode', 'SKK_PERSONIL')
        .attach(
          'file',
          buildPdf([
            'SERTIFIKAT KOMPETENSI KERJA',
            `Nomor : BURST-${runId.slice(0, 8)}-${index}`,
            'Diberikan kepada : PT Karya Bali Mandiri',
            'Berlaku sampai dengan 14 Maret 2029',
          ]),
          { filename: `skk-${index}.pdf`, contentType: 'application/pdf' },
        ),
    );

    const responses = await Promise.all(uploads);
    expect(responses.every((r) => r.status === 202)).toBe(true);
    const versionIds: string[] = responses.map((r) => r.body.versionId);

    await waitForTerminal(dataSource, versionIds);

    const rows = await dataSource.query(
      `SELECT v.id, v.lifecycle, v.processed_at, j.state AS job_state, j.finished_at,
              (e.id IS NOT NULL) AS has_extraction
         FROM document_versions v
         LEFT JOIN ingestion_jobs j ON j.version_id = v.id
         LEFT JOIN document_extractions e ON e.version_id = v.id
        WHERE v.id = ANY($1)`,
      [versionIds],
    );

    expect(rows).toHaveLength(UPLOADS);

    // The exact corruption that was happening: extracted, but the lifecycle
    // still says it is waiting to be picked up.
    const strandedVersions = rows.filter(
      (r: Record<string, unknown>) => r.has_extraction === true && !TERMINAL.includes(r.lifecycle as string),
    );
    expect(strandedVersions).toEqual([]);

    // And the job ledger agrees with the documents it describes.
    const strandedJobs = rows.filter(
      (r: Record<string, unknown>) => r.lifecycle === 'processed' && r.job_state !== 'completed',
    );
    expect(strandedJobs).toEqual([]);

    for (const row of rows) {
      expect(TERMINAL).toContain(row.lifecycle);
      if (row.lifecycle === 'processed') {
        expect(row.processed_at).not.toBeNull();
        expect(row.finished_at).not.toBeNull();
        expect(row.has_extraction).toBe(true);
      }
    }
  }, 120_000);

  it('records exactly one job row per upload', async () => {
    // Keying job bookkeeping on the version rather than the job id used to
    // make every attempt for a version share one row's worth of updates.
    const [{ versions, jobs }] = await dataSource.query(
      `SELECT count(DISTINCT v.id)::int AS versions, count(j.id)::int AS jobs
         FROM document_versions v
         JOIN ingestion_jobs j ON j.version_id = v.id
        WHERE v.organization_id = $1`,
      [orgId],
    );
    expect(jobs).toBe(versions);
  });

  it('leaves the tender auditable once ingestion settles', async () => {
    const audit = await request(app.getHttpServer())
      .post(`/v1/tenders/${tenderId}/compliance-audits`)
      .set('X-Organization-Id', orgId)
      .expect(201);

    // No finding may claim a document is still being processed: everything
    // reached a terminal state before this ran.
    const stillProcessing = audit.body.findings.filter((f: { message: string }) =>
      f.message.includes('still being processed'),
    );
    expect(stillProcessing).toEqual([]);
  }, 30_000);
});

async function waitForTerminal(
  dataSource: DataSource,
  versionIds: string[],
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const [{ pending }] = await dataSource.query(
      `SELECT count(*)::int AS pending FROM document_versions
        WHERE id = ANY($1) AND lifecycle NOT IN ('processed', 'failed', 'quarantined')`,
      [versionIds],
    );
    if (pending === 0) return;

    if (Date.now() > deadline) {
      // Report what is stuck: a timeout here is the defect, not flakiness.
      const stuck = await dataSource.query(
        `SELECT lifecycle, count(*)::int FROM document_versions
          WHERE id = ANY($1) AND lifecycle NOT IN ('processed', 'failed', 'quarantined')
          GROUP BY 1`,
        [versionIds],
      );
      throw new Error(`Documents never reached a terminal state: ${JSON.stringify(stuck)}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
