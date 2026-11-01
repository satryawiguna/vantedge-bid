import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { buildPdf } from '../helpers/pdf-fixture';

/**
 * Slot allocation, version ordering and idempotency ownership under real
 * concurrency — overlapping requests against one database, not sequential
 * calls dressed up as parallel ones.
 */
const describeIfServices =
  process.env.DATABASE_URL && process.env.REDIS_URL ? describe : describe.skip;

describeIfServices('concurrency and ownership', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;

  const orgId = randomUUID();
  const runId = randomUUID();
  const storageRoot = `/tmp/vantedge-conc-${runId}`;
  let tenderId: string;

  const pdf = (marker: string) =>
    buildPdf([
      'SERTIFIKAT KOMPETENSI KERJA',
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

    await dataSource.query(
      `INSERT INTO organizations (id, slug, name, npwp)
       VALUES ($1, $2, 'PT Karya Bali Mandiri', '012345678901234')`,
      [orgId, `conc-${runId.slice(0, 8)}`],
    );
    tenderId = randomUUID();
    await dataSource.query(
      `INSERT INTO tenders
         (id, organization_id, tender_code, title, buyer_name, required_sbu_codes,
          estimated_value, submission_deadline, status)
       VALUES ($1, $2, $3, 'Pembangunan Gedung', 'Dinas PU', ARRAY['BG009'],
               15000000000.00, $4, 'preparing')`,
      [tenderId, orgId, `LPSE-C-${runId.slice(0, 8)}`, new Date(Date.now() + 45 * 86_400_000).toISOString()],
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

  describe('logical document identity', () => {
    it('keeps two key personnel apart even when their certificates are identical', async () => {
      // Two people can hold byte-identical certificates. Treating the checksum
      // as proof of "same submission" loses one person's qualification — and
      // for a multi-instance type the hash proves nothing about identity.
      const shared = pdf(`IDENTICAL-SKK-${runId}`);

      const first = await upload('SKK_PERSONIL', shared).expect(202);
      const second = await upload('SKK_PERSONIL', shared).expect(202);

      expect(second.body.deduplicated).toBe(false);
      expect(second.body.documentId).not.toBe(first.body.documentId);
      expect(second.body.versionId).not.toBe(first.body.versionId);

      // Two logical documents, one stored object.
      const keys = await dataSource.query(
        'SELECT DISTINCT storage_key FROM document_versions WHERE id = ANY($1)',
        [[first.body.versionId, second.body.versionId]],
      );
      expect(keys).toHaveLength(1);
    });

    it('still collapses a repeat of a single-instance type', async () => {
      // A tender holds one SBU, so identical content can only be the same
      // document arriving twice.
      const bytes = pdf(`SINGLE-${runId}`);
      const first = await upload('SBU', bytes).expect(202);
      const repeat = await upload('SBU', bytes).expect(202);

      expect(repeat.body.deduplicated).toBe(true);
      expect(repeat.body.versionId).toBe(first.body.versionId);
    });

    it('collapses a repeated request on a multi-instance type when a key says so', async () => {
      // The Idempotency-Key is what identifies a repeated HTTP request, which
      // is the job the checksum cannot do here.
      const key = randomUUID();
      const bytes = pdf(`KEYED-SKK-${runId}`);

      const first = await upload('SKK_PERSONIL', bytes, key).expect(202);
      const retry = await upload('SKK_PERSONIL', bytes, key).expect(202);

      expect(retry.headers['idempotent-replay']).toBe('true');
      expect(retry.body.documentId).toBe(first.body.documentId);
    });
  });

  describe('slot allocation under concurrency', () => {
    it('gives concurrent uploads of a multi-instance type their own slots', async () => {
      // Overlapping requests both look for an empty slot. A row lock cannot
      // help — the contended case is an empty result — so without an advisory
      // lock both would take the same slot and the second certificate would be
      // filed as a correction of the first.
      const bodies = Array.from({ length: 6 }, (_, i) => pdf(`CONC-SKK-${runId}-${i}`));
      const responses = await Promise.all(bodies.map((b) => upload('SKK_PERSONIL', b)));

      expect(responses.every((r) => r.status === 202)).toBe(true);

      const documentIds = responses.map((r) => r.body.documentId);
      expect(new Set(documentIds).size).toBe(documentIds.length);

      // Every slot holds exactly one version: nothing was filed as a revision
      // of someone else's certificate.
      const rows = await dataSource.query(
        `SELECT document_id, count(*)::int AS versions
           FROM document_versions WHERE document_id = ANY($1)
          GROUP BY document_id`,
        [documentIds],
      );
      expect(rows.every((r: { versions: number }) => r.versions === 1)).toBe(true);
    });

    it('serialises concurrent uploads into one single-instance slot', async () => {
      const bodies = Array.from({ length: 4 }, (_, i) => pdf(`CONC-RKK-${runId}-${i}`));
      const responses = await Promise.all(bodies.map((b) => upload('RKK', b)));

      expect(responses.every((r) => r.status === 202)).toBe(true);

      // One slot, contiguous version numbers, no collision on the unique index.
      const documentIds = new Set(responses.map((r) => r.body.documentId));
      expect(documentIds.size).toBe(1);

      const versions = await dataSource.query(
        'SELECT version_no FROM document_versions WHERE document_id = $1 ORDER BY version_no',
        [[...documentIds][0]],
      );
      expect(versions.map((v: { version_no: number }) => v.version_no)).toEqual([1, 2, 3, 4]);
    });
  });

  describe('current version ordering', () => {
    it('does not let an older upload reclaim the pointer', async () => {
      // Storage completion order is not request order. An unconditional update
      // walks the slot back to the superseded file, which is then what the
      // compliance engine evaluates.
      const first = await upload('METODE_PELAKSANAAN', pdf(`ORDER-1-${runId}`)).expect(202);
      const slotId: string = first.body.documentId;

      const second = await request(app.getHttpServer())
        .post(`/v1/tenders/${tenderId}/documents`)
        .set('X-Organization-Id', orgId)
        .field('documentTypeCode', 'METODE_PELAKSANAAN')
        .field('documentId', slotId)
        .attach('file', pdf(`ORDER-2-${runId}`), {
          filename: 'v2.pdf',
          contentType: 'application/pdf',
        })
        .expect(202);

      expect(second.body.versionNo).toBe(2);

      const [before] = await dataSource.query(
        'SELECT current_version_id FROM tender_documents WHERE id = $1',
        [slotId],
      );
      expect(before.current_version_id).toBe(second.body.versionId);

      // Replay version 1's promotion, as a straggler finishing late would.
      await dataSource.query("UPDATE document_versions SET lifecycle = 'pending' WHERE id = $1", [
        first.body.versionId,
      ]);
      await request(app.getHttpServer())
        .post(`/v1/tenders/${tenderId}/documents`)
        .set('X-Organization-Id', orgId)
        .field('documentTypeCode', 'METODE_PELAKSANAAN')
        .field('documentId', slotId)
        .attach('file', pdf(`ORDER-1-${runId}`), {
          filename: 'v1.pdf',
          contentType: 'application/pdf',
        })
        .expect(202);

      const [after] = await dataSource.query(
        'SELECT current_version_id FROM tender_documents WHERE id = $1',
        [slotId],
      );
      expect(after.current_version_id).toBe(second.body.versionId);
    });
  });

  /**
   * The HTTP tests above establish the *behaviour* — one slot for a
   * single-instance type, distinct slots for a multi-instance one — but they do
   * not prove the mechanism that holds under contention. Most of each request's
   * time goes on synchronous work before the transaction opens (reading the
   * body, hashing, parsing the PDF), and that work blocks the event loop, so
   * one request routinely finishes its whole transaction before the next
   * handler is scheduled. Removing the advisory lock leaves those tests green.
   *
   * Racing `resolveDocumentSlot` from two transactions does not settle it
   * either: whether the overlap lands on the critical instant varies between
   * runs, so the test passes against broken code often enough to be worthless.
   * A flaky witness is worse than none.
   *
   * What *is* deterministic is asking whether the lock is held. From a second
   * connection, `pg_try_advisory_xact_lock` answers immediately and never
   * blocks, so the assertion is exact: while a slot is being allocated the lock
   * on that (tender, document type) is unavailable to anyone else, and once the
   * transaction ends it is free again.
   */
  describe('slot allocation takes an advisory lock on (tender, document type)', () => {
    type SlotInternals = {
      resolveDocumentSlot(
        manager: unknown,
        params: {
          context: { organizationId: string };
          tender: { id: string };
          dto: Record<string, unknown>;
          documentType: {
            code: string;
            name: string;
            allowsMultiple: boolean;
            isMandatoryDefault: boolean;
          };
        },
      ): Promise<{ id: string }>;
    };

    it('holds it for the duration of the transaction and releases it after', async () => {
      const { DocumentsService } = jest.requireActual<{
        DocumentsService: new (...args: never[]) => unknown;
      }>('../../src/modules/documents/documents.service');
      const service = moduleRef.get(DocumentsService as never, { strict: false }) as SlotInternals;

      const typeCode = 'NPWP';
      const [row] = await dataSource.query(
        'SELECT code, name, allows_multiple, is_mandatory_default FROM document_types WHERE code = $1',
        [typeCode],
      );
      const documentType = {
        code: row.code,
        name: row.name,
        allowsMultiple: row.allows_multiple,
        isMandatoryDefault: row.is_mandatory_default,
      };

      // The key the service derives. Spelled out here on purpose: a lock taken
      // on a different key would serialise the wrong thing while looking right.
      const lockKey = `slot:${tenderId}:${typeCode}`;

      /** Can a different session take this lock right now? */
      const probe = dataSource.createQueryRunner();
      await probe.connect();
      const lockIsFree = async (): Promise<boolean> => {
        await probe.startTransaction();
        try {
          const [result] = await probe.query(
            'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS got',
            [lockKey],
          );
          return result.got === true;
        } finally {
          await probe.rollbackTransaction();
        }
      };

      expect(await lockIsFree()).toBe(true);

      let freeDuringAllocation: boolean | undefined;
      await dataSource.transaction(async (manager) => {
        await service.resolveDocumentSlot(manager, {
          context: { organizationId: orgId },
          tender: { id: tenderId },
          dto: {},
          documentType,
        });
        freeDuringAllocation = await lockIsFree();
      });

      // Held while the allocating transaction is open...
      expect(freeDuringAllocation).toBe(false);
      // ...and released by the commit, not left behind for the next request.
      expect(await lockIsFree()).toBe(true);

      await probe.release();
    });
  });

  describe('idempotency claim ownership', () => {
    const endpoint = 'POST /v1/tenders/:tenderId/documents';

    const claimRow = async (key: string) => {
      const [row] = await dataSource.query(
        'SELECT owner_token, response_body FROM idempotency_keys WHERE organization_id = $1 AND key = $2',
        [orgId, key],
      );
      return row;
    };

    /**
     * Driven through the service's own claim methods, not through SQL retyped
     * in the test.
     *
     * The distinction is not pedantic. An earlier version of this test issued
     * the `WHERE … owner_token = $3` statements itself, which only ever proved
     * that Postgres honours an equality predicate. Removing the ownership
     * condition from `completeClaim` and `releaseClaim` left the whole suite
     * green. The behaviour under test belongs to the service, so the service is
     * what has to be called.
     *
     * These three are private, and reaching them is deliberate: they are the
     * narrowest surface on which this invariant is expressible. Going through
     * HTTP would require killing a request mid-flight at an exact instant.
     */
    type ClaimInternals = {
      claimIdempotencyKey(params: {
        organizationId: string;
        key: string;
        requestHash: string;
      }): Promise<{ outcome: 'claimed'; token: string } | { outcome: 'replay'; body: unknown }>;
      completeClaim(
        organizationId: string,
        key: string,
        token: string,
        body: unknown,
      ): Promise<void>;
      releaseClaim(organizationId: string, key: string, token: string): Promise<void>;
    };

    const internals = (): ClaimInternals => {
      const { DocumentsService } = jest.requireActual<{
        DocumentsService: new (...args: never[]) => unknown;
      }>('../../src/modules/documents/documents.service');
      return moduleRef.get(DocumentsService as never, { strict: false }) as ClaimInternals;
    };

    it('mints a new owner on takeover and locks the old one out', async () => {
      const service = internals();
      const key = randomUUID();
      const requestHash = 'a'.repeat(64);

      // An abandoned claim, past its lease: a request that died in flight.
      await dataSource.query(
        `INSERT INTO idempotency_keys (organization_id, key, endpoint, request_hash, owner_token, created_at)
         VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour')`,
        [orgId, key, endpoint, requestHash, randomUUID()],
      );
      const staleToken = (await claimRow(key)).owner_token;

      // The same request retries and takes the claim over.
      const takeover = await service.claimIdempotencyKey({
        organizationId: orgId,
        key,
        requestHash,
      });
      expect(takeover.outcome).toBe('claimed');
      const currentToken = (takeover as { token: string }).token;
      expect(currentToken).not.toBe(staleToken);
      expect((await claimRow(key)).owner_token).toBe(currentToken);

      // Now the original process turns out to have been slow, not dead, and
      // finishes. Its release must not remove the claim its successor holds —
      // that would free the key under a request still in flight.
      await service.releaseClaim(orgId, key, staleToken);
      expect(await claimRow(key)).toBeDefined();

      // Nor may it record its own response under that claim: the next retry
      // would then be handed an answer describing a different upload.
      await service.completeClaim(orgId, key, staleToken, { stolen: true });
      expect((await claimRow(key)).response_body).toBeNull();

      // The owner can do both of the things the impostor could not.
      await service.completeClaim(orgId, key, currentToken, { ok: true });
      expect((await claimRow(key)).response_body).toEqual({ ok: true });
    });

    it('lets the rightful owner release a claim it still holds', async () => {
      const service = internals();
      const key = randomUUID();
      const requestHash = 'c'.repeat(64);

      const claim = await service.claimIdempotencyKey({
        organizationId: orgId,
        key,
        requestHash,
      });
      expect(claim.outcome).toBe('claimed');

      // A failed attempt frees the key for the corrected upload rather than
      // locking it for a day — the point of releasing at all.
      await service.releaseClaim(orgId, key, (claim as { token: string }).token);
      expect(await claimRow(key)).toBeUndefined();
    });

    it('lets exactly one of several concurrent takeovers win', async () => {
      const key = randomUUID();
      const hash = 'b'.repeat(64);

      await dataSource.query(
        `INSERT INTO idempotency_keys (organization_id, key, endpoint, request_hash, owner_token, created_at)
         VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour')`,
        [orgId, key, endpoint, hash, randomUUID()],
      );

      // Six simultaneous takeovers of the same stale claim.
      const tokens = Array.from({ length: 6 }, () => randomUUID());
      const results = await Promise.all(
        tokens.map((token) =>
          dataSource.query(
            `INSERT INTO idempotency_keys (organization_id, key, endpoint, request_hash, owner_token)
                  VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (organization_id, key) DO UPDATE
                     SET owner_token = EXCLUDED.owner_token, created_at = now()
                   WHERE idempotency_keys.response_body IS NULL
                     AND idempotency_keys.created_at <= now() - interval '1 minute'
                     AND idempotency_keys.request_hash = EXCLUDED.request_hash
               RETURNING owner_token`,
            [orgId, key, endpoint, hash, token],
          ),
        ),
      );

      const winners = results.filter((r) => (r as unknown[]).length > 0);
      expect(winners).toHaveLength(1);

      // And the row belongs to that winner alone.
      const row = await claimRow(key);
      expect(row.owner_token).toBe((winners[0] as Array<{ owner_token: string }>)[0].owner_token);
    });

    it('still refuses a different request, stale or not', async () => {
      const key = randomUUID();
      await dataSource.query(
        `INSERT INTO idempotency_keys (organization_id, key, endpoint, request_hash, owner_token, created_at)
         VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour')`,
        [orgId, key, endpoint, 'c'.repeat(64), randomUUID()],
      );

      const response = await upload('AHSP', pdf(`DIFFERENT-${runId}`), key).expect(409);
      expect(response.body.code).toBe('idempotency_key_reused');
    });
  });
});
