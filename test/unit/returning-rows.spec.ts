import { didAffectRow, returningRows } from '../../src/database/returning-rows';

/**
 * The shape TypeORM returns for a `RETURNING` clause depends on the statement,
 * and the difference is invisible until a conditional UPDATE is used to decide
 * who won a race.
 *
 * `UPDATE … RETURNING` yields `[rows, count]`, so a naive `result.length === 0`
 * is always false — the tuple has length 2 whether or not a row was touched.
 * Every caller then reads itself as the winner. That is precisely how audit
 * coalescing leaked extra jobs: five concurrent requests, five "winners", five
 * published runs.
 */
describe('returningRows', () => {
  it('passes through the plain rows of a SELECT or INSERT', () => {
    expect(returningRows([{ id: 1 }, { id: 2 }])).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('reads an empty INSERT … ON CONFLICT DO NOTHING as no rows', () => {
    expect(returningRows([])).toEqual([]);
    expect(didAffectRow([])).toBe(false);
  });

  it('unwraps the [rows, count] tuple of an UPDATE that matched', () => {
    expect(returningRows([[{ id: 1 }], 1])).toEqual([{ id: 1 }]);
    expect(didAffectRow([[{ id: 1 }], 1])).toBe(true);
  });

  it('reads an UPDATE that matched nothing as no rows', () => {
    // The case the naive check got wrong: length is 2, not 0.
    expect(([[], 0] as unknown[]).length).toBe(2);
    expect(returningRows([[], 0])).toEqual([]);
    expect(didAffectRow([[], 0])).toBe(false);
  });

  it('does not mistake a two-row result for a tuple', () => {
    // Two rows from a SELECT also have length 2; only a trailing number marks
    // the tuple form.
    const rows = [{ id: 1 }, { id: 2 }];
    expect(returningRows(rows)).toEqual(rows);
    expect(didAffectRow(rows)).toBe(true);
  });

  it('tolerates a non-array result', () => {
    expect(returningRows(undefined)).toEqual([]);
    expect(didAffectRow(null)).toBe(false);
  });
});
