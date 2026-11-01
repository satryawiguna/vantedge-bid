export const INGESTION_QUEUE = 'document-ingestion';

/**
 * Compliance auditing runs on its own queue, for two reasons.
 *
 * **Failure isolation.** The audit used to run inside the ingestion job's
 * try/catch, so an audit that threw marked the *document* failed — blaming a
 * successfully extracted file for a compliance-engine problem, and retrying the
 * extraction to fix something extraction had nothing to do with. Separate
 * queues give the two their own retry policies and their own terminal states.
 *
 * **Amplification.** Auditing inline meant one full tender audit per ingested
 * document: a 41-document upload session produced 41 audits and 2,193 finding
 * rows. The job id is per tender and the job is published with a delay, so
 * repeated ingestions inside that window collapse into a single audit.
 */
export const COMPLIANCE_AUDIT_QUEUE = 'compliance-audit';

export interface ComplianceAuditJobPayload {
  organizationId: string;
  tenderId: string;
}

/**
 * Audit job ids are unique per run (`audit-<tenderId>-<uuid>`, minted in
 * ComplianceQueueService) rather than fixed per tender.
 *
 * A fixed id looked like free coalescing and was two bugs: a request arriving
 * while an audit was *active* resolved to the running job and was dropped, and
 * a retained *failed* job held the name for a week, locking the tender out of
 * auditing entirely. Coalescing now comes from `tender_audit_state`, which is
 * durable, rather than from id collisions in Redis, which are not.
 */

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
