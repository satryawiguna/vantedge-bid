#!/usr/bin/env node
/**
 * Demo data, so a reviewer can exercise the API within a minute of cloning.
 *
 * Creates one organisation and one tender with a deadline and a required SBU
 * subclassification, then prints the curl commands to upload against them.
 * Idempotent: running it twice re-uses the same rows.
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

const ORG_ID = '00000000-0000-4000-8000-000000000001';
const USER_ID = '00000000-0000-4000-8000-000000000002';
const TENDER_ID = '00000000-0000-4000-8000-000000000003';

/**
 * Pick up a local `.env` the way Docker Compose does, so `npm run seed` reaches
 * the same database the rest of the setup uses. Node's built-in loader never
 * overrides a variable that is already set, so an explicit
 * `DATABASE_URL=... npm run seed` still wins. A missing file is not an error.
 */
function loadLocalEnv(): void {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env: fall back to the defaults below.
  }
}

/**
 * DATABASE_URL if set; otherwise the Compose database on the published host
 * port (POSTGRES_HOST_PORT, default 5432 — override it when the port is taken
 * by a local Postgres and Compose publishes 5433 instead).
 */
function databaseUrl(): string {
  return (
    process.env.DATABASE_URL ??
    `postgres://vantedge:vantedge@localhost:${process.env.POSTGRES_HOST_PORT ?? 5432}/vantedge`
  );
}

async function main(): Promise<void> {
  loadLocalEnv();
  const client = new Client({ connectionString: databaseUrl() });
  await client.connect();

  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO organizations (id, slug, name, npwp, nib)
       VALUES ($1, 'karya-bali-mandiri', 'PT Karya Bali Mandiri', '012345678901234', '1234567890123')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [ORG_ID],
    );

    await client.query(
      `INSERT INTO users (id, organization_id, email, full_name, role)
       VALUES ($1, $2, 'admin@karyabali.co.id', 'Admin Karya Bali', 'owner')
       ON CONFLICT (id) DO NOTHING`,
      [USER_ID, ORG_ID],
    );

    // A deadline comfortably in the future, so the deadline guard does not
    // reject a reviewer's first upload.
    const deadline = new Date(Date.now() + 45 * 86_400_000).toISOString();

    await client.query(
      `INSERT INTO tenders
         (id, organization_id, tender_code, title, buyer_name, work_category,
          required_sbu_codes, estimated_value, submission_deadline, status)
       VALUES ($1, $2, 'LPSE-GIANYAR-2026-0042',
               'Pembangunan Gedung Puskesmas Kecamatan Ubud',
               'Dinas Pekerjaan Umum Kabupaten Gianyar',
               'bangunan_gedung', ARRAY['BG009'], 15000000000.00, $3, 'preparing')
       ON CONFLICT (id) DO UPDATE SET submission_deadline = EXCLUDED.submission_deadline`,
      [TENDER_ID, ORG_ID, deadline],
    );

    // Open a slot per mandatory document type, exactly as the API does, so the
    // tender starts life as a checklist and the completeness rule has
    // something to check.
    await client.query(
      `INSERT INTO tender_documents (organization_id, tender_id, document_type_code, title, is_mandatory)
       SELECT $1, $2, code, name, true FROM document_types WHERE is_mandatory_default
       ON CONFLICT DO NOTHING`,
      [ORG_ID, TENDER_ID],
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }

  const base = process.env.API_BASE_URL ?? 'http://localhost:3000';

  console.log(`
Demo data ready.

  Organisation  PT Karya Bali Mandiri   ${ORG_ID}
  Tender        LPSE-GIANYAR-2026-0042  ${TENDER_ID}
                HPS Rp 15.000.000.000, requires SBU BG009
                deadline ${new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10)}

Upload a document:

  curl -i -X POST ${base}/v1/tenders/${TENDER_ID}/documents \\
    -H 'X-Organization-Id: ${ORG_ID}' \\
    -H 'X-User-Id: ${USER_ID}' \\
    -H 'Idempotency-Key: ${randomUUID()}' \\
    -F 'documentTypeCode=SBU' \\
    -F 'file=@./samples/sbu-valid.pdf;type=application/pdf'

Then run a compliance audit:

  curl -s -X POST ${base}/v1/tenders/${TENDER_ID}/compliance-audits \\
    -H 'X-Organization-Id: ${ORG_ID}' | jq
`);
}

main().catch((error: unknown) => {
  console.error('Seed failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
