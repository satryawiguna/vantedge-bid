export const INGESTION_QUEUE = 'document-ingestion';

/**
 * The queue job id for one unit of ingestion work.
 *
 * Derived from the **version**, not the content hash. The unit of work is a
 * version: the same certificate submitted to two tenders is one stored object
 * but two versions, each needing its own extraction row, and a content-derived
 * id would collide on the second one.
 *
 * Determinism is what makes publishing idempotent — a retried request resolves
 * to the version it already created (see `resumeIfStalled`) and therefore to
 * the same job id, which the broker ignores as a duplicate.
 *
 * Computed here rather than inside the queue service because the caller must
 * write it into `ingestion_jobs` and commit *before* publishing: the row is the
 * record of intent, the publish is what acts on it.
 *
 * BullMQ reserves ':' in custom ids; it is the Redis key separator.
 */
export const ingestionJobId = (versionId: string): string => `ingest-${versionId}`;

export interface IngestionJobPayload {
  versionId: string;
  documentId: string;
  tenderId: string;
  organizationId: string;
  documentTypeCode: string;
  storageBucket: string;
  storageKey: string;
  checksum: string;
  mimeType: string;
}

/**
 * Lower number = sooner. Qualification documents gate the whole bid, so they
 * jump the queue ahead of the bulky technical attachments that arrive with
 * them. Under a flood of uploads this is what keeps the time-critical checks
 * responsive while the 50 MB method statements wait their turn.
 */
export const PRIORITY_BY_CATEGORY: Readonly<Record<string, number>> = {
  kualifikasi: 10,
  administrasi: 20,
  harga: 40,
  teknis: 50,
};

export const DEFAULT_PRIORITY = 30;
