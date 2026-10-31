import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';

export interface OrganizationContext {
  organizationId: string;
  userId: string | null;
}

/**
 * Tenant context for the request.
 *
 * Authentication is out of scope for this exercise, so the context is read from
 * headers and validated by OrganizationContextGuard. The shape is what a real
 * JWT guard would produce, so swapping the guard is the only change needed —
 * no controller or service signature moves.
 */
export const OrgContext = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): OrganizationContext => {
    const request = ctx.switchToHttp().getRequest<Request & { orgContext: OrganizationContext }>();
    return request.orgContext;
  },
);
