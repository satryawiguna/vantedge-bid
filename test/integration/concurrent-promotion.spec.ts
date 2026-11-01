import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { rm } from 'node:fs/promises';
import { buildPdf } from '../helpers/pdf-fixture';
import { seedOrganization, seedTender, waitUntil } from '../helpers/seed';
import { DocumentsService } from '../../src/modules/documents/documents.service';

/**
 * Two recovery requests over one `pending` version, with a worker running.
 *
 * Both read the version while it is `pending`. One promotes it and publishes;
 * the worker takes it all the way to `processed`. The other, still holding the
 * stale `pending`, then reaches its own promotion. With an unconditional
 * `UPDATE … SET lifecycle = 'queued'` it writes `queued` over `processed`: the
 * extraction is finished and the version reports that it is not.
 *
 * The test drives the real DocumentsService against real transactions, a real
 * BullMQ queue and the real ingestion processor. Two barriers make the
 * interleaving deterministic instead of hoping a race lands:
 *
 *  - both requests must have read the pending version before either continues;
 *  - the second request is held until the worker has finished the version.
 */
const describeIfServices =
  process.env.DATABASE_URL && process.env.REDIS_URL ? describe : describe.skip;

type Internals = {
  findRetryInTender(...args: unknown[]): Promise<unknown>;
  restoreObjectIfMissing(...args: unknown[]): Promise<void>;
  promoteToQueued(...args: unknown[]): Promise<unknown>;
};

describeIfServices('concurrent recovery of a pending promotion', () => {
  let apiRef: TestingModule;
  let workerRef: TestingModule;
  let dataSource: DataSource;
  let service: DocumentsService;

  const storageRoot = `/tmp/vantedge-promo-race-${process.pid}-${Date.now()}`;
  let orgId: string;
  let tenderId: string;

  const sbu = (marker: string) =>
    buildPdf([
      'SERTIFIKAT BADAN USAHA',
      `Nomor : ${marker}`,
      'Diberikan kepada : PT Karya Bali Mandiri',
      'Klasifikasi : BG009',
      'Berlaku sampai dengan 14 Maret 2029',
    ]);

  const ingest = (buffer: Buffer) =>
    service.ingest({
      context: { organizationId: orgId, userId: null },
      tenderId,
      dto: { documentTypeCode: 'SBU' },
      file: {
        buffer,
        size: buffer.byteLength,
        mimetype: 'application/pdf',
        originalname: 'sbu.pdf',
      } as Express.Multer.File,
    });

  const lifecycleOf = async (versionId: string): Promise<string> => {
    const [row] = await dataSource.query('SELECT lifecycle FROM document_versions WHERE id = $1', [
      versionId,
    ]);
    return row.lifecycle;
  };

  beforeAll(async () => {
    process.env.STORAGE_DRIVER = 'local';
    process.env.STORAGE_LOCAL_ROOT = storageRoot;
    process.env.INGESTION_RECONCILE_INTERVAL_MS = '0';
    // Keep audits out of this test: it is about the ingestion lifecycle.
    process.env.AUDIT_DEBOUNCE_MS = '60000';

    const { AppModule } = await import('../../src/app.module');
    const { WorkerModule } = await import('../../src/worker.module');

    apiRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await apiRef.init();
    dataSource = apiRef.get(DataSource);
    service = apiRef.get(DocumentsService, { strict: false });

    orgId = await seedOrganization(dataSource, 'promo-race');
    tenderId = await seedTender(dataSource, orgId);

    workerRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    workerRef.useLogger(false);
    await workerRef.init();
  }, 90_000);

  afterAll(async () => {
    await workerRef?.close();
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM organizations WHERE id = $1', [orgId]);
    }
    await apiRef?.close();
    await rm(storageRoot, { recursive: true, force: true });
  }, 30_000);

  afterEach(() => jest.restoreAllMocks());

  it('promotes once, lets the worker finish, and never regresses processed to queued', async () => {
    const bytes = sbu(`RACE-${process.pid}-${Date.now()}`);
    const internals = service as unknown as Internals;

    // A request that died after filing the version and storing the object, but
    // before promoting it: the state a recovery has to finish.
    jest
      .spyOn(internals, 'promoteToQueued')
      .mockRejectedValueOnce(new Error('process died before promotion'));
    await expect(ingest(bytes)).rejects.toThrow('process died before promotion');
    jest.restoreAllMocks();

    const [pending] = await dataSource.query(
      `SELECT v.id, v.lifecycle,
              (SELECT count(*)::int FROM ingestion_jobs j WHERE j.version_id = v.id) AS jobs
         FROM document_versions v
         JOIN tender_documents d ON d.id = v.document_id
        WHERE d.tender_id = $1`,
      [tenderId],
    );
    expect(pending.lifecycle).toBe('pending');
    expect(pending.jobs).toBe(0);
    const versionId: string = pending.id;

    // Barrier 1: both requests read the pending version before either goes on.
    const originalFind = internals.findRetryInTender.bind(service);
    let arrived = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => (release = resolve));
    jest.spyOn(internals, 'findRetryInTender').mockImplementation(async (...args) => {
      const found = await originalFind(...args);
      arrived += 1;
      if (arrived === 2) release();
      await bothRead;
      return found;
    });

    // Barrier 2: the first request through proceeds; the second is held until
    // the worker has finished the version, then promotes from stale state.
    const originalRestore = internals.restoreObjectIfMissing.bind(service);
    let restoreCalls = 0;
    jest.spyOn(internals, 'restoreObjectIfMissing').mockImplementation(async (...args) => {
      restoreCalls += 1;
      if (restoreCalls === 2) {
        await waitUntil(
          async () => (await lifecycleOf(versionId)) === 'processed',
          'worker never finished the version the first request promoted',
        );
      }
      return originalRestore(...args);
    });

    // Watch the lifecycle for the whole interleaving, so a regression that is
    // later repaired by something else would still be seen.
    const seen: string[] = [];
    let watching = true;
    const watcher = (async () => {
      while (watching) {
        const state = await lifecycleOf(versionId);
        if (seen[seen.length - 1] !== state) seen.push(state);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    })();

    const results = await Promise.all([ingest(bytes), ingest(bytes)]);

    // Let the second request's transaction settle and be observed.
    await new Promise((resolve) => setTimeout(resolve, 300));
    watching = false;
    await watcher;

    // Never `queued` after `processed`.
    const firstProcessed = seen.indexOf('processed');
    expect(firstProcessed).toBeGreaterThanOrEqual(0);
    expect(seen.slice(firstProcessed)).toEqual(['processed']);
    expect(await lifecycleOf(versionId)).toBe('processed');

    // One request performed the transition; the other reported what is stored.
    const lifecycles = results.map((r) => r.body.lifecycle).sort();
    expect(lifecycles).toEqual(['processed', 'queued']);
    expect(results.every((r) => r.body.versionId === versionId)).toBe(true);

    // One ledger row, completed by one attempt.
    const ledger = await dataSource.query(
      'SELECT state, attempt FROM ingestion_jobs WHERE version_id = $1',
      [versionId],
    );
    expect(ledger).toEqual([{ state: 'completed', attempt: 1 }]);

    // One extraction, and the slot points at the version.
    const [extractions] = await dataSource.query(
      'SELECT count(*)::int AS n FROM document_extractions WHERE version_id = $1',
      [versionId],
    );
    expect(extractions.n).toBe(1);
    const [slot] = await dataSource.query(
      `SELECT d.current_version_id FROM tender_documents d
         JOIN document_versions v ON v.document_id = d.id WHERE v.id = $1`,
      [versionId],
    );
    expect(slot.current_version_id).toBe(versionId);
  }, 90_000);

  it('answers repeated recovery with the persisted state and reprocesses nothing', async () => {
    const [version] = await dataSource.query(
      `SELECT v.id FROM document_versions v
         JOIN tender_documents d ON d.id = v.document_id
        WHERE d.tender_id = $1`,
      [tenderId],
    );
    const before = await dataSource.query(
      'SELECT state, attempt, finished_at FROM ingestion_jobs WHERE version_id = $1',
      [version.id],
    );

    // The same upload again, after the work is finished.
    const { buffer } = await readStoredFixture(dataSource, version.id);
    const again = await ingest(buffer);

    expect(again.body.versionId).toBe(version.id);
    expect(again.body.lifecycle).toBe('processed');
    expect(again.body.deduplicated).toBe(true);

    const after = await dataSource.query(
      'SELECT state, attempt, finished_at FROM ingestion_jobs WHERE version_id = $1',
      [version.id],
    );
    expect(after).toEqual(before);
    expect(await lifecycleOf(version.id)).toBe('processed');
  }, 30_000);
});

/** Re-read the bytes that were stored, so the repeat upload is byte-identical. */
async function readStoredFixture(
  dataSource: DataSource,
  versionId: string,
): Promise<{ buffer: Buffer }> {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const [row] = await dataSource.query(
    'SELECT storage_bucket, storage_key FROM document_versions WHERE id = $1',
    [versionId],
  );
  return {
    buffer: await readFile(
      join(process.env.STORAGE_LOCAL_ROOT as string, row.storage_bucket, row.storage_key),
    ),
  };
}
