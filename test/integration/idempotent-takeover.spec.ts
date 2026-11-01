import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { buildPdf } from '../helpers/pdf-fixture';
import { seedOrganization, seedTender } from '../helpers/seed';
import { DocumentsService, fingerprintRequest } from '../../src/modules/documents/documents.service';
import { StorageService } from '../../src/storage/storage.service';
import { createHash } from 'node:crypto';

/**
 * An idempotency takeover recovers the operation the dead request began.
 *
 * A request files its version in one transaction and only afterwards records
 * its response against the Idempotency-Key. If the process dies in between, the
 * lease expires and the same request takes the key over — and for a
 * multi-instance type like SKK_PERSONIL it must not file a second logical
 * document, because byte-identical SKK files are legitimately distinct
 * submissions, so no checksum can tell the retry from a new upload.
 *
 * These tests call DocumentsService directly. The claim is exercised through
 * its real methods, not through SQL restated in the test.
 */
const describeIfServices =
  process.env.DATABASE_URL && process.env.REDIS_URL ? describe : describe.skip;

type Internals = {
  claimIdempotencyKey(p: { organizationId: string; key: string; requestHash: string }): Promise<
    | { outcome: 'claimed'; token: string; versionId: string | null }
    | { outcome: 'replay'; body: unknown }
  >;
  completeClaim(org: string, key: string, token: string, body: unknown): Promise<void>;
  releaseClaim(org: string, key: string, token: string): Promise<void>;
};

describeIfServices('idempotency takeover', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let service: DocumentsService;
  let internals: Internals;
  let storage: StorageService;

  const storageRoot = `/tmp/vantedge-takeover-${process.pid}-${Date.now()}`;
  let orgId: string;
  let tenderId: string;

  const skk = (marker: string) =>
    buildPdf([
      'SERTIFIKAT KOMPETENSI KERJA',
      `Nomor : ${marker}`,
      'Diberikan kepada : Budi Santoso',
      'Berlaku sampai dengan 14 Maret 2029',
    ]);

  const fileOf = (buffer: Buffer) =>
    ({
      buffer,
      size: buffer.byteLength,
      mimetype: 'application/pdf',
      originalname: 'skk.pdf',
    }) as Express.Multer.File;

  const ingest = (buffer: Buffer, key: string, dto: { documentTypeCode?: string } = {}) =>
    service.ingest({
      context: { organizationId: orgId, userId: null },
      tenderId,
      dto: { documentTypeCode: dto.documentTypeCode ?? 'SKK_PERSONIL' },
      file: fileOf(buffer),
      idempotencyKey: key,
    });

  const hashOf = (buffer: Buffer, typeCode = 'SKK_PERSONIL') =>
    fingerprintRequest(
      tenderId,
      { documentTypeCode: typeCode },
      createHash('sha256').update(buffer).digest('hex'),
    );

  const counts = async (typeCode = 'SKK_PERSONIL') => {
    const [row] = await dataSource.query(
      `SELECT (SELECT count(*)::int FROM tender_documents
                WHERE tender_id = $1 AND document_type_code = $2) AS documents,
              (SELECT count(*)::int FROM document_versions v
                 JOIN tender_documents d ON d.id = v.document_id
                WHERE d.tender_id = $1 AND d.document_type_code = $2) AS versions,
              (SELECT count(*)::int FROM ingestion_jobs j
                 JOIN document_versions v ON v.id = j.version_id
                 JOIN tender_documents d ON d.id = v.document_id
                WHERE d.tender_id = $1 AND d.document_type_code = $2) AS jobs`,
      [tenderId, typeCode],
    );
    return row as { documents: number; versions: number; jobs: number };
  };

  const claimRow = async (key: string) => {
    const [row] = await dataSource.query(
      `SELECT owner_token, response_body, version_id FROM idempotency_keys
        WHERE organization_id = $1 AND key = $2`,
      [orgId, key],
    );
    return row as
      | { owner_token: string; response_body: unknown; version_id: string | null }
      | undefined;
  };

  const expireLease = (key: string) =>
    dataSource.query(
      `UPDATE idempotency_keys SET created_at = now() - interval '1 hour'
        WHERE organization_id = $1 AND key = $2`,
      [orgId, key],
    );

  /** What a dead process leaves behind: version filed, response never recorded. */
  const crashBeforeCompletion = async (buffer: Buffer, key: string) => {
    const complete = jest
      .spyOn(service as unknown as Internals, 'completeClaim')
      .mockRejectedValue(new Error('process died before recording the response'));
    // A dead process runs no cleanup either.
    const release = jest
      .spyOn(service as unknown as Internals, 'releaseClaim')
      .mockResolvedValue(undefined);
    try {
      await expect(ingest(buffer, key)).rejects.toThrow('process died');
    } finally {
      complete.mockRestore();
      release.mockRestore();
    }
  };

  beforeAll(async () => {
    process.env.STORAGE_DRIVER = 'local';
    process.env.STORAGE_LOCAL_ROOT = storageRoot;
    process.env.INGESTION_RECONCILE_INTERVAL_MS = '0';

    const { AppModule } = await import('../../src/app.module');
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    dataSource = moduleRef.get(DataSource);
    service = moduleRef.get(DocumentsService, { strict: false });
    internals = service as unknown as Internals;
    storage = moduleRef.get(StorageService, { strict: false });

    orgId = await seedOrganization(dataSource, 'takeover');
    tenderId = await seedTender(dataSource, orgId);
  }, 60_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM organizations WHERE id = $1', [orgId]);
    }
    await moduleRef?.close();
    await rm(storageRoot, { recursive: true, force: true });
  }, 30_000);

  afterEach(() => jest.restoreAllMocks());

  it('recovers the original operation instead of filing a second logical document', async () => {
    const key = randomUUID();
    const bytes = skk(`TAKEOVER-${key}`);

    await crashBeforeCompletion(bytes, key);

    const afterCrash = await counts();
    const crashed = await claimRow(key);
    expect(afterCrash).toEqual({ documents: 1, versions: 1, jobs: 1 });
    expect(crashed?.response_body).toBeNull();
    // The claim knows which operation it began.
    expect(crashed?.version_id).not.toBeNull();

    const [originalVersion] = await dataSource.query(
      'SELECT id, document_id FROM document_versions WHERE id = $1',
      [crashed?.version_id],
    );

    await expireLease(key);
    const retry = await ingest(bytes, key);

    expect(retry.replayed).toBe(false);
    expect(retry.body.versionId).toBe(originalVersion.id);
    expect(retry.body.documentId).toBe(originalVersion.document_id);
    // Exactly one logical document, one version, one ledger row.
    expect(await counts()).toEqual({ documents: 1, versions: 1, jobs: 1 });

    // And the takeover completed the claim, so the next retry is a plain replay.
    const completed = await claimRow(key);
    expect(completed?.response_body).not.toBeNull();
    const replay = await ingest(bytes, key);
    expect(replay.replayed).toBe(true);
    expect(replay.body.versionId).toBe(originalVersion.id);
  });

  it('keeps two byte-identical uploads under different keys as two documents', async () => {
    // The association is by request identity, not content: the checksum must
    // not collapse two key personnel who hold identical files.
    const before = await counts();
    const bytes = skk(`IDENTICAL-${randomUUID()}`);

    const first = await ingest(bytes, randomUUID());
    const second = await ingest(bytes, randomUUID());

    expect(second.body.documentId).not.toBe(first.body.documentId);
    expect(second.body.versionId).not.toBe(first.body.versionId);
    const after = await counts();
    expect(after.documents).toBe(before.documents + 2);
    expect(after.versions).toBe(before.versions + 2);
  });

  it('stops the previous owner completing or releasing its successor’s claim', async () => {
    const key = randomUUID();
    const bytes = skk(`OWNERSHIP-${key}`);

    await crashBeforeCompletion(bytes, key);
    const oldToken = (await claimRow(key))!.owner_token;
    const [{ id: versionId }] = await dataSource.query(
      'SELECT version_id AS id FROM idempotency_keys WHERE organization_id = $1 AND key = $2',
      [orgId, key],
    );

    await expireLease(key);
    const takeover = await internals.claimIdempotencyKey({
      organizationId: orgId,
      key,
      requestHash: hashOf(bytes),
    });

    expect(takeover.outcome).toBe('claimed');
    if (takeover.outcome !== 'claimed') return;
    expect(takeover.token).not.toBe(oldToken);
    // The successor is handed the operation the predecessor began.
    expect(takeover.versionId).toBe(versionId);

    // The old owner wakes up and tries to finish and then discard the claim.
    await internals.completeClaim(orgId, key, oldToken, { versionId: 'stale-answer' });
    await internals.releaseClaim(orgId, key, oldToken);

    const row = await claimRow(key);
    expect(row).toBeDefined();
    expect(row!.owner_token).toBe(takeover.token);
    expect(row!.response_body).toBeNull();
    expect(row!.version_id).toBe(versionId);

    // The rightful owner still can.
    await internals.completeClaim(orgId, key, takeover.token, { versionId });
    expect((await claimRow(key))!.response_body).toEqual({ versionId });
  });

  it('does not let a different request take the operation over', async () => {
    const key = randomUUID();
    const bytes = skk(`FINGERPRINT-${key}`);

    await crashBeforeCompletion(bytes, key);
    const before = await counts();
    const original = (await claimRow(key))!;
    await expireLease(key);

    // Same key, different file: a different request, whatever the lease says.
    await expect(ingest(skk(`OTHER-${key}`), key)).rejects.toMatchObject({
      code: 'idempotency_key_reused',
    });

    const row = (await claimRow(key))!;
    expect(row.owner_token).toBe(original.owner_token);
    expect(row.version_id).toBe(original.version_id);
    expect(await counts()).toEqual(before);
  });

  it('recovers a version whose upload to storage failed, without a second document', async () => {
    const key = randomUUID();
    const bytes = skk(`UPLOADFAIL-${key}`);
    const before = await counts();

    jest.spyOn(storage, 'put').mockRejectedValueOnce(new Error('object store unavailable'));
    await expect(ingest(bytes, key)).rejects.toThrow('object store unavailable');

    // The version exists and is recorded as failed; the claim still names it.
    const afterFailure = await counts();
    expect(afterFailure.documents).toBe(before.documents + 1);
    expect(afterFailure.versions).toBe(before.versions + 1);
    const failedClaim = await claimRow(key);
    expect(failedClaim?.version_id).not.toBeNull();

    // The client retries the same request once storage is back.
    const retry = await ingest(bytes, key);

    expect(retry.body.versionId).toBe(failedClaim!.version_id);
    expect(retry.body.lifecycle).toBe('queued');
    const afterRetry = await counts();
    expect(afterRetry.documents).toBe(before.documents + 1);
    expect(afterRetry.versions).toBe(before.versions + 1);
    expect(afterRetry.jobs).toBe(before.jobs + 1);
  });
});
