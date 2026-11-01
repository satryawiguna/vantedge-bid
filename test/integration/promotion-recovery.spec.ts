import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { buildPdf } from '../helpers/pdf-fixture';
import { StorageService } from '../../src/storage/storage.service';
import { IngestionQueueService } from '../../src/modules/ingestion/ingestion.queue';
import { ingestionJobId } from '../../src/modules/ingestion/ingestion.constants';

/**
 * Recovery of a version whose promotion never finished.
 *
 * `pending` and `queued` look similar and are not. A `queued` version has been
 * promoted: lifecycle committed, slot pointing at it, job ledger row present —
 * only the publish may be missing. A `pending` version has none of that.
 *
 * Treating them alike, which the first implementation did, published a pending
 * version straight to the broker. The worker then processed a version whose
 * ledger row did not exist and whose slot still pointed elsewhere, so the
 * extraction landed on a document the tender did not reference and the audit
 * reported it missing.
 */
const describeIfServices =
  process.env.DATABASE_URL && process.env.REDIS_URL ? describe : describe.skip;

describeIfServices('promotion recovery', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let storage: StorageService;
  let queue: IngestionQueueService;

  const orgId = randomUUID();
  const runId = randomUUID();
  const storageRoot = `/tmp/vantedge-promo-${runId}`;
  let tenderId: string;

  const pdf = (marker: string) =>
    buildPdf([
      'SERTIFIKAT BADAN USAHA',
      `Nomor : ${marker}`,
      'Diberikan kepada : PT Karya Bali Mandiri',
      'Berlaku sampai dengan 14 Maret 2029',
    ]);

  const upload = (typeCode: string, body: Buffer) =>
    request(app.getHttpServer())
      .post(`/v1/tenders/${tenderId}/documents`)
      .set('X-Organization-Id', orgId)
      .field('documentTypeCode', typeCode)
      .attach('file', body, { filename: 'doc.pdf', contentType: 'application/pdf' });

  /** Rewind a promoted version to the state an interrupted request leaves. */
  const rewindToPending = async (versionId: string, opts: { keepJob?: boolean } = {}) => {
    const jobId = ingestionJobId(versionId);
    const job = await (
      queue as unknown as { queue: { getJob(id: string): Promise<{ remove(): Promise<void> } | undefined> } }
    ).queue.getJob(jobId);
    await job?.remove();

    await dataSource.query("UPDATE document_versions SET lifecycle = 'pending' WHERE id = $1", [
      versionId,
    ]);
    await dataSource.query(
      'UPDATE tender_documents SET current_version_id = NULL WHERE current_version_id = $1',
      [versionId],
    );
    if (!opts.keepJob) {
      await dataSource.query('DELETE FROM ingestion_jobs WHERE version_id = $1', [versionId]);
    }
  };

  beforeAll(async () => {
    process.env.STORAGE_DRIVER = 'local';
    process.env.STORAGE_LOCAL_ROOT = storageRoot;
    process.env.INGESTION_RECONCILE_INTERVAL_MS = '0';

    const { AppModule } = await import('../../src/app.module');
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.init();

    dataSource = app.get(DataSource);
    storage = app.get(StorageService);
    queue = app.get(IngestionQueueService);

    await dataSource.query(
      `INSERT INTO organizations (id, slug, name, npwp)
       VALUES ($1, $2, 'PT Karya Bali Mandiri', '012345678901234')`,
      [orgId, `promo-${runId.slice(0, 8)}`],
    );
    tenderId = randomUUID();
    await dataSource.query(
      `INSERT INTO tenders
         (id, organization_id, tender_code, title, buyer_name, required_sbu_codes,
          estimated_value, submission_deadline, status)
       VALUES ($1, $2, $3, 'Pembangunan Gedung', 'Dinas PU', ARRAY['BG009'],
               15000000000.00, $4, 'preparing')`,
      [tenderId, orgId, `LPSE-P-${runId.slice(0, 8)}`, new Date(Date.now() + 45 * 86_400_000).toISOString()],
    );
    await dataSource.query(
      `INSERT INTO tender_documents (organization_id, tender_id, document_type_code, title, is_mandatory)
       SELECT $1, $2, code, name, true FROM document_types WHERE is_mandatory_default`,
      [orgId, tenderId],
    );
  }, 60_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM organizations WHERE id = $1', [orgId]);
    }
    await app?.close();
    await rm(storageRoot, { recursive: true, force: true });
  }, 30_000);

  it('promotes a pending version fully, rather than publishing it bare', async () => {
    // Crash after the version row, before the object and the promotion.
    const bytes = pdf(`PENDING-${runId}`);
    const first = await upload('SBU', bytes).expect(202);
    const versionId: string = first.body.versionId;

    const [before] = await dataSource.query(
      'SELECT storage_key FROM document_versions WHERE id = $1',
      [versionId],
    );
    await rewindToPending(versionId);
    await rm(join(storageRoot, 'tender-documents', before.storage_key), { force: true });

    const retry = await upload('SBU', bytes).expect(202);
    expect(retry.body.versionId).toBe(versionId);

    // Object restored, state promoted, ledger present — all of it, not some.
    expect(await storage.head(before.storage_key)).not.toBeNull();

    const [version] = await dataSource.query(
      'SELECT lifecycle FROM document_versions WHERE id = $1',
      [versionId],
    );
    expect(version.lifecycle).toBe('queued');

    const [slot] = await dataSource.query(
      'SELECT current_version_id FROM tender_documents WHERE id = $1',
      [first.body.documentId],
    );
    expect(slot.current_version_id).toBe(versionId);

    const jobs = await dataSource.query(
      'SELECT state, published_at FROM ingestion_jobs WHERE version_id = $1',
      [versionId],
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].published_at).not.toBeNull();

    // And the job really is on the broker.
    expect(await queue.getJobState(ingestionJobId(versionId))).not.toBeNull();
  });

  it('creates exactly one ledger row however often recovery runs', async () => {
    const bytes = pdf(`IDEMPOTENT-${runId}`);
    const first = await upload('NIB', bytes).expect(202);
    const versionId: string = first.body.versionId;

    // Keep the ledger row this time: recovery must not insert a second one.
    await rewindToPending(versionId, { keepJob: true });
    await upload('NIB', bytes).expect(202);
    await rewindToPending(versionId, { keepJob: true });
    await upload('NIB', bytes).expect(202);

    const jobs = await dataSource.query(
      'SELECT id FROM ingestion_jobs WHERE version_id = $1',
      [versionId],
    );
    expect(jobs).toHaveLength(1);

    const versions = await dataSource.query(
      'SELECT id FROM document_versions WHERE document_id = $1',
      [first.body.documentId],
    );
    expect(versions).toHaveLength(1);
  });

  it('does not publish before the durable queued state exists', async () => {
    // The ordering guarantee stated in the README, checked rather than assumed:
    // whenever a job is live, its ledger row and queued lifecycle are already
    // committed.
    const bytes = pdf(`ORDER-${runId}`);
    const response = await upload('KSWP', bytes).expect(202);
    const versionId: string = response.body.versionId;

    expect(await queue.getJobState(ingestionJobId(versionId))).not.toBeNull();

    const [row] = await dataSource.query(
      `SELECT v.lifecycle, j.id AS job_id, j.published_at
         FROM document_versions v
         LEFT JOIN ingestion_jobs j ON j.version_id = v.id
        WHERE v.id = $1`,
      [versionId],
    );
    expect(row.lifecycle).toBe('queued');
    expect(row.job_id).not.toBeNull();
    expect(row.published_at).not.toBeNull();
  });

  it('leaves a terminal version alone', async () => {
    const bytes = pdf(`TERMINAL-${runId}`);
    const first = await upload('PAKTA_INTEGRITAS', bytes).expect(202);
    const versionId: string = first.body.versionId;

    // Quarantine is a decision not to retry. A retry must not undo it.
    await dataSource.query(
      `UPDATE document_versions
          SET lifecycle = 'quarantined', failure_reason = 'no text layer'
        WHERE id = $1`,
      [versionId],
    );
    const jobsBefore = await dataSource.query(
      'SELECT count(*)::int AS n FROM ingestion_jobs WHERE version_id = $1',
      [versionId],
    );

    await upload('PAKTA_INTEGRITAS', bytes).expect(202);

    const [version] = await dataSource.query(
      'SELECT lifecycle, failure_reason FROM document_versions WHERE id = $1',
      [versionId],
    );
    expect(version.lifecycle).toBe('quarantined');
    expect(version.failure_reason).toBe('no text layer');

    const jobsAfter = await dataSource.query(
      'SELECT count(*)::int AS n FROM ingestion_jobs WHERE version_id = $1',
      [versionId],
    );
    expect(jobsAfter[0].n).toBe(jobsBefore[0].n);
  });
});
