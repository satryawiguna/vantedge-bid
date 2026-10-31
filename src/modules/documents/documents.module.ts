import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocumentType } from '../../database/entities';
import { IngestionModule } from '../ingestion/ingestion.module';
import { DocumentsController } from './documents.controller';
import { DocumentTypesController } from './document-types.controller';
import { DocumentsService } from './documents.service';
import { FileValidatorService } from './validation/file-validator.service';

@Module({
  imports: [TypeOrmModule.forFeature([DocumentType]), IngestionModule],
  controllers: [DocumentsController, DocumentTypesController],
  providers: [DocumentsService, FileValidatorService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
