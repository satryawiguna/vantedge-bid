import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { configurations } from './config/configuration';
import { validateEnv } from './config/env.validation';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { DatabaseModule } from './database/database.module';
import { StorageModule } from './storage/storage.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { TendersModule } from './modules/tenders/tenders.module';
import { ComplianceModule } from './modules/compliance/compliance.module';
import { HealthModule } from './modules/health/health.module';
import { DemoModule } from './modules/demo/demo.module';

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
        // A request id on every line is what makes a failed upload traceable
        // from the API log through to the worker that processed it.
        genReqId: (req) => (req.headers['x-request-id'] as string) ?? randomUUID(),
        autoLogging: { ignore: (req) => req.url === '/healthz' },
        redact: {
          paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-user-id"]'],
          remove: true,
        },
        transport:
          process.env.NODE_ENV === 'development'
            ? { target: 'pino-pretty', options: { singleLine: true } }
            : undefined,
      },
    }),
    DatabaseModule,
    StorageModule,
    TendersModule,
    DocumentsModule,
    ComplianceModule,
    HealthModule,
    DemoModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class AppModule {}
