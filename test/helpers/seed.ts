import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';

/** Insert an organisation and return its id. */
export async function seedOrganization(dataSource: DataSource, label: string): Promise<string> {
  const id = randomUUID();
  await dataSource.query(
    `INSERT INTO organizations (id, slug, name, npwp)
     VALUES ($1, $2, 'PT Karya Bali Mandiri', '012345678901234')`,
    [id, `${label}-${id.slice(0, 8)}`],
  );
  return id;
}

/**
 * Insert a tender with an open deadline, optionally with the mandatory
 * document slots pre-created the way the product does for a new tender.
 */
export async function seedTender(
  dataSource: DataSource,
  organizationId: string,
  options: { mandatorySlots?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  await dataSource.query(
    `INSERT INTO tenders
       (id, organization_id, tender_code, title, buyer_name, required_sbu_codes,
        estimated_value, submission_deadline, status)
     VALUES ($1, $2, $3, 'Pembangunan Gedung', 'Dinas PU', ARRAY['BG009'],
             15000000000.00, $4, 'preparing')`,
    [
      id,
      organizationId,
      `LPSE-${id.slice(0, 8)}`,
      new Date(Date.now() + 45 * 86_400_000).toISOString(),
    ],
  );
  if (options.mandatorySlots) {
    await dataSource.query(
      `INSERT INTO tender_documents (organization_id, tender_id, document_type_code, title, is_mandatory)
       SELECT $1, $2, code, name, true FROM document_types WHERE is_mandatory_default`,
      [organizationId, id],
    );
  }
  return id;
}

/** Poll until the predicate holds; fail loudly rather than hang. */
export async function waitUntil(
  predicate: () => Promise<boolean>,
  message: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
