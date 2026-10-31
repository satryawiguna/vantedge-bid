import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocumentExtraction } from '../../database/entities';
import { ComplianceModule } from '../compliance/compliance.module';
import { INGESTION_QUEUE } from './ingestion.constants';
import { IngestionQueueService } from './ingestion.queue';
import { ExtractionService } from './extraction/extraction.service';

/**
 * Queue wiring shared by the API and the worker.
 *
 * The processor is deliberately NOT registered here. The API process must be
 * able to enqueue without becoming a consumer — importing this module into the
 * API would otherwise silently turn every API pod into a worker and undo the
 * separation the queue exists to provide. WorkerModule adds the processor.
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: { url: config.getOrThrow<string>('queue.redisUrl') },
        defaultJobOptions: {
          removeOnComplete: { age: 86_400, count: 10_000 },
          removeOnFail: { age: 604_800 },
        },
      }),
    }),
    BullModule.registerQueue({ name: INGESTION_QUEUE }),
    TypeOrmModule.forFeature([DocumentExtraction]),
    ComplianceModule,
  ],
  providers: [IngestionQueueService, ExtractionService],
  exports: [IngestionQueueService, ExtractionService, BullModule],
})
export class IngestionModule {}
