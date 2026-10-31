import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocumentType, Tender, TenderDocument } from '../../database/entities';
import { TendersController } from './tenders.controller';
import { TendersService } from './tenders.service';

@Module({
  imports: [TypeOrmModule.forFeature([Tender, TenderDocument, DocumentType])],
  controllers: [TendersController],
  providers: [TendersService],
  exports: [TendersService],
})
export class TendersModule {}
