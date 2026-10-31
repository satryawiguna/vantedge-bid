import { DataSource, DataSourceOptions } from 'typeorm';
import { ENTITIES } from './entities';

/**
 * TypeORM is configured as a mapping layer only.
 *
 * `synchronize` and `migrationsRun` are both false: the schema is owned by the
 * SQL files under db/migrations (ADR 0001) and applied by `npm run migrate`.
 * Letting TypeORM generate DDL here would silently drop the partial indexes and
 * check constraints the compliance guarantees depend on.
 */
export function buildDataSourceOptions(url: string, poolSize = 10): DataSourceOptions {
  return {
    type: 'postgres',
    url,
    entities: ENTITIES,
    synchronize: false,
    migrationsRun: false,
    logging: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
    extra: {
      max: poolSize,
      // Fail a connection attempt rather than queue forever behind a dead database.
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    },
  };
}

/** Used by tooling that needs a DataSource outside the Nest container. */
export default new DataSource(
  buildDataSourceOptions(
    process.env.DATABASE_URL ?? 'postgres://vantedge:vantedge@localhost:5432/vantedge',
  ),
);
