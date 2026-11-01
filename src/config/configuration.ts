import { registerAs } from '@nestjs/config';
import { isDemoModeEnabled } from './demo-mode';

const int = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Expected an integer, received "${value}"`);
  }
  return parsed;
};

const bool = (value: string | undefined, fallback: boolean): boolean =>
  value === undefined ? fallback : value.toLowerCase() === 'true';

export const appConfig = registerAs('app', () => ({
  env: process.env.NODE_ENV ?? 'development',
  port: int(process.env.PORT, 3000),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  uploadMaxBytes: int(process.env.UPLOAD_MAX_BYTES, 52_428_800),
  /** Lease on a claimed idempotency key; see DocumentsService.claimLeaseMs. */
  idempotencyClaimLeaseMs: int(process.env.IDEMPOTENCY_CLAIM_LEASE_MS, 120_000),
  /**
   * True only when DEMO_MODE=true in an explicitly non-production environment
   * (see config/demo-mode.ts). Defaults to false and fails closed.
   */
  demoEnabled: isDemoModeEnabled(process.env),
}));

export const databaseConfig = registerAs('database', () => ({
  url: process.env.DATABASE_URL ?? 'postgres://vantedge:vantedge@localhost:5432/vantedge',
  poolSize: int(process.env.DATABASE_POOL_SIZE, 10),
}));

export const queueConfig = registerAs('queue', () => ({
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  ingestionQueueName: process.env.INGESTION_QUEUE_NAME ?? 'document-ingestion',
  concurrency: int(process.env.INGESTION_CONCURRENCY, 5),
  maxAttempts: int(process.env.INGESTION_MAX_ATTEMPTS, 5),
  /** How long a committed-but-unpublished job is left before republishing. */
  reconcileGraceMs: int(process.env.INGESTION_RECONCILE_GRACE_MS, 30_000),
  /** 0 disables the reconciler, which is what the test suite does. */
  reconcileIntervalMs: int(process.env.INGESTION_RECONCILE_INTERVAL_MS, 30_000),
  /** Window in which repeated ingestions collapse into one tender audit. */
  auditDebounceMs: int(process.env.AUDIT_DEBOUNCE_MS, 3_000),
  auditMaxAttempts: int(process.env.AUDIT_MAX_ATTEMPTS, 3),
}));

export const storageConfig = registerAs('storage', () => ({
  driver: (process.env.STORAGE_DRIVER ?? 's3') as 's3' | 'local',
  endpoint: process.env.STORAGE_ENDPOINT,
  region: process.env.STORAGE_REGION ?? 'us-east-1',
  bucket: process.env.STORAGE_BUCKET ?? 'tender-documents',
  accessKeyId: process.env.STORAGE_ACCESS_KEY_ID ?? '',
  secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY ?? '',
  forcePathStyle: bool(process.env.STORAGE_FORCE_PATH_STYLE, true),
  localRoot: process.env.STORAGE_LOCAL_ROOT ?? './.storage',
}));

export const configurations = [appConfig, databaseConfig, queueConfig, storageConfig];
