import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { AppError } from '../common/errors/app-error';
import { ErrorCode } from '../common/errors/error-codes';
import { PutObjectParams, StorageService, StoredObject } from './storage.service';

/**
 * Filesystem driver for tests and offline demos.
 *
 * Exists to prove the abstraction is real: if the only implementation were S3,
 * the interface would have quietly grown S3-shaped assumptions.
 */
@Injectable()
export class LocalStorageService extends StorageService {
  readonly bucket: string;
  private readonly root: string;

  constructor(config: ConfigService) {
    super();
    this.bucket = config.get<string>('storage.bucket', 'tender-documents');
    this.root = resolve(config.get<string>('storage.localRoot', './.storage'));
  }

  /**
   * Write through a temporary file and rename into place.
   *
   * `rename` within a filesystem is atomic, so a concurrent reader sees either
   * the previous object or the complete new one, never a half-written file.
   * Writing directly to the final path does not have that property, and two
   * identical uploads racing each other would otherwise be able to hand a
   * worker a truncated document.
   *
   * S3 PUT is already atomic, which is why only this driver needs the dance.
   */
  async put(params: PutObjectParams): Promise<StoredObject> {
    const path = this.resolveKey(params.key);
    await mkdir(dirname(path), { recursive: true });

    const temporary = `${path}.${randomUUID()}.part`;
    try {
      await writeFile(temporary, params.body);
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
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
      checksumSha256: createHash('sha256').update(params.body).digest('hex'),
    };
  }

  async head(key: string): Promise<{ sizeBytes: number } | null> {
    try {
      const stats = await stat(this.resolveKey(key));
      return { sizeBytes: stats.size };
    } catch {
      return null;
    }
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.resolveKey(key));
    } catch (error) {
      throw AppError.internal(
        ErrorCode.STORAGE_UNAVAILABLE,
        `Could not read object "${key}".`,
        error,
      );
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolveKey(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    return (await this.head(key)) !== null;
  }

  async createUploadUrl(): Promise<string> {
    throw AppError.internal(
      ErrorCode.STORAGE_UNAVAILABLE,
      'Pre-signed uploads require an S3-compatible driver.',
    );
  }

  /**
   * Object keys are built by the service, never taken from user input — but
   * this driver writes to a real filesystem, so the traversal check stays.
   * A guard that is only correct because of a caller's discipline is not a
   * guard.
   */
  private resolveKey(key: string): string {
    const path = resolve(join(this.root, this.bucket, key));
    const base = resolve(join(this.root, this.bucket));
    if (path !== base && !path.startsWith(base + sep)) {
      throw AppError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid object key.');
    }
    return path;
  }
}
