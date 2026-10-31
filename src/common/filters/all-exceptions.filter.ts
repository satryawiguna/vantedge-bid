import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { QueryFailedError } from 'typeorm';
import { AppError } from '../errors/app-error';
import { ErrorCode, ErrorCodeValue } from '../errors/error-codes';

interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: ErrorCodeValue;
  detail: string;
  instance: string;
  requestId?: string;
  errors?: Record<string, unknown>;
}

/** Postgres SQLSTATE codes we translate into domain errors. */
const PG_UNIQUE_VIOLATION = '23505';
const PG_FOREIGN_KEY_VIOLATION = '23503';

/**
 * Terminal error handler. Every error leaves the service through here, in one
 * shape: RFC 7807 problem details plus our own `code`.
 *
 * Two rules it enforces:
 *   - 5xx responses never echo an internal message to the client; the detail is
 *     logged with the request id and replaced with a generic sentence.
 *   - Database driver errors are translated, never leaked. A unique-violation
 *     on the checksum index is a 409 duplicate_document, not a 500.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = (request.headers['x-request-id'] as string) ?? undefined;

    const problem = this.toProblem(exception, request.url, requestId);

    if (problem.status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        { requestId, code: problem.code, err: exception },
        `Unhandled error on ${request.method} ${request.url}`,
      );
    } else {
      this.logger.warn(
        { requestId, code: problem.code, status: problem.status },
        `${request.method} ${request.url} rejected: ${problem.detail}`,
      );
    }

    response.status(problem.status).type('application/problem+json').json(problem);
  }

  private toProblem(exception: unknown, instance: string, requestId?: string): ProblemDetails {
    if (exception instanceof AppError) {
      return {
        type: `https://docs.vantedge.id/errors/${exception.code}`,
        title: titleFor(exception.status),
        status: exception.status,
        code: exception.code,
        detail: exception.message,
        instance,
        requestId,
        errors: Object.keys(exception.details).length ? exception.details : undefined,
      };
    }

    if (exception instanceof QueryFailedError) {
      const driverCode = (exception as QueryFailedError & { code?: string }).code;

      if (driverCode === PG_UNIQUE_VIOLATION) {
        return this.problem(
          HttpStatus.CONFLICT,
          ErrorCode.DUPLICATE_DOCUMENT,
          'A record with the same unique key already exists.',
          instance,
          requestId,
        );
      }
      if (driverCode === PG_FOREIGN_KEY_VIOLATION) {
        return this.problem(
          HttpStatus.BAD_REQUEST,
          ErrorCode.VALIDATION_FAILED,
          'A referenced record does not exist.',
          instance,
          requestId,
        );
      }
    }

    // Nest's own exceptions, including ValidationPipe output and multer limits.
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const detail =
        typeof payload === 'string'
          ? payload
          : ((payload as Record<string, unknown>).message as string) ?? exception.message;

      return {
        type: `https://docs.vantedge.id/errors/${codeForStatus(status)}`,
        title: titleFor(status),
        status,
        code: codeForStatus(status),
        detail: Array.isArray(detail) ? detail.join('; ') : detail,
        instance,
        requestId,
        errors:
          typeof payload === 'object' && Array.isArray((payload as any).message)
            ? { fields: (payload as any).message }
            : undefined,
      };
    }

    return this.problem(
      HttpStatus.INTERNAL_SERVER_ERROR,
      ErrorCode.INTERNAL_ERROR,
      'An unexpected error occurred. The incident has been logged.',
      instance,
      requestId,
    );
  }

  private problem(
    status: number,
    code: ErrorCodeValue,
    detail: string,
    instance: string,
    requestId?: string,
  ): ProblemDetails {
    return {
      type: `https://docs.vantedge.id/errors/${code}`,
      title: titleFor(status),
      status,
      code,
      detail,
      instance,
      requestId,
    };
  }
}

function titleFor(status: number): string {
  return (
    {
      400: 'Bad Request',
      401: 'Unauthorized',
      403: 'Forbidden',
      404: 'Not Found',
      409: 'Conflict',
      413: 'Payload Too Large',
      415: 'Unsupported Media Type',
      422: 'Unprocessable Entity',
      429: 'Too Many Requests',
      500: 'Internal Server Error',
      503: 'Service Unavailable',
    }[status] ?? 'Error'
  );
}

function codeForStatus(status: number): ErrorCodeValue {
  if (status === HttpStatus.PAYLOAD_TOO_LARGE) return ErrorCode.FILE_TOO_LARGE;
  if (status === HttpStatus.UNSUPPORTED_MEDIA_TYPE) return ErrorCode.UNSUPPORTED_MEDIA_TYPE;
  if (status === HttpStatus.NOT_FOUND) return ErrorCode.DOCUMENT_NOT_FOUND;
  if (status < 500) return ErrorCode.VALIDATION_FAILED;
  return ErrorCode.INTERNAL_ERROR;
}
