import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';

/**
 * Multipart form fields accompanying the uploaded file.
 *
 * Everything arrives as a string in a multipart body, so booleans are coerced
 * explicitly rather than relying on implicit conversion — `"false"` is truthy.
 */
export class IngestDocumentDto {
  @ApiProperty({
    description: 'Document type code, as listed by GET /v1/document-types.',
    example: 'SBU',
  })
  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]{1,63}$/, {
    message: 'documentTypeCode must be an upper-case reference code such as SBU or JAMINAN_PENAWARAN',
  })
  documentTypeCode!: string;

  @ApiPropertyOptional({
    description:
      'Existing document slot to attach this file to as a new version. Omit to open a new slot.',
  })
  @IsOptional()
  @IsUUID('4')
  documentId?: string;

  @ApiPropertyOptional({ description: 'Human label for the document slot.' })
  @IsOptional()
  @IsString()
  @Length(1, 255)
  title?: string;

  @ApiPropertyOptional({
    description: 'Whether the bid is invalid without this document. Defaults to the type default.',
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() === 'true' : value))
  @IsBoolean()
  isMandatory?: boolean;
}

/**
 * Documentation-only shape of the multipart request, so Swagger UI shows a file
 * picker. The upload itself is read by `FileInterceptor('file')` into
 * `req.file`, not into the validated body, so this class is never used for
 * validation — `IngestDocumentDto` still is.
 */
export class IngestDocumentFormDto extends IngestDocumentDto {
  @ApiProperty({
    type: 'string',
    format: 'binary',
    description: 'The document file (PDF, or another type allowed for the document type).',
  })
  file!: unknown;
}
