import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocumentExtraction } from '../../database/entities';
import { ComplianceModule } from '../compliance/compliance.module';
import { INGESTION_QUEUE } from './ingestion.constants';
import { IngestionQueueService } from './ingestion.queue';
import { IngestionReconciler } from './ingestion.reconciler';
import { ExtractionService } from './extraction/extraction.service';

/**
 * Queue wiring shared by the API and the worker.
 *
 * The processor is deliberately NOT registered here. The API process must be
 * able to enqueue without becoming a consumer — importing this module into the
 * API would otherwise silently turn every API pod into a worker and undo the
 * separation the queue exists to provide. WorkerModule adds the processor.
 *
 * The reconciler IS registered here, so it runs in both. The API is the process
 * that creates unpublished rows, and it keeps running while workers restart, so
 * it is well placed to repair them; `SELECT … FOR UPDATE SKIP LOCKED` is what
 * makes several instances doing this at once safe.
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
  providers: [IngestionQueueService, ExtractionService, IngestionReconciler],
  exports: [IngestionQueueService, ExtractionService, IngestionReconciler, BullModule],
})
export class IngestionModule {}
