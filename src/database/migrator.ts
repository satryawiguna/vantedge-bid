#!/usr/bin/env node
/**
 * Minimal SQL migration runner.
 *
 * Applies every .sql file in db/migrations in filename order exactly once,
 * each inside its own transaction, recording the filename and a checksum.
 * An already-applied file whose contents changed aborts the run — editing a
 * migration that has shipped is how environments quietly diverge.
 *
 * It is deliberately ~80 lines rather than a dependency: the schema is plain
 * SQL (ADR 0001), so the tool that applies it should be plain SQL too.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');

const TRACKING_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename    text PRIMARY KEY,
    checksum    char(64)    NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
  )`;

async function main(): Promise<void> {
  const connectionString =
    process.env.DATABASE_URL ?? 'postgres://vantedge:vantedge@localhost:5432/vantedge';
  const client = new Client({ connectionString });
  await client.connect();

  try {
    await client.query(TRACKING_TABLE);

    const { rows } = await client.query<{ filename: string; checksum: string }>(
      'SELECT filename, checksum FROM schema_migrations',
    );
    const applied = new Map<string, string>(
      rows.map((row: { filename: string; checksum: string }) => [row.filename, row.checksum]),
    );

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith('.sql'))
      .sort();

    let appliedCount = 0;

    for (const filename of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = applied.get(filename);

      if (previous !== undefined) {
        if (previous !== checksum) {
          throw new Error(
            `Migration ${filename} was modified after it was applied. ` +
              'Add a new migration instead of editing a shipped one.',
          );
        }
        continue;
      }

      process.stdout.write(`  applying ${filename} ... `);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
          [filename, checksum],
        );
        await client.query('COMMIT');
        appliedCount += 1;
        process.stdout.write('ok\n');
      } catch (error) {
        await client.query('ROLLBACK');
        process.stdout.write('failed\n');
        throw error;
      }
    }

    console.log(
      appliedCount === 0
        ? 'Database is up to date.'
        : `Applied ${appliedCount} migration(s).`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error('Migration failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
