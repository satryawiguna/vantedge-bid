import 'reflect-metadata';

/**
 * The real application module must refuse to start — not merely hide the route —
 * when production is combined with demo mode.
 *
 * `ConfigModule.forRoot()` is async: AppModule declares the *promise* of the
 * configured module in its `imports`, and Nest awaits it while booting. So the
 * thing to assert on is exactly that promise, taken from AppModule's own
 * metadata. A rejection here is what makes NestFactory.create() fail at start-up.
 * Each load uses a fresh module registry so the environment is read anew.
 */
describe('application start-up configuration', () => {
  const saved = { ...process.env };

  const configuredModuleOf = (): Promise<unknown> => {
    let appModule: { AppModule: object } | undefined;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      appModule = require('../../src/app.module');
    });
    const imports = Reflect.getMetadata('imports', appModule!.AppModule) as unknown[];
    return imports[0] as Promise<unknown>;
  };

  const baseline = () => {
    process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.STORAGE_DRIVER = 'local';
  };

  afterEach(() => {
    process.env = { ...saved };
  });

  it('refuses to start with NODE_ENV=production and DEMO_MODE=true', async () => {
    baseline();
    process.env.NODE_ENV = 'production';
    process.env.DEMO_MODE = 'true';

    await expect(configuredModuleOf()).rejects.toThrow(
      /DEMO_MODE=true is not allowed when NODE_ENV=production/,
    );
  });

  it('starts under production when demo mode is omitted (disabled by default)', async () => {
    baseline();
    process.env.NODE_ENV = 'production';
    delete process.env.DEMO_MODE;

    await expect(configuredModuleOf()).resolves.toBeDefined();
  });

  it('starts under development with DEMO_MODE=true', async () => {
    baseline();
    process.env.NODE_ENV = 'development';
    process.env.DEMO_MODE = 'true';

    await expect(configuredModuleOf()).resolves.toBeDefined();
  });
});
