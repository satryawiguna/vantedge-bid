import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export const DEMO_DEFAULT_LIMIT = 50;
export const DEMO_MAX_LIMIT = 100;

/** Offset pagination, validated at the edge. Unknown query parameters are rejected by the global pipe. */
export class DemoOrganizationQueryDto {
  @ApiPropertyOptional({
    description: 'Page size.',
    minimum: 1,
    maximum: DEMO_MAX_LIMIT,
    default: DEMO_DEFAULT_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(DEMO_MAX_LIMIT)
  limit: number = DEMO_DEFAULT_LIMIT;

  @ApiPropertyOptional({ description: 'Rows to skip.', minimum: 0, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}
