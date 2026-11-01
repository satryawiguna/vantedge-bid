import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { rm } from 'node:fs/promises';
import { buildPdf } from '../helpers/pdf-fixture';
import { seedOrganization, seedTender } from '../helpers/seed';

/**
 * An explicit `documentId` is validated before anything is looked up by
 * content.
 *
 * The retry lookup matches on (slot, checksum). Run first, it answers "yes,
 * that is a repeat" for an upload whose slot does not even belong to the
 * requested document type — returning the NIB version as the result of an SBU
 * upload. Validation has to come first, so the invalid request is refused
 * rather than answered from someone else's operation.
 */
const describeIfServices =
  process.env.DATABASE_URL && process.env.REDIS_URL ? describe : describe.skip;

describeIfServices('explicit document slot validation', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;

  const storageRoot = `/tmp/vantedge-slot-${process.pid}-${Date.now()}`;
  let orgId: string;
  let otherOrgId: string;
  let tenderId: string;
  let otherTenderId: string;
  let otherOrgTenderId: string;

  let nibDocumentId: string;
  let nibVersionId: string;
  const bytes = buildPdf([
    'NOMOR INDUK BERUSAHA',
    `Nomor : NIB-SLOT-${process.pid}`,
    'Diberikan kepada : PT Karya Bali Mandiri',
  ]);

  const upload = (
    org: string,
    tender: string,
    typeCode: string,
    fields: Record<string, string> = {},
  ) => {
    let req = request(app.getHttpServer())
      .post(`/v1/tenders/${tender}/documents`)
      .set('X-Organization-Id', org)
      .field('documentTypeCode', typeCode);
    for (const [name, value] of Object.entries(fields)) req = req.field(name, value);
    return req.attach('file', bytes, { filename: 'doc.pdf', contentType: 'application/pdf' });
  };

  const versionCount = async (documentId: string): Promise<number> => {
    const [row] = await dataSource.query(
      'SELECT count(*)::int AS n FROM document_versions WHERE document_id = $1',
      [documentId],
    );
    return row.n;
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

    orgId = await seedOrganization(dataSource, 'slot-a');
    otherOrgId = await seedOrganization(dataSource, 'slot-b');
    tenderId = await seedTender(dataSource, orgId);
    otherTenderId = await seedTender(dataSource, orgId);
    otherOrgTenderId = await seedTender(dataSource, otherOrgId);

    const first = await upload(orgId, tenderId, 'NIB').expect(202);
    nibDocumentId = first.body.documentId;
    nibVersionId = first.body.versionId;
  }, 60_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM organizations WHERE id = ANY($1)', [[orgId, otherOrgId]]);
    }
    await app?.close();
    await rm(storageRoot, { recursive: true, force: true });
  }, 30_000);

  it('treats a matching type and matching checksum as a genuine retry', async () => {
    const response = await upload(orgId, tenderId, 'NIB', { documentId: nibDocumentId }).expect(202);

    expect(response.body.deduplicated).toBe(true);
    expect(response.body.versionId).toBe(nibVersionId);
    expect(await versionCount(nibDocumentId)).toBe(1);
  });

  it('rejects a mismatched document type even when the checksum matches the slot', async () => {
    // Same bytes as the NIB already in the slot, filed as an SBU into that slot.
    const response = await upload(orgId, tenderId, 'SBU', { documentId: nibDocumentId });

    expect(response.status).toBe(400);
    expect(response.body.code ?? response.body.type).toMatch(/validation_failed/);
    // Not answered from the NIB version as though it were a valid SBU upload.
    expect(JSON.stringify(response.body)).not.toContain(nibVersionId);
    expect(await versionCount(nibDocumentId)).toBe(1);
  });

  it('rejects a slot that belongs to another tender', async () => {
    const response = await upload(orgId, otherTenderId, 'NIB', { documentId: nibDocumentId });

    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain(nibVersionId);
    expect(await versionCount(nibDocumentId)).toBe(1);
  });

  it('rejects a slot that belongs to another organisation', async () => {
    const response = await upload(otherOrgId, otherOrgTenderId, 'NIB', {
      documentId: nibDocumentId,
    });

    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain(nibVersionId);
    expect(await versionCount(nibDocumentId)).toBe(1);
  });

  it('rejects a slot that has been soft-deleted', async () => {
    const gone = await upload(orgId, tenderId, 'SBU').expect(202);
    await dataSource.query('UPDATE tender_documents SET deleted_at = now() WHERE id = $1', [
      gone.body.documentId,
    ]);

    const response = await upload(orgId, tenderId, 'SBU', { documentId: gone.body.documentId });

    expect(response.status).toBe(404);
    expect(await versionCount(gone.body.documentId)).toBe(1);
  });
});
