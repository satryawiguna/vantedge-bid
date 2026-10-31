import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, IsNull } from 'typeorm';
import { AppError } from '../../common/errors/app-error';
import { ErrorCode } from '../../common/errors/error-codes';
import { DocumentType, Tender, TenderDocument } from '../../database/entities';
import { CreateTenderDto } from './dto/create-tender.dto';

@Injectable()
export class TendersService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Registering a tender also opens a document slot for every type that is
   * mandatory by default.
   *
   * This is what makes the completeness rule meaningful. If slots were created
   * only when a file arrives, "every mandatory document is present" could never
   * fail — the engine would only ever see documents that exist, and a package
   * missing its bid bond entirely would audit clean. Pre-opening the slots
   * turns the tender into a checklist, which is also what the user wants to
   * look at.
   *
   * Slots are a starting point, not a cage: the user can mark one not
   * applicable, and uploading an unlisted type opens a new slot.
   */
  async create(organizationId: string, dto: CreateTenderDto): Promise<Tender> {
    return this.dataSource.transaction(async (manager) => {
      const tender = await manager.getRepository(Tender).save(
        manager.getRepository(Tender).create({
          organizationId,
          tenderCode: dto.tenderCode,
          title: dto.title,
          buyerName: dto.buyerName,
          workCategory: dto.workCategory ?? null,
          requiredSbuCodes: dto.requiredSbuCodes ?? [],
          estimatedValue: dto.estimatedValue ?? null,
          submissionDeadline: dto.submissionDeadline ? new Date(dto.submissionDeadline) : null,
          sourceUrl: dto.sourceUrl ?? null,
        }),
      );

      const mandatoryTypes = await manager
        .getRepository(DocumentType)
        .findBy({ isMandatoryDefault: true });

      if (mandatoryTypes.length > 0) {
        await manager.getRepository(TenderDocument).insert(
          mandatoryTypes.map((type) => ({
            organizationId,
            tenderId: tender.id,
            documentTypeCode: type.code,
            title: type.name,
            isMandatory: true,
          })),
        );
      }

      return tender;
    });
  }

  async list(organizationId: string): Promise<Tender[]> {
    return this.dataSource.getRepository(Tender).find({
      where: { organizationId },
      order: { submissionDeadline: 'ASC' },
      take: 100,
    });
  }

  async getWithDocuments(organizationId: string, tenderId: string) {
    const tender = await this.dataSource
      .getRepository(Tender)
      .findOneBy({ id: tenderId, organizationId });

    if (!tender) {
      throw AppError.notFound(ErrorCode.TENDER_NOT_FOUND, 'No such tender.');
    }

    const documents = await this.dataSource.getRepository(TenderDocument).find({
      where: { tenderId, organizationId, deletedAt: IsNull() },
      order: { createdAt: 'ASC' },
    });

    return {
      ...tender,
      documents: documents.map((document) => ({
        id: document.id,
        documentTypeCode: document.documentTypeCode,
        title: document.title,
        isMandatory: document.isMandatory,
        // null means the slot is still empty — the checklist view.
        currentVersionId: document.currentVersionId,
      })),
    };
  }
}
