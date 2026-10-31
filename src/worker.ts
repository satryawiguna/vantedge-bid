import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { WorkerModule } from './worker.module';

/**
 * Worker entrypoint.
 *
 * createApplicationContext, not create: there is no HTTP server here. The
 * process exists only to consume the ingestion queue.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  // Lets BullMQ finish the job in hand before the process exits, instead of
  // leaving it stalled for another worker to recover.
  app.enableShutdownHooks();

  app
    .get(Logger)
    .log(
      `Ingestion worker started (concurrency ${process.env.INGESTION_CONCURRENCY ?? 5})`,
    );
}

void bootstrap();
