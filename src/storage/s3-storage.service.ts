import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'node:crypto';
import { AppError } from '../common/errors/app-error';
import { ErrorCode } from '../common/errors/error-codes';
import { PutObjectParams, StorageService, StoredObject } from './storage.service';

/**
 * S3-compatible driver. Backs MinIO locally and S3 or Supabase Storage in
 * production — the only difference is endpoint and credentials.
 */
@Injectable()
export class S3StorageService extends StorageService implements OnModuleInit {
  private readonly logger = new Logger(S3StorageService.name);
  private readonly client: S3Client;
  readonly bucket: string;

  constructor(config: ConfigService) {
    super();
    this.bucket = config.getOrThrow<string>('storage.bucket');
    this.client = new S3Client({
      endpoint: config.get<string>('storage.endpoint'),
      region: config.get<string>('storage.region', 'us-east-1'),
      forcePathStyle: config.get<boolean>('storage.forcePathStyle', true),
      credentials: {
        accessKeyId: config.getOrThrow<string>('storage.accessKeyId'),
        secretAccessKey: config.getOrThrow<string>('storage.secretAccessKey'),
      },
    });
  }

  /** Create the bucket on boot so a fresh `docker compose up` just works. */
  async onModuleInit(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      try {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
        this.logger.log(`Created storage bucket "${this.bucket}"`);
      } catch (error) {
        this.logger.warn(
          `Could not verify or create bucket "${this.bucket}": ${(error as Error).message}`,
        );
      }
    }
  }

  async put(params: PutObjectParams): Promise<StoredObject> {
    const checksum = createHash('sha256').update(params.body).digest('hex');

    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: params.key,
          Body: params.body,
          ContentType: params.contentType,
          // Lets the object store reject a corrupted transfer itself.
          ChecksumSHA256: Buffer.from(checksum, 'hex').toString('base64'),
          Metadata: {
            ...params.metadata,
            ...(params.originalFilename
              ? { 'original-filename': encodeURIComponent(params.originalFilename) }
              : {}),
          },
        }),
      );
    } catch (error) {
      throw AppError.internal(
        ErrorCode.STORAGE_UNAVAILABLE,
        'Could not persist the uploaded file.',
        error,
      );
    }

    return {
      bucket: this.bucket,
      key: params.key,
      sizeBytes: params.body.byteLength,
      checksumSha256: checksum,
    };
  }

  async get(key: string): Promise<Buffer> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const bytes = await result.Body!.transformToByteArray();
      return Buffer.from(bytes);
    } catch (error) {
      throw AppError.internal(
        ErrorCode.STORAGE_UNAVAILABLE,
        `Could not read object "${key}".`,
        error,
      );
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async exists(key: string): Promise<boolean> {
    return (await this.head(key)) !== null;
  }

  /**
   * A single PUT is atomic in S3 and S3-compatible stores: a reader sees the
   * previous object or the complete new one. So unlike the local driver, this
   * one needs no temporary-and-rename — but it still needs `head`, because a
   * database row is not evidence that the object was ever written.
   */
  async head(key: string): Promise<{ sizeBytes: number } | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return { sizeBytes: result.ContentLength ?? 0 };
    } catch {
      return null;
    }
  }

  async createUploadUrl(key: string, contentType: string, expiresInSeconds = 900): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
      { expiresIn: expiresInSeconds },
    );
  }
}
