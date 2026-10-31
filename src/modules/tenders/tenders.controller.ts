import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OrgContext, OrganizationContext } from '../../common/decorators/organization.decorator';
import { OrganizationContextGuard } from '../../common/guards/organization-context.guard';
import { CreateTenderDto } from './dto/create-tender.dto';
import { TendersService } from './tenders.service';

/**
 * Supporting surface. The brief asks for the ingestion pipeline, but documents
 * need a tender to belong to and reviewers need a way to create one without
 * reaching for psql.
 */
@ApiTags('tenders')
@Controller({ path: 'tenders', version: '1' })
@UseGuards(OrganizationContextGuard)
@ApiHeader({ name: 'X-Organization-Id', required: true })
export class TendersController {
  constructor(private readonly tenders: TendersService) {}

  @Post()
  @ApiOperation({
    summary: 'Register a tender',
    description:
      'Also opens a document slot for every mandatory document type, so the tender starts as a ' +
      'checklist and the completeness rule has something to check against.',
  })
  async create(@OrgContext() context: OrganizationContext, @Body() dto: CreateTenderDto) {
    return this.tenders.create(context.organizationId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List tenders for this organisation' })
  async list(@OrgContext() context: OrganizationContext) {
    return this.tenders.list(context.organizationId);
  }

  @Get(':tenderId')
  @ApiOperation({ summary: 'Tender detail with its document slots' })
  async get(
    @OrgContext() context: OrganizationContext,
    @Param('tenderId', new ParseUUIDPipe({ version: '4' })) tenderId: string,
  ) {
    return this.tenders.getWithDocuments(context.organizationId, tenderId);
  }
}
