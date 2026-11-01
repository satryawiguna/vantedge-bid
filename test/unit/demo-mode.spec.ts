import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import {
  isDemoModeEnabled,
  parseDemoMode,
  resolveDemoMode,
} from '../../src/config/demo-mode';
import { validateEnv } from '../../src/config/env.validation';
import { DemoModeGuard } from '../../src/modules/demo/demo-mode.guard';
import { DemoService } from '../../src/modules/demo/demo.service';

const baseEnv = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  STORAGE_DRIVER: 'local',
};

describe('demo mode configuration', () => {
  describe('parseDemoMode', () => {
    it.each([undefined, null, '', '   ', 'false', 'FALSE'])('is off for %p', (value) => {
      expect(parseDemoMode(value)).toBe(false);
    });

    it.each(['true', 'TRUE', ' True '])('is on for %p', (value) => {
      expect(parseDemoMode(value)).toBe(true);
    });

    it.each(['yes', '1', 'on', 'enabled', 'tru'])('rejects the ambiguous value %p', (value) => {
      expect(() => parseDemoMode(value)).toThrow(/DEMO_MODE must be "true" or "false"/);
    });
  });

  describe('resolveDemoMode', () => {
    it('is disabled by default when the variable is omitted, in any environment', () => {
      for (const NODE_ENV of ['development', 'test', 'demo', 'production', undefined]) {
        expect(resolveDemoMode({ NODE_ENV })).toBe(false);
      }
    });

    it.each(['development', 'test', 'demo'])('allows DEMO_MODE=true under NODE_ENV=%s', (NODE_ENV) => {
      expect(resolveDemoMode({ NODE_ENV, DEMO_MODE: 'true' })).toBe(true);
    });

    it('rejects DEMO_MODE=true under NODE_ENV=production', () => {
      expect(() => resolveDemoMode({ NODE_ENV: 'production', DEMO_MODE: 'true' })).toThrow(
        /not allowed when NODE_ENV=production/,
      );
      expect(() => resolveDemoMode({ NODE_ENV: ' Production ', DEMO_MODE: 'TRUE' })).toThrow(
        /not allowed when NODE_ENV=production/,
      );
    });

    it('fails closed when NODE_ENV is missing or unrecognised', () => {
      expect(() => resolveDemoMode({ DEMO_MODE: 'true' })).toThrow(/requires NODE_ENV/);
      expect(() => resolveDemoMode({ NODE_ENV: 'staging', DEMO_MODE: 'true' })).toThrow(
        /requires NODE_ENV/,
      );
    });

    it('does not complain about production when demo mode is explicitly off', () => {
      expect(resolveDemoMode({ NODE_ENV: 'production', DEMO_MODE: 'false' })).toBe(false);
    });
  });

  describe('isDemoModeEnabled (request path) never throws and fails closed', () => {
    it('is false for production, invalid, missing and unrecognised combinations', () => {
      expect(isDemoModeEnabled({ NODE_ENV: 'production', DEMO_MODE: 'true' })).toBe(false);
      expect(isDemoModeEnabled({ NODE_ENV: 'development', DEMO_MODE: 'maybe' })).toBe(false);
      expect(isDemoModeEnabled({ DEMO_MODE: 'true' })).toBe(false);
      expect(isDemoModeEnabled({})).toBe(false);
    });

    it('is true only for an explicit opt-in in a demo-safe environment', () => {
      expect(isDemoModeEnabled({ NODE_ENV: 'development', DEMO_MODE: 'true' })).toBe(true);
    });
  });

  describe('validateEnv (start-up)', () => {
    it('refuses to start with NODE_ENV=production and DEMO_MODE=true', () => {
      expect(() => validateEnv({ ...baseEnv, NODE_ENV: 'production', DEMO_MODE: 'true' })).toThrow(
        /DEMO_MODE=true is not allowed when NODE_ENV=production/,
      );
    });

    it('refuses an invalid DEMO_MODE value', () => {
      expect(() => validateEnv({ ...baseEnv, NODE_ENV: 'development', DEMO_MODE: 'yes' })).toThrow(
        /DEMO_MODE must be/,
      );
    });

    it('starts with demo mode omitted, including in production', () => {
      expect(() => validateEnv({ ...baseEnv, NODE_ENV: 'production' })).not.toThrow();
      expect(() => validateEnv({ ...baseEnv, NODE_ENV: 'development' })).not.toThrow();
    });

    it('starts with DEMO_MODE=true under development', () => {
      expect(() =>
        validateEnv({ ...baseEnv, NODE_ENV: 'development', DEMO_MODE: 'true' }),
      ).not.toThrow();
    });

    it('still reports missing required variables', () => {
      expect(() => validateEnv({ NODE_ENV: 'development', STORAGE_DRIVER: 'local' })).toThrow(
        /DATABASE_URL, REDIS_URL/,
      );
    });
  });
});

describe('DemoModeGuard', () => {
  const guardWith = (demoEnabled: unknown) =>
    new DemoModeGuard({ get: (_key: string, fallback?: unknown) => demoEnabled ?? fallback } as unknown as ConfigService);

  const saved = { NODE_ENV: process.env.NODE_ENV, DEMO_MODE: process.env.DEMO_MODE };
  afterEach(() => {
    process.env.NODE_ENV = saved.NODE_ENV;
    if (saved.DEMO_MODE === undefined) delete process.env.DEMO_MODE;
    else process.env.DEMO_MODE = saved.DEMO_MODE;
  });

  it('lets the request through only when configured on and still demo-safe', () => {
    process.env.NODE_ENV = 'development';
    process.env.DEMO_MODE = 'true';
    expect(guardWith(true).canActivate()).toBe(true);
  });

  it('answers 404 when the flag is off or missing from config', () => {
    process.env.NODE_ENV = 'development';
    process.env.DEMO_MODE = 'true';
    expect(() => guardWith(false).canActivate()).toThrow(NotFoundException);
    expect(() => guardWith(undefined).canActivate()).toThrow(NotFoundException);
  });

  it('answers 404 under production even if the config flag was somehow true', () => {
    process.env.NODE_ENV = 'production';
    process.env.DEMO_MODE = 'true';
    expect(() => guardWith(true).canActivate()).toThrow(NotFoundException);
  });
});

describe('DemoService response shaping', () => {
  it('returns an empty list with total 0 and the requested paging for an empty table', async () => {
    const findAndCount = jest.fn().mockResolvedValue([[], 0]);
    const dataSource = { getRepository: () => ({ findAndCount }) } as unknown as DataSource;

    const result = await new DemoService(dataSource).listOrganizations({ limit: 50, offset: 0 });

    expect(result).toEqual({ data: [], pagination: { total: 0, limit: 50, offset: 0 } });
    // Only the four exposed columns are requested, ordered deterministically.
    expect(findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({
        select: { id: true, slug: true, name: true, createdAt: true },
        order: { createdAt: 'DESC', id: 'DESC' },
        take: 50,
        skip: 0,
      }),
    );
  });

  it('copies only the four allowed fields even if the row carries more', async () => {
    const row = {
      id: 'id-1',
      slug: 's',
      name: 'N',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      npwp: '012345678901234',
      nib: '1234567890123',
    };
    const dataSource = {
      getRepository: () => ({ findAndCount: jest.fn().mockResolvedValue([[row], 1]) }),
    } as unknown as DataSource;

    const { data } = await new DemoService(dataSource).listOrganizations({ limit: 10, offset: 0 });

    expect(Object.keys(data[0]).sort()).toEqual(['createdAt', 'id', 'name', 'slug']);
  });
});
