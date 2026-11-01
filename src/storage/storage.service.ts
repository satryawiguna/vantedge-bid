export interface StoredObject {
  bucket: string;
  key: string;
  sizeBytes: number;
  checksumSha256: string;
}

export interface PutObjectParams {
  key: string;
  body: Buffer;
  contentType: string;
  /** Preserved for download responses; never trusted for validation. */
  originalFilename?: string;
  metadata?: Record<string, string>;
}

/**
 * The boundary between the application and wherever bytes happen to live.
 *
 * Every caller depends on this abstract class, never on an SDK type. That is
 * what lets the same code run against MinIO locally, S3 in production and
 * Supabase Storage if the platform decision changes — and what lets the unit
 * tests use an in-memory double instead of a container.
 */
export abstract class StorageService {
  abstract readonly bucket: string;

  abstract put(params: PutObjectParams): Promise<StoredObject>;

  abstract get(key: string): Promise<Buffer>;

  abstract delete(key: string): Promise<void>;

  abstract exists(key: string): Promise<boolean>;

  /**
   * Metadata for a stored object, or null when it is not there.
   *
   * Exists because "is this content already stored?" cannot be answered from a
   * database row. A `document_versions` row is written before the bytes are,
   * so a row can legitimately exist while its object does not — and a second
   * upload of the same content that trusted the row would skip the write and
   * queue a worker against a file that was never written.
   *
   * The size is returned so the caller can tell a complete object from a
   * truncated one, which a bare existence check cannot.
   */
  abstract head(key: string): Promise<{ sizeBytes: number } | null>;

  /**
   * A time-limited URL the client can upload to directly.
   *
   * Unused by the multipart endpoint, present because it is the production path
   * for large files: the API issues the URL, the bytes never traverse the
   * service, and ingestion is triggered by a storage event. See the README.
   */
  abstract createUploadUrl(key: string, contentType: string, expiresInSeconds?: number): Promise<string>;

  /**
   * Content-addressed layout, scoped to the tenant.
   *
   * The key is derived from the content hash alone, so identical bytes always
   * resolve to the same object no matter which tender or document slot they
   * were uploaded for. That is what lets one certificate submitted to twelve
   * tenders be stored once and referenced by twelve version rows.
   *
   * Tender and document ids are deliberately NOT in the path: including them
   * would make the key content-plus-context addressed, which stores the same
   * bytes once per slot and defeats the de-duplication the checksum exists for.
   * The database holds the mapping from object to slots.
   *
   * The two-character shard keeps any single prefix from becoming hot.
   */
  static buildObjectKey(params: {
    organizationId: string;
    checksum: string;
    extension: string;
  }): string {
    const shard = params.checksum.slice(0, 2);
    return ['org', params.organizationId, shard, `${params.checksum}${params.extension}`].join('/');
  }
}
