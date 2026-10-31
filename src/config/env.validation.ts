/**
 * Fail fast on misconfiguration.
 *
 * A service that boots with a missing DATABASE_URL and only discovers it on the
 * first request is harder to operate than one that refuses to start. This runs
 * before the Nest container is built.
 */
const REQUIRED_ALWAYS = ['DATABASE_URL', 'REDIS_URL'] as const;

const REQUIRED_FOR_S3 = [
  'STORAGE_ENDPOINT',
  'STORAGE_BUCKET',
  'STORAGE_ACCESS_KEY_ID',
  'STORAGE_SECRET_ACCESS_KEY',
] as const;

export function validateEnv(env: Record<string, unknown>): Record<string, unknown> {
  const missing: string[] = [];

  for (const key of REQUIRED_ALWAYS) {
    if (!env[key]) missing.push(key);
  }

  if ((env.STORAGE_DRIVER ?? 's3') === 's3') {
    for (const key of REQUIRED_FOR_S3) {
      if (!env[key]) missing.push(key);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        'See .env.example for the full list.',
    );
  }

  return env;
}
