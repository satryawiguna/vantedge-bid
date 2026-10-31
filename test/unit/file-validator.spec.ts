import { createHash } from 'node:crypto';
import { FileValidatorService } from '../../src/modules/documents/validation/file-validator.service';
import { AppError } from '../../src/common/errors/app-error';
import { ErrorCode } from '../../src/common/errors/error-codes';
import { DocumentType } from '../../src/database/entities';
import { buildPdf, buildXlsx } from '../helpers/pdf-fixture';

const sbuType = {
  code: 'SBU',
  name: 'Sertifikat Badan Usaha Konstruksi',
  category: 'kualifikasi',
  description: null,
  hasExpiry: true,
  isMandatoryDefault: true,
  allowedMimeTypes: ['application/pdf'],
  maxSizeBytes: 10_485_760,
  createdAt: new Date(),
} as DocumentType;

function upload(buffer: Buffer, overrides: Partial<Express.Multer.File> = {}) {
  return {
    fieldname: 'file',
    originalname: 'sbu.pdf',
    encoding: '7bit',
    mimetype: 'application/pdf',
    size: buffer.byteLength,
    buffer,
    stream: undefined as never,
    destination: '',
    filename: '',
    path: '',
    ...overrides,
  } as Express.Multer.File;
}

describe('FileValidatorService', () => {
  const validator = new FileValidatorService();
  const validate = (file: Express.Multer.File | undefined, type = sbuType) =>
    validator.validate({ file, documentType: type, globalMaxBytes: 52_428_800 });

  it('accepts a well-formed upload and returns its content address', () => {
    const pdf = buildPdf(['Sertifikat Badan Usaha']);
    const result = validate(upload(pdf));

    expect(result.mimeType).toBe('application/pdf');
    expect(result.extension).toBe('.pdf');
    expect(result.checksumSha256).toBe(createHash('sha256').update(pdf).digest('hex'));
  });

  it('rejects a missing file', () => {
    expect(() => validate(undefined)).toThrow(
      expect.objectContaining({ code: ErrorCode.FILE_MISSING }),
    );
  });

  it('rejects an empty file before anything else inspects it', () => {
    expect(() => validate(upload(Buffer.alloc(0)))).toThrow(
      expect.objectContaining({ code: ErrorCode.FILE_EMPTY }),
    );
  });

  it('enforces the per-document-type size limit, not just the global one', () => {
    const smallType = { ...sbuType, maxSizeBytes: 1024 } as DocumentType;
    const pdf = buildPdf(['x'.repeat(4000)]);

    try {
      validate(upload(pdf), smallType);
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(ErrorCode.FILE_TOO_LARGE);
      // The limit that applied is reported, so the client knows what to aim for.
      expect((error as AppError).details.maxBytes).toBe(1024);
    }
  });

  it('rejects a media type this document type does not accept', () => {
    const xlsx = buildXlsx();
    expect(() =>
      validate(
        upload(xlsx, {
          originalname: 'sbu.xlsx',
          mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }),
      ),
    ).toThrow(expect.objectContaining({ code: ErrorCode.UNSUPPORTED_MEDIA_TYPE }));
  });

  it('rejects a file whose bytes contradict its declared type', () => {
    // Declared as a PDF, accepted by the allow-list, and still not a PDF.
    expect(() => validate(upload(buildXlsx(), { mimetype: 'application/pdf' }))).toThrow(
      expect.objectContaining({ code: ErrorCode.FILE_SIGNATURE_MISMATCH }),
    );
  });

  it('rejects a password-protected PDF at upload rather than failing later', () => {
    expect(() => validate(upload(buildPdf(['rahasia'], { encrypted: true })))).toThrow(
      expect.objectContaining({ code: ErrorCode.FILE_ENCRYPTED }),
    );
  });

  it('strips path separators from the stored filename', () => {
    const result = validate(upload(buildPdf(['ok']), { originalname: '../../etc/passwd.pdf' }));
    expect(result.originalFilename).not.toContain('/');
  });

  it('normalises a media type carrying parameters', () => {
    const result = validate(upload(buildPdf(['ok']), { mimetype: 'application/pdf; charset=binary' }));
    expect(result.mimeType).toBe('application/pdf');
  });
});
