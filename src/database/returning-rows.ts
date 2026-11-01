/**
 * Normalise what TypeORM's `query()` hands back for a `RETURNING` clause.
 *
 * The shape depends on the statement, which is a quiet trap:
 *
 *   SELECT … / INSERT … RETURNING   -> rows[]
 *   UPDATE … RETURNING              -> [rows[], affectedCount]
 *   DELETE … RETURNING              -> [rows[], affectedCount]
 *
 * So `result.length === 0` reads as "nothing matched" for an INSERT and is
 * **always false** for an UPDATE, where the tuple has length 2 whether or not a
 * row was touched. A conditional UPDATE used to decide who won a race —
 * claiming an audit slot, completing an idempotency claim — therefore reported
 * every caller as the winner.
 *
 * This is used wherever the row count, not just the rows, carries meaning.
 */
export function returningRows<T>(result: unknown): T[] {
  if (!Array.isArray(result)) return [];

  // The UPDATE/DELETE tuple: [rows, count].
  if (
    result.length === 2 &&
    Array.isArray(result[0]) &&
    typeof result[1] === 'number'
  ) {
    return result[0] as T[];
  }

  return result as T[];
}

/** True when the statement actually changed a row. */
export function didAffectRow(result: unknown): boolean {
  return returningRows(result).length > 0;
}
