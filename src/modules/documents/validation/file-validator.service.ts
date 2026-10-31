import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { AppError } from '../../../common/errors/app-error';
import { ErrorCode } from '../../../common/errors/error-codes';
import { DocumentType } from '../../../database/entities';
import {
  detectFormat,
  estimatePdfPageCount,
  isEncryptedPdf,
  signatureMatchesMime,
} from './file-signature';

export interface ValidatedFile {
  buffer: Buffer;
  originalFilename: string;
  /** The verified type, not the one the client claimed. */
  mimeType: string;
  extension: string;
  sizeBytes: number;
  checksumSha256: string;
  pageCount: number | null;
}

const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/msword': '.doc',
  'image/jpeg': '.jpg',
  'image/png': '.png',
};

/**
 * Validation gate for uploaded files.
 *
 * The checks run cheapest-first and stop at the first failure, so a 60 MB file
 * is rejected on its size before anything hashes it. Each failure carries a
 * distinct error code: a client that gets `file_signature_mismatch` knows to
 * re-export the document, while `file_too_large` tells it to split or compress.
 * A single generic 400 would make both indistinguishable.
 */
@Injectable()
export class FileValidatorService {
  private readonly logger = new Logger(FileValidatorService.name);

  validate(params: {
    file: Express.Multer.File | undefined;
    documentType: DocumentType;
    globalMaxBytes: number;
  }): ValidatedFile {
    const { file, documentType, globalMaxBytes } = params;

    // 1 — presence
    if (!file) {
      throw AppError.badRequest(
        ErrorCode.FILE_MISSING,
        'No file was supplied under the "file" field.',
      );
    }

    // 2 — emptiness. A zero-byte upload is almost always a failed client-side
    //     read, and it would otherwise sail through every later check.
    if (file.size === 0 || file.buffer.byteLength === 0) {
      throw AppError.badRequest(ErrorCode.FILE_EMPTY, 'The uploaded file is empty.');
    }

    // 3 — size, against the stricter of the global ceiling and this document
    //     type's own limit. A bid letter has no business being 50 MB.
    const effectiveMax = Math.min(globalMaxBytes, documentType.maxSizeBytes);
    if (file.size > effectiveMax) {
      throw AppError.payloadTooLarge(
        `File exceeds the maximum size for ${documentType.name}.`,
        {
          sizeBytes: file.size,
          maxBytes: effectiveMax,
          documentType: documentType.code,
        },
      );
    }

    // 4 — declared MIME type against this document type's allow-list
    const declaredMime = normaliseMime(file.mimetype);
    if (!documentType.allowedMimeTypes.includes(declaredMime)) {
      throw AppError.unsupportedMediaType(
        ErrorCode.UNSUPPORTED_MEDIA_TYPE,
        `${documentType.name} does not accept "${declaredMime}".`,
        {
          received: declaredMime,
          allowed: documentType.allowedMimeTypes,
        },
      );
    }

    // 5 — the bytes must agree with the claim. This is the check that matters:
    //     steps 4 and 6 both read client-supplied metadata.
    if (!signatureMatchesMime(file.buffer, declaredMime)) {
      throw AppError.unsupportedMediaType(
        ErrorCode.FILE_SIGNATURE_MISMATCH,
        'The file contents do not match the declared type. Re-export the document and try again.',
        {
          declared: declaredMime,
          detected: detectFormat(file.buffer),
        },
      );
    }

    // 6 — extension sanity. Not a security control; it stops a correctly typed
    //     file from being stored under a misleading name.
    const expectedExtension = EXTENSION_BY_MIME[declaredMime] ?? '';
    const actualExtension = extname(file.originalname).toLowerCase();
    if (expectedExtension && actualExtension && actualExtension !== expectedExtension) {
      this.logger.warn(
        { declaredMime, actualExtension, expectedExtension },
        'Filename extension disagrees with verified content type; storing under the verified extension.',
      );
    }

    // 7 — an encrypted PDF stores fine and then fails silently downstream.
    if (isEncryptedPdf(file.buffer)) {
      throw AppError.unsupportedMediaType(
        ErrorCode.FILE_ENCRYPTED,
        'The PDF is password protected and cannot be read. Upload an unprotected copy.',
      );
    }

    // 8 — content address. Computed last, once the bytes are known to be worth
    //     hashing, and reused for de-duplication, the storage key and the
    //     deterministic queue job id.
    const checksumSha256 = createHash('sha256').update(file.buffer).digest('hex');

    return {
      buffer: file.buffer,
      originalFilename: sanitiseFilename(file.originalname),
      mimeType: declaredMime,
      extension: expectedExtension || actualExtension || '',
      sizeBytes: file.size,
      checksumSha256,
      pageCount: estimatePdfPageCount(file.buffer),
    };
  }
}

/** "application/pdf; charset=binary" -> "application/pdf" */
function normaliseMime(value: string): string {
  return value.split(';')[0].trim().toLowerCase();
}

/**
 * The original filename is echoed back in API responses and object metadata,
 * so it is stripped of path separators and control characters before storage.
 */
function sanitiseFilename(value: string): string {
  return value
    .replace(/[/\\]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 255);
}
