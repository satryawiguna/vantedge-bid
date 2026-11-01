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
 * Recovery from partial failures: storage objects that are not there, queue
 * publishes that never happened, and idempotency claims whose process died.
 *
 * Each of these is a window between two systems that cannot be made atomic.
 * The design does not try to remove them; it makes the database the record of
 * intent and then proves the system can get back to a consistent state.
 */
const describeIfServices =
  process.env.DATABASE_URL && process.env.REDIS_URL ? describe : describe.skip;

describeIfServices('failure recovery', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let storage: StorageService;
  let queue: IngestionQueueService;

  const orgId = randomUUID();
  const runId = randomUUID();
  const storageRoot = `/tmp/vantedge-recovery-${runId}`;
  let tenderId: string;

  const pdf = (marker: string) =>
    buildPdf([
      'SERTIFIKAT BADAN USAHA',
      `Nomor : ${marker}`,
      'Diberikan kepada : PT Karya Bali Mandiri',
      'Berlaku sampai dengan 14 Maret 2029',
    ]);

  const upload = (typeCode: string, body: Buffer, key?: string) => {
    const req = request(app.getHttpServer())
      .post(`/v1/tenders/${tenderId}/documents`)
      .set('X-Organization-Id', orgId);
    if (key) req.set('Idempotency-Key', key);
    return req
      .field('documentTypeCode', typeCode)
      .attach('file', body, { filename: 'doc.pdf', contentType: 'application/pdf' });
  };

  beforeAll(async () => {
    process.env.STORAGE_DRIVER = 'local';
    process.env.STORAGE_LOCAL_ROOT = storageRoot;
    // A one-millisecond lease so an abandoned claim is immediately stale, and a
    // zero grace so the reconciler acts on this test's rows without waiting.
    process.env.IDEMPOTENCY_CLAIM_LEASE_MS = '1';
    process.env.INGESTION_RECONCILE_GRACE_MS = '0';
    process.env.INGESTION_RECONCILE_INTERVAL_MS = '0'; // driven manually

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
      [orgId, `recovery-${runId.slice(0, 8)}`],
    );
    tenderId = randomUUID();
    await dataSource.query(
      `INSERT INTO tenders
         (id, organization_id, tender_code, title, buyer_name, required_sbu_codes,
          estimated_value, submission_deadline, status)
       VALUES ($1, $2, $3, 'Pembangunan Gedung', 'Dinas PU', ARRAY['BG009'],
               15000000000.00, $4, 'preparing')`,
      [tenderId, orgId, `LPSE-R-${runId.slice(0, 8)}`, new Date(Date.now() + 45 * 86_400_000).toISOString()],
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

  // ---------------------------------------------------------------------------

  describe('object availability', () => {
    it('restores the object when the row exists but the file is gone', async () => {
      const bytes = pdf(`RESTORE-${runId}`);
      const first = await upload('SBU', bytes).expect(202);

      const [version] = await dataSource.query(
        'SELECT storage_key, size_bytes FROM document_versions WHERE id = $1',
        [first.body.versionId],
      );

      // Delete the object out from under the record, as a failed or
      // half-finished write would.
      await rm(join(storageRoot, 'tender-documents', version.storage_key), { force: true });
      expect(await storage.head(version.storage_key)).toBeNull();

      // The retry carries the bytes again, so recovery needs nothing else.
      await upload('SBU', bytes).expect(202);

      const restored = await storage.head(version.storage_key);
      expect(restored).not.toBeNull();
      expect(restored!.sizeBytes).toBe(Number(version.size_bytes));
    });

    it('rewrites an object that is present but truncated', async () => {
      // A database row is not evidence of a complete file. Deciding reuse from
      // the row — which is what this used to do — would skip the write and
      // leave a worker reading a partial document.
      const bytes = pdf(`TRUNCATED-${runId}`);
      const first = await upload('NIB', bytes).expect(202);

      const [version] = await dataSource.query(
        'SELECT storage_key, size_bytes FROM document_versions WHERE id = $1',
        [first.body.versionId],
      );
      const path = join(storageRoot, 'tender-documents', version.storage_key);

      const { writeFile } = await import('node:fs/promises');
      await writeFile(path, bytes.subarray(0, 40));
      expect((await storage.head(version.storage_key))!.sizeBytes).toBe(40);

      await upload('NIB', bytes).expect(202);

      expect((await storage.head(version.storage_key))!.sizeBytes).toBe(
        Number(version.size_bytes),
      );
    });

    it('writes one complete object when identical uploads race', async () => {
      const bytes = pdf(`RACE-${runId}`);

      const responses = await Promise.all([
        upload('SPT_TAHUNAN', bytes),
        upload('KSWP', bytes),
        upload('PAKTA_INTEGRITAS', bytes),
      ]);
      expect(responses.every((r) => r.status === 202)).toBe(true);

      // Three slots, three version rows, one object — and the object is whole.
      const versionIds = responses.map((r) => r.body.versionId);
      expect(new Set(versionIds).size).toBe(3);

      const keys = await dataSource.query(
        'SELECT DISTINCT storage_key, size_bytes FROM document_versions WHERE id = ANY($1)',
        [versionIds],
      );
      expect(keys).toHaveLength(1);

      const head = await storage.head(keys[0].storage_key);
      expect(head!.sizeBytes).toBe(Number(keys[0].size_bytes));
    });
  });

  describe('queue publication', () => {
    it('republishes a job that was committed but never reached the broker', async () => {
      const response = await upload('METODE_PELAKSANAAN', pdf(`UNPUB-${runId}`)).expect(202);
      const versionId: string = response.body.versionId;
      const jobId = ingestionJobId(versionId);

      // Simulate the crash window: the row is committed, the publish never
      // happened. Removing the live job and clearing published_at reproduces
      // the state the database would be left in.
      const job = await (queue as unknown as { queue: { getJob(id: string): Promise<{ remove(): Promise<void> } | undefined> } }).queue.getJob(jobId);
      await job?.remove();
      await dataSource.query(
        'UPDATE ingestion_jobs SET published_at = NULL WHERE job_key = $1',
        [jobId],
      );
      expect(await queue.getJobState(jobId)).toBeNull();

      const { IngestionReconciler } = await import(
        '../../src/modules/ingestion/ingestion.reconciler'
      );
      const reconciler = moduleRef.get(IngestionReconciler, { strict: false });

      expect(await reconciler.reconcile()).toBe(1);
      expect(await queue.getJobState(jobId)).not.toBeNull();

      const [row] = await dataSource.query(
        'SELECT published_at FROM ingestion_jobs WHERE job_key = $1',
        [jobId],
      );
      expect(row.published_at).not.toBeNull();
    });

    it('is a no-op on a second pass, and never duplicates a live job', async () => {
      const { IngestionReconciler } = await import(
        '../../src/modules/ingestion/ingestion.reconciler'
      );
      const reconciler = moduleRef.get(IngestionReconciler, { strict: false });

      // Everything is published by now, so a further pass must find nothing.
      expect(await reconciler.reconcile()).toBe(0);

      const [{ count }] = await dataSource.query(
        `SELECT count(*)::int FROM ingestion_jobs j
           JOIN document_versions v ON v.id = j.version_id
          WHERE v.organization_id = $1 AND j.published_at IS NULL`,
        [orgId],
      );
      expect(count).toBe(0);
    });

    it('does not resurrect work that already completed', async () => {
      // A completed job with published_at cleared must stay untouched: the
      // reconciler keys on state, not only on the publication flag.
      const response = await upload('RKK', pdf(`DONE-${runId}`)).expect(202);
      const jobId = ingestionJobId(response.body.versionId);

      await dataSource.query(
        "UPDATE ingestion_jobs SET state = 'completed', published_at = NULL WHERE job_key = $1",
        [jobId],
      );

      const { IngestionReconciler } = await import(
        '../../src/modules/ingestion/ingestion.reconciler'
      );
      const reconciler = moduleRef.get(IngestionReconciler, { strict: false });
      expect(await reconciler.reconcile()).toBe(0);
    });
  });

  describe('idempotency claims', () => {
    it('lets the same request take over a claim whose process died', async () => {
      const key = randomUUID();
      const bytes = pdf(`LEASE-${runId}`);

      // A claim with no response is a request in flight; this one is
      // abandoned. The lease is 1 ms in this suite, so it is already stale.
      await dataSource.query(
        `INSERT INTO idempotency_keys (organization_id, key, endpoint, request_hash, created_at)
         VALUES ($1, $2, 'POST /v1/tenders/:tenderId/documents', $3, now() - interval '1 hour')`,
        [orgId, key, await fingerprintFor(tenderId, 'DAFTAR_PERALATAN', bytes)],
      );

      // The same request recovers rather than being told it is in progress.
      const response = await upload('DAFTAR_PERALATAN', bytes, key).expect(202);
      expect(response.body.versionId).toBeDefined();
    });

    it('refuses to let a different request inherit a stale claim', async () => {
      const key = randomUUID();

      await dataSource.query(
        `INSERT INTO idempotency_keys (organization_id, key, endpoint, request_hash, created_at)
         VALUES ($1, $2, 'POST /v1/tenders/:tenderId/documents', $3, now() - interval '1 hour')`,
        [orgId, key, 'f'.repeat(64)],
      );

      // Stale is not the same as free. A key abandoned by one request must not
      // become a different request's to use.
      const response = await upload('AHSP', pdf(`STEAL-${runId}`), key).expect(409);
      expect(response.body.code).toBe('idempotency_key_reused');
    });

    it('does not create a second document when a retry takes over a claim', async () => {
      const key = randomUUID();
      const bytes = pdf(`NODUP-${runId}`);

      const first = await upload('SURAT_PENAWARAN', bytes, key).expect(202);

      // Rewind the claim to look abandoned mid-flight, as a crash would.
      await dataSource.query(
        `UPDATE idempotency_keys
            SET response_body = NULL, response_status = NULL, created_at = now() - interval '1 hour'
          WHERE organization_id = $1 AND key = $2`,
        [orgId, key],
      );

      const retry = await upload('SURAT_PENAWARAN', bytes, key).expect(202);

      // The retry finds the version the first attempt already created.
      expect(retry.body.versionId).toBe(first.body.versionId);

      const [{ count }] = await dataSource.query(
        'SELECT count(*)::int FROM document_versions WHERE id = $1 OR document_id = $2',
        [first.body.versionId, first.body.documentId],
      );
      expect(count).toBe(1);
    });
  });

  async function fingerprintFor(tender: string, typeCode: string, bytes: Buffer) {
    const { fingerprintRequest } = await import('../../src/modules/documents/documents.service');
    const { createHash } = await import('node:crypto');
    const checksum = createHash('sha256').update(bytes).digest('hex');
    return fingerprintRequest(tender, { documentTypeCode: typeCode } as never, checksum);
  }
});
