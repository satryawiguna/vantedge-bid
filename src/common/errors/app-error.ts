import { HttpStatus } from '@nestjs/common';
import { ErrorCode, ErrorCodeValue } from './error-codes';

/**
 * The single error type the domain throws.
 *
 * Nest's built-in HttpException family leaks transport concerns into services.
 * AppError carries a domain code plus the status it maps to, so a service can
 * be unit-tested without an HTTP context and the exception filter has one shape
 * to serialise.
 */
export class AppError extends Error {
  readonly code: ErrorCodeValue;
  readonly status: number;
  readonly details: Record<string, unknown>;
  /** false for expected domain outcomes — keeps them out of the error budget. */
  readonly isOperational: boolean;

  constructor(params: {
    code: ErrorCodeValue;
    status: number;
    message: string;
    details?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(params.message, { cause: params.cause });
    this.name = 'AppError';
    this.code = params.code;
    this.status = params.status;
    this.details = params.details ?? {};
    this.isOperational = params.status < 500;
    Error.captureStackTrace?.(this, AppError);
  }

  static badRequest(code: ErrorCodeValue, message: string, details?: Record<string, unknown>) {
    return new AppError({ code, status: HttpStatus.BAD_REQUEST, message, details });
  }

  static notFound(code: ErrorCodeValue, message: string, details?: Record<string, unknown>) {
    return new AppError({ code, status: HttpStatus.NOT_FOUND, message, details });
  }

  static conflict(code: ErrorCodeValue, message: string, details?: Record<string, unknown>) {
    return new AppError({ code, status: HttpStatus.CONFLICT, message, details });
  }

  static payloadTooLarge(message: string, details?: Record<string, unknown>) {
    return new AppError({
      code: ErrorCode.FILE_TOO_LARGE,
      status: HttpStatus.PAYLOAD_TOO_LARGE,
      message,
      details,
    });
  }

  static unsupportedMediaType(
    code: ErrorCodeValue,
    message: string,
    details?: Record<string, unknown>,
  ) {
    return new AppError({ code, status: HttpStatus.UNSUPPORTED_MEDIA_TYPE, message, details });
  }

  static unprocessable(code: ErrorCodeValue, message: string, details?: Record<string, unknown>) {
    return new AppError({ code, status: HttpStatus.UNPROCESSABLE_ENTITY, message, details });
  }

  static internal(code: ErrorCodeValue, message: string, cause?: unknown) {
    return new AppError({
      code,
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      message,
      cause,
    });
  }
}
