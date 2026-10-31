import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { AppError } from '../errors/app-error';
import { ErrorCode } from '../errors/error-codes';
import { OrganizationContext } from '../decorators/organization.decorator';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Stand-in for authentication.
 *
 * Every tenant-scoped query in this service filters by organization_id, and
 * that id comes from here. Replacing this guard with one that reads a verified
 * JWT is the whole of the auth work — nothing downstream changes, because
 * nothing downstream reads the header itself.
 */
@Injectable()
export class OrganizationContextGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<Request & { orgContext: OrganizationContext }>();

    const organizationId = request.headers['x-organization-id'] as string | undefined;
    const userId = request.headers['x-user-id'] as string | undefined;

    if (!organizationId || !UUID_PATTERN.test(organizationId)) {
      throw AppError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'A valid X-Organization-Id header is required.',
      );
    }

    if (userId && !UUID_PATTERN.test(userId)) {
      throw AppError.badRequest(ErrorCode.VALIDATION_FAILED, 'X-User-Id must be a UUID.');
    }

    request.orgContext = { organizationId, userId: userId ?? null };
    return true;
  }
}
