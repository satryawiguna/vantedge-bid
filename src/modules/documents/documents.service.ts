import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';
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
import {
  DEFAULT_PRIORITY,
  INGESTION_QUEUE,
  IngestionJobPayload,
  PRIORITY_BY_CATEGORY,
  ingestionJobId,
} from '../ingestion/ingestion.constants';
import { FileValidatorService, ValidatedFile } from './validation/file-validator.service';
import { didAffectRow, returningRows } from '../../database/returning-rows';
import { IngestDocumentDto } from './dto/ingest-document.dto';
import { IngestDocumentResponseDto } from './dto/ingest-document-response.dto';

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);
  private readonly uploadMaxBytes: number;

  /**
   * How long a claimed-but-unanswered idempotency key is respected.
   *
   * It has to exceed the longest a genuine request can take — validation, an
   * object write and two short transactions, bounded above by the 50 MiB upload
   * ceiling — or a slow request would have its key stolen while still running.
   * Two minutes is far beyond that and still far below the key's 24-hour life,
   * so a crashed process blocks a retry for minutes rather than a day.
   */
  private readonly claimLeaseMs: number;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    private readonly validator: FileValidatorService,
    private readonly queue: IngestionQueueService,
    config: ConfigService,
  ) {
    this.uploadMaxBytes = config.get<number>('app.uploadMaxBytes', 52_428_800);
    this.claimLeaseMs = config.get<number>('app.idempotencyClaimLeaseMs', 120_000);
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
    let claimToken: string | null = null;
    let claim: ClaimedOperation | undefined;

    if (idempotencyKey) {
      const outcome = await this.claimIdempotencyKey({
        organizationId: context.organizationId,
        key: idempotencyKey,
        requestHash,
      });

      if (outcome.outcome === 'replay') {
        return { body: outcome.body, replayed: true };
      }
      claimToken = outcome.token;
      claim = { key: idempotencyKey, token: outcome.token, versionId: outcome.versionId };
    }

    try {
      const body = await this.persist({ context, tender, dto, documentType, validated, claim });

      if (claimToken) {
        await this.completeClaim(context.organizationId, idempotencyKey!, claimToken, body);
      }
      return { body, replayed: false };
    } catch (error) {
      // A failed attempt must not hold the key for the next 24 hours. The client
      // has to be able to retry the same upload under the same key once whatever
      // broke is fixed — but only this request's own claim is released.
      if (claimToken) {
        await this.releaseClaim(context.organizationId, idempotencyKey!, claimToken);
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
    claim?: ClaimedOperation;
  }): Promise<IngestDocumentResponseDto> {
    const { context, tender, dto, documentType, validated, claim } = params;

    // Validate a named slot before looking anything up by content. See
    // loadExplicitSlot for why the order is not interchangeable.
    if (dto.documentId) {
      await this.loadExplicitSlot(this.dataSource.getRepository(TenderDocument), {
        context,
        tender,
        dto,
        documentType,
      });
    }

    // The claim names the operation this same request already began. That is
    // the only identity that can recover a multi-instance upload, where the
    // checksum cannot tell a retry from a second submission, so it is consulted
    // before any content-based lookup.
    if (claim?.versionId) {
      const begun = await this.dataSource
        .getRepository(DocumentVersion)
        .findOneBy({ id: claim.versionId, organizationId: context.organizationId });

      if (begun) {
        this.logger.warn(
          { versionId: begun.id, key: claim.key },
          'Idempotency takeover: recovering the operation the previous owner began',
        );
        return this.resumeIfStalled(
          await this.reopenIfUploadFailed(begun),
          tender,
          documentType,
          validated,
        );
      }
    }

    // A true retry: these exact bytes are already recorded against this tender's
    // slot. Only this case is a duplicate.
    //
    // De-duplicating any wider than the slot is what made uploads disappear: a
    // contractor submits the same SBU to every tender they bid for, and a
    // tenant-wide check treated the second tender's upload as a repeat, answered
    // 202, and left that tender's slot empty.
    const retry = this.checksumIdentifiesSubmission(dto, documentType)
      ? await this.findRetryInTender(tender.id, dto, validated.checksumSha256)
      : null;

    if (retry) {
      this.logger.log(
        { checksum: validated.checksumSha256, versionId: retry.id },
        'Upload matched an existing version in the same slot',
      );
      return this.resumeIfStalled(retry, tender, documentType, validated);
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

        // Record, in this same transaction, which operation the claim began.
        // Conditional on the token: a request whose lease lapsed must not file a
        // version its successor will not know about, so losing the claim here
        // aborts the transaction and the version is never created.
        if (claim) {
          const linked = returningRows<{ key: string }>(
            await manager.query(
              `UPDATE idempotency_keys SET version_id = $4
                WHERE organization_id = $1 AND key = $2 AND owner_token = $3
                  AND version_id IS NULL
            RETURNING key`,
              [context.organizationId, claim.key, claim.token, created.id],
            ),
          );
          if (linked.length === 0) {
            throw AppError.conflict(
              ErrorCode.IDEMPOTENT_REQUEST_IN_PROGRESS,
              'This Idempotency-Key is now held by another request; retry.',
              { key: claim.key },
            );
          }
        }

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

    // Storage is content-addressed, so the same bytes filed against another
    // slot resolve to the same key and the object is reusable. Reuse is decided
    // by asking storage, and the write is atomic, so a concurrent identical
    // upload either finds a complete object or writes one — never both halves.
    if (!(await this.hasUsableObject(storageKey, validated.sizeBytes))) {
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
        await this.markVersionFailed(version.id, UPLOAD_FAILED_REASON);
        throw error;
      }
    }

    const priority = PRIORITY_BY_CATEGORY[documentType.category] ?? DEFAULT_PRIORITY;
    const promotion = await this.promoteToQueued({
      version,
      document,
      tender,
      documentType,
      priority,
    });

    return this.toResponse(
      { ...version, lifecycle: promotion.lifecycle },
      documentType.code,
      false,
      promotion.jobId,
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

  /**
   * Has this content already been recorded against this tender?
   *
   * Scoped to the tender, and to one slot when the caller named it. Anything
   * wider would treat a legitimate submission of the same certificate to
   * another tender as a duplicate.
   */
  private async findRetryInTender(
    tenderId: string,
    dto: IngestDocumentDto,
    checksum: string,
  ): Promise<DocumentVersion | null> {
    const query = this.dataSource
      .getRepository(DocumentVersion)
      .createQueryBuilder('version')
      .innerJoin(TenderDocument, 'slot', 'slot.id = version.document_id')
      .where('slot.tender_id = :tenderId', { tenderId })
      .andWhere('slot.deleted_at IS NULL')
      .andWhere('version.checksum_sha256 = :checksum', { checksum })
      .orderBy('version.version_no', 'DESC');

    if (dto.documentId) {
      // The caller named the slot, so the repeat is only a repeat of *that*
      // slot's last upload.
      query.andWhere('version.document_id = :documentId', { documentId: dto.documentId });
    } else {
      // No slot named, so the operation is identified by what the caller did
      // say: this tender, this document type, these bytes.
      //
      // Matching on the checksum alone treats "the same PDF, filed as a
      // different document type" as a repeat. A company deed uploaded as
      // AKTA_PENDIRIAN and then as PENGALAMAN_KERJA is two filings of one file,
      // not one filing done twice.
      query.andWhere('slot.document_type_code = :typeCode', {
        typeCode: dto.documentTypeCode,
      });
    }

    return query.getOne();
  }

  /**
   * May a checksum match stand in for "this is the same submission"?
   *
   * Only where the type permits one document per tender. Then there is at most
   * one logical document of that type, so identical content can only be the
   * same one arriving twice.
   *
   * For a multi-instance type it proves nothing: two key personnel can hold
   * certificates that are byte-identical, and collapsing them would lose one
   * person's qualification. Those uploads are distinct submissions unless the
   * caller says otherwise — with an Idempotency-Key for a repeated request, or
   * an explicit documentId for a correction to a known slot.
   */
  private checksumIdentifiesSubmission(dto: IngestDocumentDto, type: DocumentType): boolean {
    return Boolean(dto.documentId) || !type.allowsMultiple;
  }

  /**
   * Is the object itself already there, complete?
   *
   * Asked of storage, not of the database. A `document_versions` row is written
   * before its bytes are, so a row can exist for an object that was never
   * successfully stored — and an earlier version of this method, which looked
   * for a row, would then skip the write and hand a worker a missing file.
   *
   * The size is compared as well: an object truncated by a failed write is
   * present but unusable, and a bare existence check cannot tell the two apart.
   */
  private async hasUsableObject(storageKey: string, expectedBytes: number): Promise<boolean> {
    const head = await this.storage.head(storageKey);
    if (head === null) return false;

    if (head.sizeBytes !== expectedBytes) {
      this.logger.warn(
        { storageKey, expectedBytes, actualBytes: head.sizeBytes },
        'Stored object does not match the expected size; rewriting it',
      );
      return false;
    }
    return true;
  }

  /**
   * Answer a retry, re-publishing the job if the original never reached a
   * worker.
   *
   * Enqueueing happens after the state transaction commits, so a broker outage
   * can leave a row recorded as `queued` with no live job. Rather than needing a
   * sweeper for that window, a retry of the same upload — which is what a client
   * does anyway — re-publishes it. The job id is deterministic, so this is a
   * no-op when the job is still there.
   */
  private async resumeIfStalled(
    version: DocumentVersion,
    tender: Tender,
    documentType: DocumentType,
    validated: ValidatedFile,
  ): Promise<IngestDocumentResponseDto> {
    const jobId = ingestionJobId(version.id);

    // `pending` and `queued` are not the same kind of unfinished.
    //
    // A `queued` version has been promoted: its lifecycle is committed, the
    // slot points at it and its ingestion_jobs row exists. Only the publish may
    // be missing.
    //
    // A `pending` version has none of that. Publishing it — which this used to
    // do, treating the two states as one — hands a worker a version with no job
    // ledger row to update and a slot that still points elsewhere. The
    // extraction then succeeds into a document the tender does not reference,
    // and the compliance audit reports it missing.
    switch (version.lifecycle) {
      case DocumentLifecycle.Pending:
        return this.completePendingPromotion(version, tender, documentType, validated);

      case DocumentLifecycle.Queued:
        return this.republishIfUnpublished(version, tender, documentType, validated, jobId);

      default:
        // processing, processed, failed, quarantined: the pipeline owns these.
        // Re-publishing would duplicate work or undo a terminal decision such
        // as quarantine, which exists precisely to stop retrying.
        return this.toResponse(version, documentType.code, true, jobId);
    }
  }

  /**
   * Finish a promotion that an earlier process began and did not complete.
   *
   * Runs the same promotion path a first upload does, rather than a shortcut:
   * the object is restored if missing, then one transaction commits the
   * lifecycle, the slot pointer and the job ledger row, and only then is the
   * job published. Nothing reaches a worker before the state it depends on is
   * durable.
   */
  private async completePendingPromotion(
    version: DocumentVersion,
    tender: Tender,
    documentType: DocumentType,
    validated: ValidatedFile,
  ): Promise<IngestDocumentResponseDto> {
    await this.restoreObjectIfMissing(version, documentType, validated);

    const slot = await this.dataSource
      .getRepository(TenderDocument)
      .findOneByOrFail({ id: version.documentId });

    this.logger.warn(
      { versionId: version.id },
      'Completing a promotion left unfinished by an earlier request',
    );

    const promotion = await this.promoteToQueued({
      version,
      document: slot,
      tender,
      documentType,
      priority: PRIORITY_BY_CATEGORY[documentType.category] ?? DEFAULT_PRIORITY,
    });

    // The persisted lifecycle, not an assumed `queued`: a concurrent recovery
    // may have promoted this version and a worker may have finished it since.
    return this.toResponse(
      { ...version, lifecycle: promotion.lifecycle },
      documentType.code,
      true,
      promotion.jobId,
    );
  }

  /**
   * Already promoted; only the publish may be missing.
   *
   * No new version, no second ledger row — the committed row is the intent and
   * the deterministic job id means publishing twice is a no-op. The reconciler
   * would find this too; doing it here just closes the gap sooner, while the
   * caller is still waiting.
   */
  private async republishIfUnpublished(
    version: DocumentVersion,
    tender: Tender,
    documentType: DocumentType,
    validated: ValidatedFile,
    jobId: string,
  ): Promise<IngestDocumentResponseDto> {
    await this.restoreObjectIfMissing(version, documentType, validated);

    if ((await this.queue.getJobState(jobId)) === null) {
      this.logger.warn(
        { versionId: version.id, jobId },
        'Version is queued but has no live job; re-publishing',
      );
      await this.queue.enqueue(
        this.buildPayload(version, tender, documentType),
        PRIORITY_BY_CATEGORY[documentType.category] ?? DEFAULT_PRIORITY,
        jobId,
      );
      await this.dataSource
        .getRepository(IngestionJob)
        .update({ jobKey: jobId }, { publishedAt: new Date() });
    }

    return this.toResponse(version, documentType.code, true, jobId);
  }

  /** The row exists; the object may not. The retry carries the bytes again. */
  private async restoreObjectIfMissing(
    version: DocumentVersion,
    documentType: DocumentType,
    validated: ValidatedFile,
  ): Promise<void> {
    if (await this.hasUsableObject(version.storageKey, version.sizeBytes)) return;

    this.logger.warn(
      { versionId: version.id, storageKey: version.storageKey },
      'Version row exists without a usable object; restoring it from this upload',
    );
    await this.storage.put({
      key: version.storageKey,
      body: validated.buffer,
      contentType: version.mimeType,
      originalFilename: version.originalFilename,
      metadata: {
        'organization-id': version.organizationId,
        'document-type': documentType.code,
      },
    });
  }

  private buildPayload(
    version: DocumentVersion,
    tender: Tender,
    documentType: DocumentType,
  ): IngestionJobPayload {
    return {
      versionId: version.id,
      documentId: version.documentId,
      tenderId: tender.id,
      organizationId: version.organizationId,
      documentTypeCode: documentType.code,
      storageBucket: version.storageBucket,
      storageKey: version.storageKey,
      checksum: version.checksumSha256,
      mimeType: version.mimeType,
    };
  }

  /**
   * Load the slot the caller named and check it may take this upload.
   *
   * One method, called from two places, because both need exactly this answer:
   * `persist` calls it before any content-based lookup, and
   * `resolveDocumentSlot` calls it again inside the transaction that files the
   * version (the slot could have been deleted in between).
   *
   * Order matters. The retry lookup matches on (slot, checksum); run before
   * this, it would answer an SBU upload aimed at the NIB slot with the NIB's
   * existing version, as if that were a valid repeat.
   */
  private async loadExplicitSlot(
    repository: Repository<TenderDocument>,
    params: {
      context: OrganizationContext;
      tender: Tender;
      dto: IngestDocumentDto;
      documentType: DocumentType;
    },
  ): Promise<TenderDocument> {
    const { context, tender, dto, documentType } = params;

    const existing = await repository.findOneBy({
      id: dto.documentId,
      tenderId: tender.id,
      organizationId: context.organizationId,
    });

    if (!existing || existing.deletedAt) {
      // Scoped by tender and organisation, so a slot belonging to another
      // tender or tenant reads as missing rather than forbidden.
      throw AppError.notFound(
        ErrorCode.DOCUMENT_NOT_FOUND,
        'No such document slot on this tender.',
      );
    }

    // A slot has a type, and a file filed into it inherits that type for every
    // rule that will later be evaluated against it. Letting a caller post an
    // SBU into the NIB slot would make the document type in the response
    // disagree with the one the compliance engine uses.
    if (existing.documentTypeCode !== documentType.code) {
      throw AppError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        `That slot holds ${existing.documentTypeCode} documents, not ${documentType.code}.`,
        { documentId: dto.documentId, slotType: existing.documentTypeCode },
      );
    }

    return existing;
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
      return this.loadExplicitSlot(repository, { context, tender, dto, documentType });
    }

    // Serialise slot allocation for this (tender, type).
    //
    // A row lock cannot help here: the contended case is an *empty* result, and
    // there is no row to lock. Two concurrent uploads of the same type would
    // both find the same empty slot — or both find none and both create one —
    // and two key personnel would end up as two versions of one document
    // instead of two documents. An advisory lock covers the lookup and the
    // insert together, and is released when the transaction ends.
    await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `slot:${tender.id}:${documentType.code}`,
    ]);

    const newSlot = () =>
      repository.save(
        repository.create({
          organizationId: context.organizationId,
          tenderId: tender.id,
          documentTypeCode: documentType.code,
          title: dto.title ?? documentType.name,
          isMandatory: dto.isMandatory ?? documentType.isMandatoryDefault,
        }),
      );

    // A tender holds exactly one of a single-instance type, so every upload of
    // it belongs to the one slot — a second upload is the next version of that
    // document, not a second document. Opening another slot here would split
    // one requirement into two and report the tender as needing both.
    if (!documentType.allowsMultiple) {
      const existing = await repository.findOne({
        where: {
          tenderId: tender.id,
          organizationId: context.organizationId,
          documentTypeCode: documentType.code,
          deletedAt: IsNull(),
        },
        order: { createdAt: 'ASC' },
      });
      return existing ?? newSlot();
    }

    // A multi-instance type — one SKK per key person — fills a slot that is
    // genuinely empty and otherwise opens a new one.
    //
    // Emptiness is "has no versions", not "current_version_id IS NULL". The
    // pointer is set after this transaction commits, so a concurrent upload
    // testing the pointer would still see the slot as free and file its
    // certificate as a revision of the previous person's. The version rows are
    // visible here because the advisory lock above is held until commit.
    const emptySlot = await repository
      .createQueryBuilder('slot')
      .setLock('pessimistic_write')
      .where('slot.tender_id = :tenderId', { tenderId: tender.id })
      .andWhere('slot.organization_id = :orgId', { orgId: context.organizationId })
      .andWhere('slot.document_type_code = :typeCode', { typeCode: documentType.code })
      .andWhere('slot.deleted_at IS NULL')
      .andWhere('slot.current_version_id IS NULL')
      .andWhere(
        'NOT EXISTS (SELECT 1 FROM document_versions v WHERE v.document_id = slot.id)',
      )
      .orderBy('slot.created_at', 'ASC')
      .getOne();

    return emptySlot ?? newSlot();
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

  /**
   * Move a version from `pending` to `queued`, once.
   *
   * The transition is conditional on the version still being `pending`, decided
   * by the database rather than by the entity this request read earlier. Two
   * recovery requests can read the same pending version; one promotes it and
   * publishes the job, a worker finishes it, and the other — still holding the
   * stale `pending` — would then, with an unconditional UPDATE, write
   * `processed` back to `queued`. The `WHERE lifecycle = 'pending'` makes the
   * loser a no-op: the UPDATE takes the row lock, so it waits for a concurrent
   * promoter and then re-evaluates against what that promoter committed.
   *
   * Only the request that performed the transition moves the slot pointer,
   * writes the ledger row and publishes. The others report the lifecycle that
   * is actually persisted.
   */
  private async promoteToQueued(params: {
    version: DocumentVersion;
    document: TenderDocument;
    tender: Tender;
    documentType: DocumentType;
    priority: number;
  }): Promise<{ jobId: string; lifecycle: DocumentLifecycle }> {
    const { version, document, tender, documentType, priority } = params;
    const jobId = ingestionJobId(version.id);

    // Record the intent, commit, and only then publish.
    //
    // The original ordering published first. A worker would pick the job up
    // within milliseconds, drive the version to `processed` and update an
    // `ingestion_jobs` row that did not exist yet — matching zero rows — and
    // then this transaction would commit, overwriting `processed` back to
    // `queued` and inserting a fresh job row. Under a 40-upload burst that
    // stranded 24% of documents in `queued` with a completed extraction, and the
    // client polling for status never saw them finish.
    //
    // With the publish last, the committed row is the record of intent and the
    // worker can only ever see state that is already durable. If the publish
    // then fails, the row sits in `queued` with no live job — visible, and
    // recovered by `resumeIfStalled` on the client's next retry.
    const outcome = await this.dataSource.transaction(
      async (manager): Promise<{ promoted: boolean; lifecycle: DocumentLifecycle }> => {
        const promoted = returningRows<{ id: string }>(
          await manager.query(
            `UPDATE document_versions SET lifecycle = $2
              WHERE id = $1 AND lifecycle = $3
          RETURNING id`,
            [version.id, DocumentLifecycle.Queued, DocumentLifecycle.Pending],
          ),
        );

        if (promoted.length === 0) {
          const [current] = await manager.query<Array<{ lifecycle: DocumentLifecycle }>>(
            'SELECT lifecycle FROM document_versions WHERE id = $1',
            [version.id],
          );
          return { promoted: false, lifecycle: current?.lifecycle ?? version.lifecycle };
        }

        // Move the pointer forward only. Storage completion order is not request
        // order: a slow older upload can finish after a newer one, and an
        // unconditional UPDATE would walk the slot back to the superseded file —
        // which is then what the compliance engine evaluates.
        await manager.query(
          `UPDATE tender_documents d
              SET current_version_id = $1
             FROM document_versions nv
            WHERE d.id = $2
              AND nv.id = $1
              AND (d.current_version_id IS NULL
                   OR nv.version_no > (SELECT c.version_no
                                         FROM document_versions c
                                        WHERE c.id = d.current_version_id))`,
          [version.id, document.id],
        );

        // ON CONFLICT stays as a second line of defence: the ledger holds one
        // row per ingestion operation however recovery reached this point.
        await manager.query(
          `INSERT INTO ingestion_jobs
             (organization_id, version_id, queue_name, job_key, priority)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (queue_name, job_key) DO NOTHING`,
          [version.organizationId, version.id, INGESTION_QUEUE, jobId, priority],
        );

        return { promoted: true, lifecycle: DocumentLifecycle.Queued };
      },
    );

    if (!outcome.promoted) {
      this.logger.log(
        { versionId: version.id, lifecycle: outcome.lifecycle },
        'Version was already promoted by another request; reporting its persisted state',
      );
      return { jobId, lifecycle: outcome.lifecycle };
    }

    await this.queue.enqueue(
      this.buildPayload({ ...version, documentId: document.id }, tender, documentType),
      priority,
      jobId,
    );

    // Publication is itself a durable fact. Until this lands, the row is
    // committed intent the broker has never heard of, and that is precisely
    // what IngestionReconciler looks for.
    await this.dataSource
      .getRepository(IngestionJob)
      .update({ jobKey: jobId }, { publishedAt: new Date() });

    return { jobId, lifecycle: outcome.lifecycle };
  }

  /**
   * Put a version whose upload failed back to `pending`, so recovery can run.
   *
   * Only for a request taking over its own claim, and only for the specific
   * failure this service records when the object store write fails — a failed
   * extraction or a quarantine is the pipeline's decision and stays. The
   * transition is conditional on the failure still being that one.
   */
  private async reopenIfUploadFailed(version: DocumentVersion): Promise<DocumentVersion> {
    if (
      version.lifecycle !== DocumentLifecycle.Failed ||
      version.failureReason !== UPLOAD_FAILED_REASON
    ) {
      return version;
    }

    await this.dataSource.query(
      `UPDATE document_versions SET lifecycle = $2, failure_reason = NULL
        WHERE id = $1 AND lifecycle = $3 AND failure_reason = $4`,
      [version.id, DocumentLifecycle.Pending, DocumentLifecycle.Failed, UPLOAD_FAILED_REASON],
    );

    return this.dataSource.getRepository(DocumentVersion).findOneByOrFail({ id: version.id });
  }

  /**
   * Only a version still `pending` can fail an upload. A concurrent recovery may
   * have completed the object write and promoted it; failing it from here would
   * overwrite that.
   */
  private async markVersionFailed(versionId: string, reason: string): Promise<void> {
    await this.dataSource.getRepository(DocumentVersion).update(
      { id: versionId, lifecycle: DocumentLifecycle.Pending },
      { lifecycle: DocumentLifecycle.Failed, failureReason: reason },
    );
  }

  private toResponse(
    version: DocumentVersion,
    documentTypeCode: string,
    deduplicated: boolean,
    jobId = ingestionJobId(version.id),
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
   * The conflict clause re-claims a key in two cases:
   *
   * - **Expired** — past its 24-hour window, so it is simply free again.
   * - **Lease expired** — claimed, never answered, and older than
   *   `IDEMPOTENCY_CLAIM_LEASE_MS`. That is a request whose process died
   *   mid-flight; without this, the key would report "in progress" for a full
   *   day and the caller could never retry. Only the *same* request may take
   *   over, so a different upload can never inherit the key.
   *
   * Taking over a lease is safe because it does not re-do the work. The claim
   * records the version its request created (`version_id`, written in the same
   * transaction as the version), and a takeover hands it to the successor, which
   * recovers that version instead of filing another. Content is deliberately not
   * used for this: for a multi-instance type, identical bytes are two documents.
   */
  private async claimIdempotencyKey(params: {
    organizationId: string;
    key: string;
    requestHash: string;
    /** Internal: guards the single retry below. */
    attempt?: number;
  }): Promise<
    | { outcome: 'claimed'; token: string; versionId: string | null }
    | { outcome: 'replay'; body: IngestDocumentResponseDto }
  > {
    const { organizationId, key, requestHash } = params;
    const token = randomUUID();

    const claimed = await this.dataSource.query<
      Array<{ owner_token: string; version_id: string | null }>
    >(
      `INSERT INTO idempotency_keys (organization_id, key, endpoint, request_hash, owner_token)
            VALUES ($1, $2, $3, $4, $6)
       ON CONFLICT (organization_id, key) DO UPDATE
           SET request_hash    = EXCLUDED.request_hash,
               -- A new acquisition is a new owner. Everything the previous one
               -- might still try to do is conditional on the old token.
               owner_token     = EXCLUDED.owner_token,
               -- The operation the previous owner began travels with the claim,
               -- but only to the *same* request and only while it is
               -- unanswered. A different request, or a key whose response was
               -- already recorded and has since expired, starts clean.
               version_id      = CASE
                                   WHEN idempotency_keys.response_body IS NULL
                                    AND idempotency_keys.request_hash = EXCLUDED.request_hash
                                   THEN idempotency_keys.version_id
                                 END,
               response_status = NULL,
               response_body   = NULL,
               created_at      = now(),
               expires_at      = now() + interval '24 hours'
         WHERE idempotency_keys.expires_at <= now()
            OR (
                 -- A claim with no response is a request in flight. If it has
                 -- been in flight longer than any request could take, the
                 -- process holding it died, and the lease is taken over.
                 idempotency_keys.response_body IS NULL
             AND idempotency_keys.created_at <= now() - ($5 || ' milliseconds')::interval
                 -- Only by the same request. A stale claim is not an invitation
                 -- for a different upload to inherit the key.
             AND idempotency_keys.request_hash = EXCLUDED.request_hash
               )
     RETURNING owner_token, version_id`,
      [organizationId, key, IDEMPOTENT_ENDPOINT, requestHash, this.claimLeaseMs, token],
    );

    // Exactly one caller wins the conditional upsert, so concurrent takeovers
    // cannot both believe they own the claim.
    if (claimed.length > 0) {
      return {
        outcome: 'claimed',
        token: claimed[0].owner_token,
        versionId: claimed[0].version_id,
      };
    }

    const [existing] = await this.dataSource.query<
      Array<{ request_hash: string; response_body: IngestDocumentResponseDto | null }>
    >(
      `SELECT request_hash, response_body FROM idempotency_keys
        WHERE organization_id = $1 AND key = $2`,
      [organizationId, key],
    );

    if (!existing) {
      // The row was removed between the upsert and this read — a concurrent
      // release, most likely. The key is free, but we hold no token for it, so
      // acquire it properly rather than pretending. One retry is enough: the
      // window needs a release to land in it, and a release happens once.
      if (params.attempt ?? 0) {
        throw AppError.conflict(
          ErrorCode.IDEMPOTENT_REQUEST_IN_PROGRESS,
          'Could not acquire the idempotency key; retry the request.',
          { key },
        );
      }
      return this.claimIdempotencyKey({ ...params, attempt: 1 });
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

  /**
   * Store the response — but only if this request still owns the claim.
   *
   * A request whose lease lapsed while it was slow has had its claim taken over
   * by a successor. Writing its response unconditionally would file one
   * request's answer under another's key, so the caller that is told "this is
   * your earlier response" would be told someone else's.
   *
   * Losing the race is not an error for the caller: its own work succeeded and
   * its own response is returned. It simply does not get to record it.
   */
  private async completeClaim(
    organizationId: string,
    key: string,
    token: string,
    body: IngestDocumentResponseDto,
  ): Promise<void> {
    const result = await this.dataSource.query(
      `UPDATE idempotency_keys
          SET response_status = $4, response_body = $5
        WHERE organization_id = $1 AND key = $2 AND owner_token = $3
      RETURNING key`,
      [organizationId, key, token, HttpStatus.ACCEPTED, JSON.stringify(body)],
    );

    if (!didAffectRow(result)) {
      this.logger.warn(
        { key },
        'Idempotency claim was taken over before this request could record its response',
      );
    }
  }

  /**
   * Release only what this request still holds.
   *
   * A claim that never created anything is deleted. One that already filed a
   * version is not: deleting it would let the retry start from nothing and file
   * the document again. It is instead handed back as immediately takeable, with
   * the version still attached, so the retry recovers it.
   */
  private async releaseClaim(organizationId: string, key: string, token: string): Promise<void> {
    await this.dataSource.query(
      `DELETE FROM idempotency_keys
        WHERE organization_id = $1 AND key = $2 AND owner_token = $3
          AND response_body IS NULL AND version_id IS NULL`,
      [organizationId, key, token],
    );
    await this.dataSource.query(
      `UPDATE idempotency_keys SET created_at = to_timestamp(0)
        WHERE organization_id = $1 AND key = $2 AND owner_token = $3
          AND response_body IS NULL AND version_id IS NOT NULL`,
      [organizationId, key, token],
    );
  }
}

const IDEMPOTENT_ENDPOINT = 'POST /v1/tenders/:tenderId/documents';

/** What markVersionFailed records for a failed object write; recovery keys on it. */
const UPLOAD_FAILED_REASON = 'Upload to object storage failed.';

/** The idempotency claim a request holds, and the operation it already began. */
interface ClaimedOperation {
  key: string;
  token: string;
  versionId: string | null;
}

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
