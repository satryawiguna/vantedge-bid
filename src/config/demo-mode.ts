/**
 * Demo mode: a switch for read-only, non-sensitive inspection facilities (today
 * just GET /v1/demo/organizations) meant for local and evaluation environments.
 *
 * It is NOT an authentication or authorisation feature, and it must never be on
 * in a production deployment. The rules are strict and fail closed:
 *
 *  - Off unless DEMO_MODE is exactly "true" (case-insensitive). Omitted or empty
 *    means off.
 *  - Any value other than "true"/"false" is a configuration error, not a guess.
 *  - Turning it on requires an explicit, known non-production NODE_ENV. An unset
 *    NODE_ENV is ambiguous and is refused, as is "production" and anything
 *    unrecognised.
 *
 * `validateEnv` enforces this at start-up; the HTTP guard re-checks the same
 * function on every request, so the protection lives in the execution path and
 * not only in the boot check.
 */
export const DEMO_ALLOWED_ENVIRONMENTS: readonly string[] = ['development', 'test', 'demo'];

/** Parse DEMO_MODE strictly. Throws on anything that is not true/false/unset. */
export function parseDemoMode(raw: unknown): boolean {
  if (raw === undefined || raw === null) return false;
  const value = String(raw).trim().toLowerCase();
  if (value === '') return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`DEMO_MODE must be "true" or "false" (received "${String(raw)}").`);
}

/**
 * Throws when demo mode is requested in an environment where it is not allowed.
 * Returns whether demo mode is enabled when the combination is acceptable.
 */
export function resolveDemoMode(env: { NODE_ENV?: unknown; DEMO_MODE?: unknown }): boolean {
  const requested = parseDemoMode(env.DEMO_MODE);
  if (!requested) return false;

  const nodeEnv = typeof env.NODE_ENV === 'string' ? env.NODE_ENV.trim().toLowerCase() : '';

  if (nodeEnv === 'production') {
    throw new Error(
      'DEMO_MODE=true is not allowed when NODE_ENV=production. ' +
        'Demo mode exposes a directory of organisations and must never run in production.',
    );
  }
  if (!DEMO_ALLOWED_ENVIRONMENTS.includes(nodeEnv)) {
    throw new Error(
      `DEMO_MODE=true requires NODE_ENV to be one of ${DEMO_ALLOWED_ENVIRONMENTS.join(', ')} ` +
        `(received ${nodeEnv === '' ? 'no NODE_ENV' : `"${nodeEnv}"`}).`,
    );
  }
  return true;
}

/**
 * Non-throwing form for the request path: any problem means "disabled".
 * Failing closed here is deliberate — a guard must never fail open.
 */
export function isDemoModeEnabled(env: { NODE_ENV?: unknown; DEMO_MODE?: unknown }): boolean {
  try {
    return resolveDemoMode(env);
  } catch {
    return false;
  }
}
