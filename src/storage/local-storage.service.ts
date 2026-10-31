import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

  async put(params: PutObjectParams): Promise<StoredObject> {
    const path = this.resolveKey(params.key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, params.body);

    return {
      bucket: this.bucket,
      key: params.key,
      sizeBytes: params.body.byteLength,
      checksumSha256: createHash('sha256').update(params.body).digest('hex'),
    };
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
    try {
      await stat(this.resolveKey(key));
      return true;
    } catch {
      return false;
    }
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
