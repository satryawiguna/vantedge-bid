import { DataSource } from 'typeorm';
import { ENTITIES } from '../../src/database/entities';
import { buildDataSourceOptions } from '../../src/database/data-source';

/**
 * Schema drift guard.
 *
 * The schema is owned by the SQL migrations and the entities are a hand-written
 * mapping over it (ADR 0001), so the two can fall out of step: a column renamed
 * in a migration and not in its entity fails at runtime, on whichever endpoint
 * happens to touch it first.
 *
 * Selecting one row through every entity makes TypeORM emit every mapped column
 * name against the real schema. A mismatch fails here instead of in production.
 *
 * Requires a migrated database; skipped when DATABASE_URL is unset so the unit
 * suite stays runnable with no services.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDatabase('schema drift', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = new DataSource(buildDataSourceOptions(process.env.DATABASE_URL!, 2));
    await dataSource.initialize();
  }, 30_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it.each(ENTITIES.map((entity) => [entity.name, entity] as const))(
    '%s maps onto the migrated schema',
    async (_name, entity) => {
      await expect(dataSource.getRepository(entity).find({ take: 1 })).resolves.toBeDefined();
    },
  );

  it('has applied every migration in db/migrations', async () => {
    const rows = await dataSource.query<Array<{ filename: string }>>(
      'SELECT filename FROM schema_migrations ORDER BY filename',
    );
    expect(rows.map((row) => row.filename)).toEqual([
      '001_init_schema.sql',
      '002_seed_reference_data.sql',
    ]);
  });

  it('seeded a compliance rule for every evaluator the registry exposes', async () => {
    // The other half of the rules-as-data trade (ADR 0003): a rule naming an
    // evaluator the build does not have degrades to `inconclusive` at runtime.
    // Catching it here makes that a build failure instead.
    const { EvaluatorRegistry } = await import(
      '../../src/modules/compliance/evaluators/evaluator.registry'
    );
    const known = new Set(new EvaluatorRegistry().keys());

    const rows = await dataSource.query<Array<{ evaluator: string }>>(
      'SELECT DISTINCT evaluator FROM compliance_rules',
    );
    const unknown = rows.map((row) => row.evaluator).filter((key) => !known.has(key));

    expect(unknown).toEqual([]);
  });
});
