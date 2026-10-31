export const INGESTION_QUEUE = 'document-ingestion';

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
