import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { randomUUID } from 'node:crypto';

/**
 * GET /v1/demo/organizations with demo mode ON (NODE_ENV=test, DEMO_MODE=true).
 *
 * Real HTTP, real validation pipe, real PostgreSQL. The table may hold other
 * rows, so the suite creates its own organisations dated far in the future
 * (they sort first under created_at DESC) and asserts on those, never on the
 * table being empty. Deleting everything to prove emptiness would be destructive
 * on a developer's database; the empty-table shape is covered at service level.
 */
const describeIfServices =
  process.env.DATABASE_URL && process.env.REDIS_URL ? describe : describe.skip;

describeIfServices('demo organization directory (demo mode enabled)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;

  const runId = randomUUID().slice(0, 8);
  const NPWP = '098765432109876';
  const NIB = '9988776655443';

  // Two share a timestamp, to exercise the id tie-breaker. They are inserted
  // lower id first, so heap/insertion order is the opposite of the expected
  // (id DESC) order: without the tie-breaker the ordering assertions fail every
  // time rather than half the time.
  const [tieA, tieB] = [randomUUID(), randomUUID()].sort();
  const second = randomUUID();
  const third = randomUUID();
  const fourth = randomUUID();
  const ownIds = [tieA, tieB, second, third, fourth];
  const expectedOrder = [...[tieA, tieB].sort().reverse(), second, third, fourth];

  const insert = (id: string, label: string, createdAt: string) =>
    dataSource.query(
      `INSERT INTO organizations (id, slug, name, npwp, nib, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, `demo-${runId}-${label}`, `Demo Org ${label}`, NPWP, NIB, createdAt],
    );

  const get = (query = '') => request(app.getHttpServer()).get(`/v1/demo/organizations${query}`);

  beforeAll(async () => {
    process.env.STORAGE_DRIVER = 'local';
    process.env.INGESTION_RECONCILE_INTERVAL_MS = '0';
    process.env.NODE_ENV = 'test';
    process.env.DEMO_MODE = 'true';

    const { AppModule } = await import('../../src/app.module');
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
        transformOptions: { enableImplicitConversion: false },
      }),
    );
    await app.init();
    dataSource = app.get(DataSource);

    await insert(tieA, 'tie-a', '2100-01-04T00:00:00Z');
    await insert(tieB, 'tie-b', '2100-01-04T00:00:00Z');
    await insert(second, 'second', '2100-01-03T00:00:00Z');
    await insert(third, 'third', '2100-01-02T00:00:00Z');
    await insert(fourth, 'fourth', '2100-01-01T00:00:00Z');
  }, 60_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM organizations WHERE id = ANY($1)', [ownIds]);
    }
    await app?.close();
  }, 30_000);

  it('returns 200 without any X-Organization-Id and lists the organizations', async () => {
    const response = await get().expect(200);

    const ids = response.body.data.map((o: { id: string }) => o.id);
    expect(ids.slice(0, 5)).toEqual(expectedOrder);
    expect(response.body.pagination).toEqual({
      total: expect.any(Number),
      limit: 50,
      offset: 0,
    });
  });

  it('exposes only id, slug, name and createdAt', async () => {
    const response = await get('?limit=5').expect(200);

    for (const item of response.body.data) {
      expect(Object.keys(item).sort()).toEqual(['createdAt', 'id', 'name', 'slug']);
    }
    const raw = JSON.stringify(response.body);
    expect(raw).not.toContain(NPWP);
    expect(raw).not.toContain(NIB);
    expect(raw).not.toMatch(/npwp|nib|email|updatedAt/i);
  });

  it('reports the real total independent of the page', async () => {
    const [{ n }] = await dataSource.query('SELECT count(*)::int AS n FROM organizations');
    const response = await get('?limit=1').expect(200);

    expect(response.body.pagination.total).toBe(n);
    expect(response.body.data).toHaveLength(1);
  });

  it('pages deterministically, newest first with id as the tie-breaker', async () => {
    const page1 = await get('?limit=2&offset=0').expect(200);
    const page2 = await get('?limit=2&offset=2').expect(200);
    const page3 = await get('?limit=1&offset=4').expect(200);

    expect(page1.body.data.map((o: { id: string }) => o.id)).toEqual(expectedOrder.slice(0, 2));
    expect(page2.body.data.map((o: { id: string }) => o.id)).toEqual(expectedOrder.slice(2, 4));
    expect(page3.body.data.map((o: { id: string }) => o.id)).toEqual(expectedOrder.slice(4, 5));
    expect(page2.body.pagination).toMatchObject({ limit: 2, offset: 2 });

    // Repeating the request gives the same order, including the tied pair.
    const again = await get('?limit=2&offset=0').expect(200);
    expect(again.body.data).toEqual(page1.body.data);
  });

  it('returns an empty page, still 200, when the offset is past the end', async () => {
    const [{ n }] = await dataSource.query('SELECT count(*)::int AS n FROM organizations');
    const response = await get(`?limit=10&offset=${n + 100}`).expect(200);

    expect(response.body.data).toEqual([]);
    expect(response.body.pagination).toEqual({ total: n, limit: 10, offset: n + 100 });
  });

  it('accepts the maximum limit and rejects anything above it', async () => {
    const atMax = await get('?limit=100').expect(200);
    expect(atMax.body.pagination.limit).toBe(100);
    expect(atMax.body.data.length).toBeLessThanOrEqual(100);

    const over = await get('?limit=101');
    expect(over.status).toBe(400);
    expect(over.body.data).toBeUndefined();
  });

  it.each([
    ['limit=0'],
    ['limit=-5'],
    ['limit=abc'],
    ['limit=2.5'],
    ['offset=-1'],
    ['offset=abc'],
    ['unexpected=1'],
  ])('rejects invalid query "%s" with 400', async (query) => {
    const response = await get(`?${query}`);

    expect(response.status).toBe(400);
    expect(response.body.data).toBeUndefined();
  });

  it('is read-only: no write verbs are routed', async () => {
    for (const verb of ['post', 'put', 'patch', 'delete'] as const) {
      const response = await request(app.getHttpServer())[verb]('/v1/demo/organizations');
      expect(response.status).toBe(404);
    }
    const [{ n }] = await dataSource.query(
      'SELECT count(*)::int AS n FROM organizations WHERE id = ANY($1)',
      [ownIds],
    );
    expect(n).toBe(ownIds.length);
  });

  it('leaves the tenant-scoped endpoints exactly as they were', async () => {
    // Still requires the header...
    await request(app.getHttpServer()).get('/v1/tenders').expect(400);
    // ...and still works with it, scoped to that organisation.
    const response = await request(app.getHttpServer())
      .get('/v1/tenders')
      .set('X-Organization-Id', tieA)
      .expect(200);
    expect(response.body).toEqual([]);
  });
});
