import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OrgContext, OrganizationContext } from '../../common/decorators/organization.decorator';
import { OrganizationContextGuard } from '../../common/guards/organization-context.guard';
import { ComplianceService } from './compliance.service';

@ApiTags('compliance')
@Controller({ version: '1' })
@UseGuards(OrganizationContextGuard)
@ApiHeader({ name: 'X-Organization-Id', required: true })
export class ComplianceController {
  constructor(private readonly compliance: ComplianceService) {}

  @Post('tenders/:tenderId/compliance-audits')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Run a compliance audit',
    description:
      'Evaluates the active ruleset against the tender\'s current documents. Runs synchronously ' +
      'because it is a pure in-memory evaluation over an already-loaded snapshot — no file is ' +
      'read here. An audit is also triggered automatically after each document finishes ingestion.',
  })
  async run(
    @OrgContext() context: OrganizationContext,
    @Param('tenderId', new ParseUUIDPipe({ version: '4' })) tenderId: string,
  ) {
    const audit = await this.compliance.auditTender({
      organizationId: context.organizationId,
      tenderId,
      trigger: 'manual',
    });
    return this.compliance.getAudit(context.organizationId, audit.id);
  }

  @Get('tenders/:tenderId/compliance-audits')
  @ApiOperation({ summary: 'Audit history for a tender' })
  async list(
    @OrgContext() context: OrganizationContext,
    @Param('tenderId', new ParseUUIDPipe({ version: '4' })) tenderId: string,
  ) {
    return this.compliance.listAuditsForTender(context.organizationId, tenderId);
  }

  @Get('compliance-audits/:auditId')
  @ApiOperation({ summary: 'Full audit report with findings, worst first' })
  async get(
    @OrgContext() context: OrganizationContext,
    @Param('auditId', new ParseUUIDPipe({ version: '4' })) auditId: string,
  ) {
    return this.compliance.getAudit(context.organizationId, auditId);
  }
}
