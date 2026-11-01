import { ApiProperty } from '@nestjs/swagger';

/**
 * The only organisation fields this endpoint may expose. An explicit shape, not
 * the TypeORM entity: NPWP, NIB and anything added to the entity later stay out
 * unless someone adds them here on purpose.
 */
export class DemoOrganizationDto {
  @ApiProperty({ format: 'uuid', description: 'Use as the X-Organization-Id header.' })
  id!: string;

  @ApiProperty({ example: 'pt-karya-bali-mandiri' })
  slug!: string;

  @ApiProperty({ example: 'PT Karya Bali Mandiri' })
  name!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}

export class DemoPaginationDto {
  @ApiProperty({ description: 'Total organisations, regardless of the page.' })
  total!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  offset!: number;
}

export class DemoOrganizationListDto {
  @ApiProperty({ type: [DemoOrganizationDto] })
  data!: DemoOrganizationDto[];

  @ApiProperty({ type: DemoPaginationDto })
  pagination!: DemoPaginationDto;
}
