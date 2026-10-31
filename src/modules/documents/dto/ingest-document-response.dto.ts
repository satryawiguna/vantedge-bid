import { ApiProperty } from '@nestjs/swagger';
import { DocumentLifecycle } from '../../../database/enums';

export class IngestDocumentResponseDto {
  @ApiProperty({ description: 'The document slot this file belongs to.' })
  documentId!: string;

  @ApiProperty({ description: 'The stored file.' })
  versionId!: string;

  @ApiProperty({ example: 1 })
  versionNo!: number;

  @ApiProperty({ enum: DocumentLifecycle, example: DocumentLifecycle.Queued })
  lifecycle!: DocumentLifecycle;

  @ApiProperty({ description: 'SHA-256 of the stored bytes; stable identifier for the content.' })
  checksum!: string;

  @ApiProperty({ example: 'SBU' })
  documentTypeCode!: string;

  @ApiProperty({ example: 812_344 })
  sizeBytes!: number;

  @ApiProperty({ description: 'Queue job handling this file. Poll the status endpoint with it.' })
  jobId!: string;

  @ApiProperty({
    description: 'Where to poll for processing status.',
    example: '/v1/documents/versions/8f0c.../status',
  })
  statusUrl!: string;

  @ApiProperty({
    description: 'True when identical bytes were already stored and no new work was queued.',
    example: false,
  })
  deduplicated!: boolean;
}
