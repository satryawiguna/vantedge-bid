import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { AppError } from '../../common/errors/app-error';
import { ErrorCode } from '../../common/errors/error-codes';
import { OrganizationContext } from '../../common/decorators/organization.decorator';
import {
  AuditTrailEntry,
  DocumentType,
  DocumentVersion,
  IngestionJob,
  Tender,
  TenderDocument,
} from '../../database/entities';
import { DocumentLifecycle, TenderStatus } from '../../database/enums';
import { StorageService } from '../../storage/storage.service';
import { IngestionQueueService } from '../ingestion/ingestion.queue';
import { DEFAULT_PRIORITY, PRIORITY_BY_CATEGORY } from '../ingestion/ingestion.constants';
import { FileValidatorService, ValidatedFile } from './validation/file-validator.service';
import { IngestDocumentDto } from './dto/ingest-document.dto';
import { IngestDocumentResponseDto } from './dto/ingest-document-response.dto';

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);
  private readonly uploadMaxBytes: number;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    private readonly validator: FileValidatorService,
    private readonly queue: IngestionQueueService,
    config: ConfigService,
  ) {
    this.uploadMaxBytes = config.get<number>('app.uploadMaxBytes', 52_428_800);
  }

  /**
   * Ingest one tender document.
   *
   * The ordering here is the part worth reading. Metadata is committed before
   * the bytes are written, and the row starts in `pending`:
   *
   *   commit(pending) -> upload -> update(queued) -> enqueue
   *
   * Storage is not transactional, so one of the two has to go first. Writing
   * the row first means a crash mid-upload leaves a `pending` row with no
   * object — visible, sweepable, and harmless. The reverse order would leave an
   * orphaned object nothing references, which is invisible and accumulates
   * cost forever. Prefer the failure you can see.
   */
  async ingest(params: {
    context: OrganizationContext;
    tenderId: string;
    dto: IngestDocumentDto;
    file: Express.Multer.File | undefined;
    idempotencyKey?: string;
  }): Promise<{ body: IngestDocumentResponseDto; replayed: boolean }> {
    const { context, tenderId, dto, file, idempotencyKey } = params;

    const tender = await this.loadTender(context.organizationId, tenderId);
    this.assertTenderAcceptsUploads(tender);

    const documentType = await this.dataSource
      .getRepository(DocumentType)
      .findOneBy({ code: dto.documentTypeCode });

    if (!documentType) {
      throw AppError.notFound(
        ErrorCode.DOCUMENT_TYPE_NOT_FOUND,
        `Unknown document type "${dto.documentTypeCode}".`,
      );
    }

    const validated = this.validator.validate({
      file,
      documentType,
      globalMaxBytes: this.uploadMaxBytes,
    });

    // The idempotency check sits here, after validation, not at the top of the
    // method. The request fingerprint has to cover the file's contents, and that
    // hash is a by-product of validation. Checking first would force a choice
    // between hashing a 50 MB body before discovering it is oversized, and
    // fingerprinting the form fields alone — which would treat "same key,
    // different file" as a retry and hand back a response describing a document
    // the caller did not send.
    const requestHash = fingerprintRequest(tenderId, dto, validated.checksumSha256);
    let holdsClaim = false;

    if (idempotencyKey) {
      const claim = await this.claimIdempotencyKey({
        organizationId: context.organizationId,
        key: idempotencyKey,
        requestHash,
      });

      if (claim.outcome === 'replay') {
        return { body: claim.body, replayed: true };
      }
      holdsClaim = true;
    }

    try {
      const body = await this.persist({ context, tender, dto, documentType, validated });

      if (holdsClaim) {
        await this.completeClaim(context.organizationId, idempotencyKey!, body);
      }
      return { body, replayed: false };
    } catch (error) {
      // A failed attempt must not hold the key for the next 24 hours. The client
      // has to be able to retry the same upload under the same key once whatever
      // broke is fixed.
      if (holdsClaim) {
        await this.releaseClaim(context.organizationId, idempotencyKey!);
      }
      throw error;
    }
  }

  /** Everything after validation: de-duplicate, record, store, queue. */
  private async persist(params: {
    context: OrganizationContext;
    tender: Tender;
    dto: IngestDocumentDto;
    documentType: DocumentType;
    validated: ValidatedFile;
  }): Promise<IngestDocumentResponseDto> {
    const { context, tender, dto, documentType, validated } = params;

    // Identical bytes already stored for this tenant: nothing to upload, nothing
    // to process. Answering with the existing record keeps retries cheap and
    // stops a flaky client from multiplying storage cost.
    const duplicate = await this.findDuplicate(context.organizationId, validated.checksumSha256);
    if (duplicate) {
      this.logger.log(
        { checksum: validated.checksumSha256, versionId: duplicate.id },
        'Upload de-duplicated against an existing version',
      );
      return this.toResponse(duplicate, documentType.code, true);
    }

    const { document, version, storageKey } = await this.dataSource.transaction(
      async (manager): Promise<{ document: TenderDocument; version: DocumentVersion; storageKey: string }> => {
        const slot = await this.resolveDocumentSlot(manager, {
          context,
          tender,
          dto,
          documentType,
        });

        const nextVersionNo = await this.nextVersionNumber(manager, slot.id);

        const key = StorageService.buildObjectKey({
          organizationId: context.organizationId,
          tenderId: tender.id,
          documentId: slot.id,
          checksum: validated.checksumSha256,
          extension: validated.extension,
        });

        const created = await manager.getRepository(DocumentVersion).save(
          manager.getRepository(DocumentVersion).create({
            organizationId: context.organizationId,
            documentId: slot.id,
            versionNo: nextVersionNo,
            originalFilename: validated.originalFilename,
            storageBucket: this.storage.bucket,
            storageKey: key,
            mimeType: validated.mimeType,
            sizeBytes: validated.sizeBytes,
            checksumSha256: validated.checksumSha256,
            pageCount: validated.pageCount,
            lifecycle: DocumentLifecycle.Pending,
            uploadedBy: context.userId,
            metadata: { declaredFilename: validated.originalFilename },
          }),
        );

        await manager.getRepository(AuditTrailEntry).insert({
          organizationId: context.organizationId,
          entityType: 'document_version',
          entityId: created.id,
          action: 'uploaded',
          actorType: context.userId ? 'user' : 'system',
          actorId: context.userId,
          payload: {
            documentTypeCode: documentType.code,
            sizeBytes: validated.sizeBytes,
            checksum: validated.checksumSha256,
          },
        });

        return { document: slot, version: created, storageKey: key };
      },
    );

    // --- outside the transaction: the slow, non-transactional parts ----------

    try {
      await this.storage.put({
        key: storageKey,
        body: validated.buffer,
        contentType: validated.mimeType,
        originalFilename: validated.originalFilename,
        metadata: {
          'organization-id': context.organizationId,
          'document-type': documentType.code,
        },
      });
    } catch (error) {
      await this.markVersionFailed(version.id, 'Upload to object storage failed.');
      throw error;
    }

    const priority = PRIORITY_BY_CATEGORY[documentType.category] ?? DEFAULT_PRIORITY;
    const jobId = await this.promoteToQueued({
      version,
      document,
      tender,
      documentType,
      priority,
    });

    return this.toResponse(
      { ...version, lifecycle: DocumentLifecycle.Queued },
      documentType.code,
      false,
      jobId,
    );
  }

  async getVersionStatus(context: OrganizationContext, versionId: string) {
    const version = await this.dataSource.getRepository(DocumentVersion).findOne({
      where: { id: versionId, organizationId: context.organizationId },
      relations: { extraction: true },
    });

    if (!version) {
      throw AppError.notFound(ErrorCode.DOCUMENT_NOT_FOUND, 'No such document version.');
    }

    return {
      versionId: version.id,
      documentId: version.documentId,
      lifecycle: version.lifecycle,
      sizeBytes: version.sizeBytes,
      checksum: version.checksumSha256,
      uploadedAt: version.uploadedAt,
      processedAt: version.processedAt,
      failureReason: version.failureReason,
      extraction: version.extraction
        ? {
            documentNumber: version.extraction.documentNumber,
            issuedAt: version.extraction.issuedAt,
            expiresAt: version.extraction.expiresAt,
            classificationCodes: version.extraction.classificationCodes,
            confidence: version.extraction.confidence,
          }
        : null,
    };
  }

  // ---------------------------------------------------------------------------

  private async loadTender(organizationId: string, tenderId: string): Promise<Tender> {
    const tender = await this.dataSource
      .getRepository(Tender)
      .findOneBy({ id: tenderId, organizationId });

    if (!tender) {
      // Scoped by organization, so a tender belonging to another tenant is
      // reported as missing rather than forbidden — no existence oracle.
      throw AppError.notFound(ErrorCode.TENDER_NOT_FOUND, 'No such tender.');
    }
    return tender;
  }

  private assertTenderAcceptsUploads(tender: Tender): void {
    const stillOpen =
      tender.status === TenderStatus.Monitoring ||
      tender.status === TenderStatus.Preparing ||
      tender.status === TenderStatus.Draft;

    if (stillOpen && tender.submissionDeadline && tender.submissionDeadline.getTime() < Date.now()) {
      throw AppError.unprocessable(
        ErrorCode.TENDER_DEADLINE_PASSED,
        'The submission deadline for this tender has passed.',
        { deadline: tender.submissionDeadline.toISOString() },
      );
    }
  }

  private async findDuplicate(
    organizationId: string,
    checksum: string,
  ): Promise<DocumentVersion | null> {
    return this.dataSource
      .getRepository(DocumentVersion)
      .findOneBy({ organizationId, checksumSha256: checksum });
  }

  private async resolveDocumentSlot(
    manager: EntityManager,
    params: {
      context: OrganizationContext;
      tender: Tender;
      dto: IngestDocumentDto;
      documentType: DocumentType;
    },
  ): Promise<TenderDocument> {
    const { context, tender, dto, documentType } = params;
    const repository = manager.getRepository(TenderDocument);

    if (dto.documentId) {
      const existing = await repository.findOneBy({
        id: dto.documentId,
        tenderId: tender.id,
        organizationId: context.organizationId,
      });

      if (!existing || existing.deletedAt) {
        throw AppError.notFound(
          ErrorCode.DOCUMENT_NOT_FOUND,
          'No such document slot on this tender.',
        );
      }
      return existing;
    }

    // A tender is created with an empty slot per mandatory document type, so
    // the first upload of a type fills the slot that is waiting for it rather
    // than opening a second one next to it. Once that slot holds a file — a
    // second SKK for another key person, say — a new slot is opened, which is
    // why the lookup requires currentVersionId to be null.
    const emptySlot = await repository.findOneBy({
      tenderId: tender.id,
      organizationId: context.organizationId,
      documentTypeCode: documentType.code,
      currentVersionId: IsNull(),
      deletedAt: IsNull(),
    });

    if (emptySlot) return emptySlot;

    return repository.save(
      repository.create({
        organizationId: context.organizationId,
        tenderId: tender.id,
        documentTypeCode: documentType.code,
        title: dto.title ?? documentType.name,
        isMandatory: dto.isMandatory ?? documentType.isMandatoryDefault,
      }),
    );
  }

  /**
   * Version numbers are contiguous per document, so concurrent uploads to the
   * same slot have to be serialised. The row lock is held for the few
   * milliseconds between reading the maximum and inserting the next value;
   * without it, two simultaneous uploads both read N and one hits the unique
   * constraint on (document_id, version_no).
   */
  private async nextVersionNumber(manager: EntityManager, documentId: string): Promise<number> {
    await manager.query('SELECT id FROM tender_documents WHERE id = $1 FOR UPDATE', [documentId]);

    const [row] = await manager.query<Array<{ max: string | null }>>(
      'SELECT MAX(version_no) AS max FROM document_versions WHERE document_id = $1',
      [documentId],
    );

    return (row?.max ? Number.parseInt(row.max, 10) : 0) + 1;
  }

  private async promoteToQueued(params: {
    version: DocumentVersion;
    document: TenderDocument;
    tender: Tender;
    documentType: DocumentType;
    priority: number;
  }): Promise<string> {
    const { version, document, tender, documentType, priority } = params;

    const jobId = await this.queue.enqueue(
      {
        versionId: version.id,
        documentId: document.id,
        tenderId: tender.id,
        organizationId: version.organizationId,
        documentTypeCode: documentType.code,
        storageBucket: version.storageBucket,
        storageKey: version.storageKey,
        checksum: version.checksumSha256,
        mimeType: version.mimeType,
      },
      priority,
    );

    await this.dataSource.transaction(async (manager) => {
      await manager
        .getRepository(DocumentVersion)
        .update({ id: version.id }, { lifecycle: DocumentLifecycle.Queued });

      await manager
        .getRepository(TenderDocument)
        .update({ id: document.id }, { currentVersionId: version.id });

      await manager.getRepository(IngestionJob).insert({
        organizationId: version.organizationId,
        versionId: version.id,
        queueName: 'document-ingestion',
        jobKey: jobId,
        priority,
      });
    });

    return jobId;
  }

  private async markVersionFailed(versionId: string, reason: string): Promise<void> {
    await this.dataSource
      .getRepository(DocumentVersion)
      .update({ id: versionId }, { lifecycle: DocumentLifecycle.Failed, failureReason: reason });
  }

  private toResponse(
    version: DocumentVersion,
    documentTypeCode: string,
    deduplicated: boolean,
    jobId = `ingest-${version.checksumSha256}`,
  ): IngestDocumentResponseDto {
    return {
      documentId: version.documentId,
      versionId: version.id,
      versionNo: version.versionNo,
      lifecycle: version.lifecycle,
      checksum: version.checksumSha256,
      documentTypeCode,
      sizeBytes: version.sizeBytes,
      jobId,
      statusUrl: `/v1/documents/versions/${version.id}/status`,
      deduplicated,
    };
  }

  // --- idempotency -----------------------------------------------------------

  /**
   * Claim the key before doing the work, rather than checking for a stored
   * response and then writing one.
   *
   * Check-then-act loses the race: two concurrent requests carrying the same key
   * both see no stored response and both do the work. Claiming with a
   * conditional INSERT makes the database the arbiter — exactly one caller gets
   * the row, and the loser can be told what is happening instead of silently
   * duplicating an upload.
   *
   * The conflict clause also re-claims an expired key, so a key stops being
   * reserved once its 24-hour window has passed.
   */
  private async claimIdempotencyKey(params: {
    organizationId: string;
    key: string;
    requestHash: string;
  }): Promise<{ outcome: 'claimed' } | { outcome: 'replay'; body: IngestDocumentResponseDto }> {
    const { organizationId, key, requestHash } = params;

    const claimed = await this.dataSource.query<Array<{ key: string }>>(
      `INSERT INTO idempotency_keys (organization_id, key, endpoint, request_hash)
            VALUES ($1, $2, $3, $4)
       ON CONFLICT (organization_id, key) DO UPDATE
           SET request_hash    = EXCLUDED.request_hash,
               response_status = NULL,
               response_body   = NULL,
               created_at      = now(),
               expires_at      = now() + interval '24 hours'
         WHERE idempotency_keys.expires_at <= now()
     RETURNING key`,
      [organizationId, key, IDEMPOTENT_ENDPOINT, requestHash],
    );

    if (claimed.length > 0) return { outcome: 'claimed' };

    const [existing] = await this.dataSource.query<
      Array<{ request_hash: string; response_body: IngestDocumentResponseDto | null }>
    >(
      `SELECT request_hash, response_body FROM idempotency_keys
        WHERE organization_id = $1 AND key = $2`,
      [organizationId, key],
    );

    if (!existing) {
      // The row expired between the insert and this read. Treat the key as free.
      return { outcome: 'claimed' };
    }

    // Same key, different request. Returning the stored response here would
    // tell the caller their NIB upload succeeded when what is stored is an SBU.
    // Refusing is the only honest answer.
    if (existing.request_hash !== requestHash) {
      throw AppError.conflict(
        ErrorCode.IDEMPOTENCY_KEY_REUSED,
        'This Idempotency-Key was already used for a different request. Use a new key.',
        { key },
      );
    }

    if (existing.response_body === null) {
      // Same request, still in flight. Not an error the client caused, so it is
      // told to come back rather than given a half-finished answer.
      throw new AppError({
        code: ErrorCode.IDEMPOTENT_REQUEST_IN_PROGRESS,
        status: HttpStatus.CONFLICT,
        message: 'An identical request with this Idempotency-Key is still being processed.',
        details: { key },
      });
    }

    return { outcome: 'replay', body: existing.response_body };
  }

  private async completeClaim(
    organizationId: string,
    key: string,
    body: IngestDocumentResponseDto,
  ): Promise<void> {
    await this.dataSource.query(
      `UPDATE idempotency_keys
          SET response_status = $3, response_body = $4
        WHERE organization_id = $1 AND key = $2`,
      [organizationId, key, HttpStatus.ACCEPTED, JSON.stringify(body)],
    );
  }

  private async releaseClaim(organizationId: string, key: string): Promise<void> {
    await this.dataSource.query(
      'DELETE FROM idempotency_keys WHERE organization_id = $1 AND key = $2 AND response_body IS NULL',
      [organizationId, key],
    );
  }
}

const IDEMPOTENT_ENDPOINT = 'POST /v1/tenders/:tenderId/documents';

/**
 * What makes two ingestion requests "the same".
 *
 * The tender, the form fields and the file's content hash. Two uploads of
 * byte-identical files with the same metadata are genuinely the same request;
 * anything else is not, and must not be answered from the first one's response.
 */
export function fingerprintRequest(
  tenderId: string,
  dto: IngestDocumentDto,
  checksum: string,
): string {
  const canonical = JSON.stringify({
    tenderId,
    documentTypeCode: dto.documentTypeCode,
    documentId: dto.documentId ?? null,
    title: dto.title ?? null,
    isMandatory: dto.isMandatory ?? null,
    checksum,
  });
  return createHash('sha256').update(canonical).digest('hex');
}
