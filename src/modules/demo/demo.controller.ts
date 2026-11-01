import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { DemoModeGuard } from './demo-mode.guard';
import { DemoService } from './demo.service';
import { DemoOrganizationQueryDto } from './dto/demo-organization-query.dto';
import { DemoOrganizationListDto } from './dto/demo-organization-response.dto';

/**
 * Evaluation aid only: lets someone trying the API find an organisation id to
 * put in X-Organization-Id. It is not organisation management and not an
 * authorisation mechanism; X-Organization-Id remains a simulated tenant context.
 * No X-Organization-Id is required here because the endpoint lists tenants.
 */
@ApiTags('Demo')
@Controller({ path: 'demo/organizations', version: '1' })
@UseGuards(DemoModeGuard)
export class DemoController {
  constructor(private readonly demo: DemoService) {}

  @Get()
  @ApiOperation({
    summary: 'List demo organizations',
    description:
      'This endpoint is available only in explicitly enabled non-production demo environments. ' +
      'It exposes a limited, non-sensitive directory of organizations for technical challenge ' +
      'evaluation.\n\n' +
      'Enable it with `DEMO_MODE=true` and a non-production `NODE_ENV` (development, test or ' +
      'demo). It is off by default, and the application refuses to start with ' +
      '`NODE_ENV=production` and `DEMO_MODE=true`. Only id, slug, name and createdAt are returned. ' +
      'Run `npm run seed` first to create the demo organization. This is not an authentication ' +
      'or authorization feature.',
  })
  @ApiResponse({ status: 200, type: DemoOrganizationListDto })
  @ApiResponse({ status: 400, description: 'Invalid limit or offset.' })
  @ApiResponse({
    status: 404,
    description: 'Demo mode is not enabled (the default), or the environment is production.',
  })
  list(@Query() query: DemoOrganizationQueryDto): Promise<DemoOrganizationListDto> {
    return this.demo.listOrganizations(query);
  }
}
