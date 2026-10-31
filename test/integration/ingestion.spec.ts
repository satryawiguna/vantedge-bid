import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { buildPdf } from '../helpers/pdf-fixture';

/**
 * End-to-end over the real HTTP stack, a real database and a real queue
 * connection. Storage uses the local driver so the suite needs no object store.
 *
 * These are the behaviours that unit tests cannot reach, because each one is a
 * claim about several components agreeing: the request path persisting what it
 * says it persisted, versioning being driven by content rather than by the
 * caller, idempotency surviving a repeat, and tenant isolation actually holding
 * at the query layer rather than only in the guard.
 *
 * Skipped without DATABASE_URL so `npm test` stays runnable with no services.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDatabase('document ingestion (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  // A fresh tenant per run: document_versions is unique on
  // (organization_id, checksum_sha256), so reusing one would make the second
  // run of the suite de-duplicate against the first.
  const orgA = randomUUID();
  const orgB = randomUUID();
  const runId = randomUUID();
  let tenderA: string;
  let tenderB: string;

  const sbuPdf = (marker: string) =>
    buildPdf([
      'SERTIFIKAT BADAN USAHA JASA PELAKSANA KONSTRUKSI',
      `Nomor : ${marker}`,
      'Diberikan kepada : PT Karya Bali Mandiri',
      'NPWP : 01.234.567.8-901.234',
      'Klasifikasi : BG009',
      'Berlaku sampai dengan 14 Maret 2029',
    ]);

  const post = (tenderId: string, organizationId: string) =>
    request(app.getHttpServer())
      .post(`/v1/tenders/${tenderId}/documents`)
      .set('X-Organization-Id', organizationId);

  const attach = (req: request.Test, pdf: Buffer, filename = 'sbu.pdf') =>
    req.attach('file', pdf, { filename, contentType: 'application/pdf' });

  beforeAll(async () => {
    process.env.STORAGE_DRIVER = 'local';
    process.env.STORAGE_LOCAL_ROOT = `/tmp/vantedge-test-storage-${runId}`;

    // Imported here rather than at the top of the file: ConfigModule.forRoot
    // runs env validation when the module is *defined*, so a static import
    // would throw during collection even when this suite is skipped. That the
    // import is load-bearing is the fail-fast behaviour working as intended.
    const { AppModule } = await import('../../src/app.module');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    // Mirror main.ts, so the routes and validation under test are the real ones.
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.init();

    dataSource = app.get(DataSource);

    for (const [id, slug] of [
      [orgA, `org-a-${runId.slice(0, 8)}`],
      [orgB, `org-b-${runId.slice(0, 8)}`],
    ]) {
      await dataSource.query(
        `INSERT INTO organizations (id, slug, name, npwp)
         VALUES ($1, $2, 'PT Karya Bali Mandiri', '012345678901234')`,
        [id, slug],
      );
    }

    tenderA = await seedTender(dataSource, orgA, `A-${runId.slice(0, 8)}`);
    tenderB = await seedTender(dataSource, orgB, `B-${runId.slice(0, 8)}`);
  }, 60_000);

  afterAll(async () => {
    // Cascades through tenders, documents, versions, jobs and audits.
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM organizations WHERE id = ANY($1)', [[orgA, orgB]]);
    }
    await app?.close();
  });

  // ---------------------------------------------------------------------------

  describe('persistence', () => {
    it('stores the version, links the slot and records a queue job', async () => {
      const response = await attach(post(tenderA, orgA), sbuPdf(`PERSIST-${runId}`))
        .field('documentTypeCode', 'SBU')
        .expect(202);

      const { documentId, versionId, lifecycle, versionNo } = response.body;
      expect(lifecycle).toBe('queued');
      expect(versionNo).toBe(1);

      const [version] = await dataSource.query(
        'SELECT lifecycle, organization_id, storage_key FROM document_versions WHERE id = $1',
        [versionId],
      );
      expect(version.lifecycle).toBe('queued');
      expect(version.organization_id).toBe(orgA);

      // The slot now points at this version — the single-row lookup the read
      // path depends on.
      const [slot] = await dataSource.query(
        'SELECT current_version_id FROM tender_documents WHERE id = $1',
        [documentId],
      );
      expect(slot.current_version_id).toBe(versionId);

      // Queue work was recorded durably, not only handed to Redis.
      const [job] = await dataSource.query(
        'SELECT state, queue_name FROM ingestion_jobs WHERE version_id = $1',
        [versionId],
      );
      expect(job).toBeDefined();
      expect(job.state).toBe('queued');

      // And an immutable trail entry exists for the upload.
      const [trail] = await dataSource.query(
        "SELECT action FROM audit_trail WHERE entity_id = $1 AND entity_type = 'document_version'",
        [versionId],
      );
      expect(trail.action).toBe('uploaded');
    });

    it('fills the pre-opened slot instead of creating a second one', async () => {
      const [{ count: before }] = await dataSource.query(
        "SELECT count(*)::int FROM tender_documents WHERE tender_id = $1 AND document_type_code = 'NIB'",
        [tenderA],
      );

      await attach(post(tenderA, orgA), sbuPdf(`SLOT-${runId}`))
        .field('documentTypeCode', 'NIB')
        .expect(202);

      const [{ count: after }] = await dataSource.query(
        "SELECT count(*)::int FROM tender_documents WHERE tender_id = $1 AND document_type_code = 'NIB'",
        [tenderA],
      );
      expect(after).toBe(before);
    });
  });

  describe('content addressing', () => {
    it('de-duplicates byte-identical content instead of storing it twice', async () => {
      const pdf = sbuPdf(`DEDUP-${runId}`);

      const first = await attach(post(tenderA, orgA), pdf)
        .field('documentTypeCode', 'SPT_TAHUNAN')
        .expect(202);

      const second = await attach(post(tenderA, orgA), pdf, 'renamed.pdf')
        .field('documentTypeCode', 'SPT_TAHUNAN')
        .expect(202);

      expect(second.body.deduplicated).toBe(true);
      expect(second.body.versionId).toBe(first.body.versionId);

      const [{ count }] = await dataSource.query(
        'SELECT count(*)::int FROM document_versions WHERE checksum_sha256 = $1',
        [first.body.checksum],
      );
      expect(count).toBe(1);
    });

    it('creates a second version when the same slot receives different bytes', async () => {
      const first = await attach(post(tenderA, orgA), sbuPdf(`V1-${runId}`))
        .field('documentTypeCode', 'KSWP')
        .expect(202);

      const second = await attach(post(tenderA, orgA), sbuPdf(`V2-${runId}`))
        .field('documentTypeCode', 'KSWP')
        .field('documentId', first.body.documentId)
        .expect(202);

      expect(second.body.documentId).toBe(first.body.documentId);
      expect(second.body.versionNo).toBe(first.body.versionNo + 1);

      // Version 1 is still there. A correction must never erase what a past
      // audit cited.
      const [{ count }] = await dataSource.query(
        'SELECT count(*)::int FROM document_versions WHERE document_id = $1',
        [first.body.documentId],
      );
      expect(count).toBe(2);
    });
  });

  describe('idempotency', () => {
    it('replays the original response for an identical retry', async () => {
      const key = randomUUID();
      const pdf = sbuPdf(`IDEM-OK-${runId}`);

      const first = await attach(
        post(tenderA, orgA).set('Idempotency-Key', key),
        pdf,
      )
        .field('documentTypeCode', 'PAKTA_INTEGRITAS')
        .expect(202);

      const retry = await attach(
        post(tenderA, orgA).set('Idempotency-Key', key),
        pdf,
      )
        .field('documentTypeCode', 'PAKTA_INTEGRITAS')
        .expect(202);

      expect(retry.headers['idempotent-replay']).toBe('true');
      expect(retry.body.versionId).toBe(first.body.versionId);
    });

    it('refuses the same key carrying a different document', async () => {
      // The defect this test exists for: request_hash was stored but never
      // compared, so this call used to return the first upload's response and
      // report success for a document that was never stored.
      const key = randomUUID();

      await attach(post(tenderA, orgA).set('Idempotency-Key', key), sbuPdf(`IDEM-A-${runId}`))
        .field('documentTypeCode', 'SURAT_PERNYATAAN')
        .expect(202);

      const conflict = await attach(
        post(tenderA, orgA).set('Idempotency-Key', key),
        sbuPdf(`IDEM-B-${runId}`),
      )
        .field('documentTypeCode', 'SURAT_PERNYATAAN')
        .expect(409);

      expect(conflict.body.code).toBe('idempotency_key_reused');
    });

    it('does not hold the key after a failed attempt', async () => {
      const key = randomUUID();

      // Fails validation, so no claim should survive.
      await attach(
        post(tenderA, orgA).set('Idempotency-Key', key),
        Buffer.from('#!/bin/sh\nnot a pdf\n'),
      )
        .field('documentTypeCode', 'NERACA_KEUANGAN')
        .expect(415);

      // The same key is now free for the corrected upload.
      await attach(post(tenderA, orgA).set('Idempotency-Key', key), sbuPdf(`IDEM-RETRY-${runId}`))
        .field('documentTypeCode', 'NERACA_KEUANGAN')
        .expect(202);
    });
  });

  describe('tenant isolation', () => {
    it("reports another tenant's tender as missing, not forbidden", async () => {
      // 404 rather than 403 on purpose: a 403 would confirm the tender exists.
      const response = await attach(post(tenderB, orgA), sbuPdf(`ISO-${runId}`))
        .field('documentTypeCode', 'SBU')
        .expect(404);

      expect(response.body.code).toBe('tender_not_found');
    });

    it("will not disclose another tenant's document status", async () => {
      const upload = await attach(post(tenderA, orgA), sbuPdf(`ISO-STATUS-${runId}`))
        .field('documentTypeCode', 'PENGALAMAN_KERJA')
        .expect(202);

      await request(app.getHttpServer())
        .get(`/v1/documents/versions/${upload.body.versionId}/status`)
        .set('X-Organization-Id', orgB)
        .expect(404);

      // ... while the owner can read it.
      await request(app.getHttpServer())
        .get(`/v1/documents/versions/${upload.body.versionId}/status`)
        .set('X-Organization-Id', orgA)
        .expect(200);
    });

    it("will not run an audit on another tenant's tender", async () => {
      await request(app.getHttpServer())
        .post(`/v1/tenders/${tenderA}/compliance-audits`)
        .set('X-Organization-Id', orgB)
        .expect(404);
    });
  });

  describe('rejections over HTTP', () => {
    it('rejects a file whose bytes contradict its declared type', async () => {
      const response = await attach(
        post(tenderA, orgA),
        Buffer.from('#!/bin/sh\necho not a pdf\n'),
      )
        .field('documentTypeCode', 'SBU')
        .expect(415);

      expect(response.body.code).toBe('file_signature_mismatch');
      // RFC 7807, so a generic client can render it without knowing our codes.
      expect(response.headers['content-type']).toContain('application/problem+json');
    });

    it('requires a tenant header', async () => {
      await request(app.getHttpServer())
        .post(`/v1/tenders/${tenderA}/documents`)
        .field('documentTypeCode', 'SBU')
        .expect(400);
    });
  });
});

async function seedTender(dataSource: DataSource, organizationId: string, suffix: string) {
  const id = randomUUID();
  const deadline = new Date(Date.now() + 45 * 86_400_000).toISOString();

  await dataSource.query(
    `INSERT INTO tenders
       (id, organization_id, tender_code, title, buyer_name, work_category,
        required_sbu_codes, estimated_value, submission_deadline, status)
     VALUES ($1, $2, $3, 'Pembangunan Gedung', 'Dinas PU', 'bangunan_gedung',
             ARRAY['BG009'], 15000000000.00, $4, 'preparing')`,
    [id, organizationId, `LPSE-TEST-${suffix}`, deadline],
  );

  // Mirrors TendersService.create: open a slot per mandatory type.
  await dataSource.query(
    `INSERT INTO tender_documents (organization_id, tender_id, document_type_code, title, is_mandatory)
     SELECT $1, $2, code, name, true FROM document_types WHERE is_mandatory_default`,
    [organizationId, id],
  );

  return id;
}
