import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  const config = app.get(ConfigService);

  // URI versioning supplies the /v1 prefix, so controllers declare only their
  // own path. Probes opt out with VERSION_NEUTRAL.
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  const swagger = new DocumentBuilder()
    .setTitle('Vantedge Bid — Ingestion & Compliance API')
    .setDescription(
      'Tender document ingestion and compliance auditing. ' +
        'All endpoints are tenant-scoped through the X-Organization-Id header.',
    )
    .setVersion('0.1.0')
    .build();

  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swagger), {
    jsonDocumentUrl: 'docs/openapi.json',
  });

  // Give in-flight uploads a chance to finish before the process exits.
  app.enableShutdownHooks();

  const port = config.get<number>('app.port', 3000);
  await app.listen(port, '0.0.0.0');

  app.get(Logger).log(`API listening on :${port} — docs at /docs`);
}

void bootstrap();
