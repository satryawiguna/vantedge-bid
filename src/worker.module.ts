import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { configurations } from './config/configuration';
import { validateEnv } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { StorageModule } from './storage/storage.module';
import { IngestionModule } from './modules/ingestion/ingestion.module';
import { IngestionProcessor } from './modules/ingestion/ingestion.processor';
import { ComplianceModule } from './modules/compliance/compliance.module';
import { ComplianceAuditProcessor } from './modules/compliance/compliance.processor';

/**
 * The worker process.
 *
 * Same modules as the API minus every controller, plus the queue processor.
 * Running them as separate processes is what lets you scale consumers without
 * scaling HTTP capacity — and keeps a CPU-bound document parse from blocking
 * the event loop that is meant to be accepting uploads.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: configurations,
      validate: validateEnv,
      cache: true,
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        transport:
          process.env.NODE_ENV === 'development'
            ? { target: 'pino-pretty', options: { singleLine: true } }
            : undefined,
      },
    }),
    DatabaseModule,
    StorageModule,
    IngestionModule,
    // The processors are declared here rather than in their own modules — the
    // API imports those to publish and must not become a consumer — so their
    // collaborators have to be resolvable from this module's graph.
    ComplianceModule,
  ],
  providers: [IngestionProcessor, ComplianceAuditProcessor],
})
export class WorkerModule {}
