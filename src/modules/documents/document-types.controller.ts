import { Controller, Get, Query } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { DocumentType } from '../../database/entities';

/**
 * Reference endpoint. A client needs the type codes and their limits before it
 * can upload anything, and hard-coding them in the frontend is how the two
 * drift apart.
 */
@ApiTags('reference')
@Controller({ path: 'document-types', version: '1' })
export class DocumentTypesController {
  constructor(
    @InjectRepository(DocumentType)
    private readonly repository: Repository<DocumentType>,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List tender document types and their upload constraints' })
  @ApiQuery({ name: 'category', required: false, enum: ['administrasi', 'kualifikasi', 'teknis', 'harga'] })
  async list(@Query('category') category?: string) {
    const types = await this.repository.find({
      where: category ? { category: category as DocumentType['category'] } : {},
      order: { category: 'ASC', code: 'ASC' },
    });

    return types.map((type) => ({
      code: type.code,
      name: type.name,
      category: type.category,
      description: type.description,
      hasExpiry: type.hasExpiry,
      isMandatoryDefault: type.isMandatoryDefault,
      allowedMimeTypes: type.allowedMimeTypes,
      maxSizeBytes: type.maxSizeBytes,
    }));
  }
}
