import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Response } from 'express';
import {
  ApiConsumes,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { OrgContext, OrganizationContext } from '../../common/decorators/organization.decorator';
import { OrganizationContextGuard } from '../../common/guards/organization-context.guard';
import { ValidatedBody } from '../../common/decorators/validated-body.decorator';
import { DocumentsService } from './documents.service';
import { IngestDocumentDto } from './dto/ingest-document.dto';
import { IngestDocumentResponseDto } from './dto/ingest-document-response.dto';

/**
 * A hard ceiling applied before the body is read, so an oversized upload is
 * cut off at the socket rather than buffered and then rejected. The
 * per-document-type limit in FileValidatorService is applied on top of it.
 */
const ABSOLUTE_MAX_BYTES = 52_428_800; // 50 MiB

@ApiTags('documents')
@Controller({ version: '1' })
@UseGuards(OrganizationContextGuard)
@ApiHeader({ name: 'X-Organization-Id', required: true, description: 'Tenant id (stands in for auth).' })
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Post('tenders/:tenderId/documents')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Ingest a tender document',
    description:
      'Validates the file, stores it and queues it for processing. Returns 202 as soon as the ' +
      'work is durably queued — extraction and the compliance audit happen asynchronously. ' +
      'Supply an Idempotency-Key header to make retries safe.',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiResponse({ status: 202, type: IngestDocumentResponseDto })
  @ApiResponse({ status: 409, description: 'Identical content already stored for this tenant.' })
  @ApiResponse({ status: 413, description: 'File exceeds the limit for this document type.' })
  @ApiResponse({ status: 415, description: 'Rejected by the format or signature check.' })
  @ApiResponse({ status: 422, description: 'The tender submission deadline has passed.' })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: ABSOLUTE_MAX_BYTES, files: 1, fields: 10 },
    }),
  )
  async ingest(
    @OrgContext() context: OrganizationContext,
    @Param('tenderId', new ParseUUIDPipe({ version: '4' })) tenderId: string,
    @ValidatedBody(IngestDocumentDto) dto: IngestDocumentDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<IngestDocumentResponseDto> {
    const { body, replayed } = await this.documents.ingest({
      context,
      tenderId,
      dto,
      file,
      idempotencyKey,
    });

    if (replayed) {
      response.setHeader('Idempotent-Replay', 'true');
    }
    response.setHeader('Location', body.statusUrl);
    return body;
  }

  @Get('documents/versions/:versionId/status')
  @ApiOperation({
    summary: 'Processing status of an uploaded file',
    description: 'Poll this after a 202. Returns the lifecycle state and, once available, the extraction.',
  })
  async status(
    @OrgContext() context: OrganizationContext,
    @Param('versionId', new ParseUUIDPipe({ version: '4' })) versionId: string,
  ) {
    return this.documents.getVersionStatus(context, versionId);
  }
}
