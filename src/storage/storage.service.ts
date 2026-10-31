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
   * A time-limited URL the client can upload to directly.
   *
   * Unused by the multipart endpoint, present because it is the production path
   * for large files: the API issues the URL, the bytes never traverse the
   * service, and ingestion is triggered by a storage event. See the README.
   */
  abstract createUploadUrl(key: string, contentType: string, expiresInSeconds?: number): Promise<string>;

  /** Content-addressed layout: cheap to shard, and collisions are impossible. */
  static buildObjectKey(params: {
    organizationId: string;
    tenderId: string;
    documentId: string;
    checksum: string;
    extension: string;
  }): string {
    const shard = params.checksum.slice(0, 2);
    return [
      'org', params.organizationId,
      'tender', params.tenderId,
      'doc', params.documentId,
      shard,
      `${params.checksum}${params.extension}`,
    ].join('/');
  }
}
