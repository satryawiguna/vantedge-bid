import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { DocumentExtraction } from '../../../database/entities';
import { StorageService } from '../../../storage/storage.service';
import { extractPdfText } from './pdf-text-extractor';
import { extractFields } from './field-extractor';

/** Bumped whenever the parser changes, so re-extraction can be targeted. */
export const EXTRACTOR_VERSION = 'heuristic-1.0.0';

export interface ExtractionResult {
  textLength: number;
  confidence: number;
  expiresAt: string | null;
}

@Injectable()
export class ExtractionService {
  private readonly logger = new Logger(ExtractionService.name);

  constructor(
    @InjectRepository(DocumentExtraction)
    private readonly extractions: Repository<DocumentExtraction>,
    private readonly storage: StorageService,
  ) {}

  async extract(params: {
    versionId: string;
    storageKey: string;
    mimeType: string;
    documentTypeCode: string;
  }): Promise<ExtractionResult> {
    const { versionId, storageKey, mimeType, documentTypeCode } = params;

    const buffer = await this.storage.get(storageKey);
    const { text, streamsDecoded, streamsTotal } =
      mimeType === 'application/pdf'
        ? extractPdfText(buffer)
        : { text: '', streamsDecoded: 0, streamsTotal: 0 };

    const fields = extractFields(text, documentTypeCode);

    // The extracted text can be megabytes. It lives beside the original in
    // object storage; the database keeps a pointer, so the extraction table
    // stays small enough to stay in cache.
    let textStorageKey: string | null = null;
    if (text.length > 0) {
      textStorageKey = `${storageKey}.txt`;
      await this.storage.put({
        key: textStorageKey,
        body: Buffer.from(text, 'utf8'),
        contentType: 'text/plain; charset=utf-8',
      });
    }

    // Re-extraction replaces the previous row rather than accumulating rows:
    // one extraction per version is a constraint in the schema, not a
    // convention here.
    await this.extractions.delete({ versionId });
    await this.extractions.insert({
      versionId,
      textStorageKey,
      documentNumber: fields.documentNumber,
      issuer: fields.issuer,
      holderName: fields.holderName,
      holderNpwp: fields.holderNpwp,
      issuedAt: fields.issuedAt,
      expiresAt: fields.expiresAt,
      classificationCodes: fields.classificationCodes,
      monetaryValue: fields.monetaryValue,
      // Same TypeORM limitation as in ComplianceService: QueryDeepPartialEntity
      // has no deep-partial form for a jsonb column typed Record<string, unknown>.
      // Cast localised here rather than weakening the entity to `any`.
      extractedData: fields.extras as QueryDeepPartialEntity<Record<string, unknown>>,
      confidence: fields.confidence,
      extractorVersion: EXTRACTOR_VERSION,
      // Diagnostics about the run, kept apart from document content so a
      // query over extracted_data never has to step around them.
      raw: { textLength: text.length, streamsDecoded, streamsTotal },
    });

    this.logger.debug(
      { versionId, textLength: text.length, confidence: fields.confidence },
      'Extraction complete',
    );

    return {
      textLength: text.length,
      confidence: fields.confidence,
      expiresAt: fields.expiresAt,
    };
  }
}
