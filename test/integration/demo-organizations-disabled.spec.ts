import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { randomUUID } from 'node:crypto';

/**
 * GET /v1/demo/organizations with demo mode OFF — the default.
 *
 * DEMO_MODE is deliberately left unset: that is the configuration a deployment
 * gets without doing anything, and it must be the safe one.
 */
const describeIfServices =
  process.env.DATABASE_URL && process.env.REDIS_URL ? describe : describe.skip;

describeIfServices('demo organization directory (demo mode disabled by default)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let dataSource: DataSource;

  const orgId = randomUUID();
  const orgName = `Hidden Org ${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    process.env.STORAGE_DRIVER = 'local';
    process.env.INGESTION_RECONCILE_INTERVAL_MS = '0';
    process.env.NODE_ENV = 'test';
    delete process.env.DEMO_MODE;

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
      `INSERT INTO organizations (id, slug, name, npwp) VALUES ($1, $2, $3, '012345678901234')`,
      [orgId, `hidden-${orgId.slice(0, 8)}`, orgName],
    );
  }, 60_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM organizations WHERE id = $1', [orgId]);
    }
    await app?.close();
  }, 30_000);

  it('answers 404 and exposes no organization data', async () => {
    const response = await request(app.getHttpServer()).get('/v1/demo/organizations');

    expect(response.status).toBe(404);
    const raw = JSON.stringify(response.body);
    expect(raw).not.toContain(orgId);
    expect(raw).not.toContain(orgName);
    expect(response.body.data).toBeUndefined();
  });

  it('answers the same way as a route that does not exist', async () => {
    const disabled = await request(app.getHttpServer()).get('/v1/demo/organizations');
    const missing = await request(app.getHttpServer()).get('/v1/demo/definitely-not-a-route');

    expect(disabled.status).toBe(missing.status);
    expect(disabled.body.code).toBe(missing.body.code);
    expect(disabled.body.title).toBe(missing.body.title);
  });

  it('is also closed when pagination parameters are supplied', async () => {
    await request(app.getHttpServer()).get('/v1/demo/organizations?limit=100&offset=0').expect(404);
  });

  it('does not affect the existing tenant-scoped endpoints', async () => {
    await request(app.getHttpServer())
      .get('/v1/tenders')
      .set('X-Organization-Id', orgId)
      .expect(200);
    await request(app.getHttpServer()).get('/v1/document-types').expect(200);
    await request(app.getHttpServer()).get('/healthz').expect(200);
  });
});
