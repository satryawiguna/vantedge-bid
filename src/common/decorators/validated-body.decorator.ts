import { Body, Type, ValidationPipe } from '@nestjs/common';

/**
 * Validation for multipart form fields.
 *
 * In a multipart request every field arrives as a string, so the global
 * ValidationPipe's `forbidNonWhitelisted` and implicit conversion behave
 * differently than they do for JSON. This decorator pins the pipe options at
 * the parameter, with `enableImplicitConversion` on, instead of weakening the
 * global pipe for every JSON endpoint in the service.
 */
export const ValidatedBody = (dto: Type<unknown>) =>
  Body(
    new ValidationPipe({
      expectedType: dto,
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
