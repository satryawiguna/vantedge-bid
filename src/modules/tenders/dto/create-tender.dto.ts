import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';

export class CreateTenderDto {
  @ApiProperty({ example: 'LPSE-2026-BALI-0042' })
  @IsString()
  @Length(3, 64)
  tenderCode!: string;

  @ApiProperty({ example: 'Pembangunan Gedung Puskesmas Gianyar' })
  @IsString()
  @Length(3, 255)
  title!: string;

  @ApiProperty({ example: 'Dinas Pekerjaan Umum Kabupaten Gianyar' })
  @IsString()
  @Length(3, 255)
  buyerName!: string;

  @ApiPropertyOptional({ example: 'bangunan_gedung' })
  @IsOptional()
  @IsString()
  workCategory?: string;

  @ApiPropertyOptional({
    example: ['BG009'],
    description: 'SBU subclassification codes the announcement requires.',
  })
  @IsOptional()
  @IsArray()
  @Matches(/^[A-Z]{2}\d{3}$/, { each: true, message: 'each SBU code looks like BG009' })
  requiredSbuCodes?: string[];

  @ApiPropertyOptional({
    example: '15000000000.00',
    description: 'HPS / pagu in rupiah. A string, because money is never a float here.',
  })
  @IsOptional()
  @Matches(/^\d{1,16}(\.\d{1,2})?$/, { message: 'estimatedValue must be a decimal string' })
  estimatedValue?: string;

  @ApiPropertyOptional({ example: '2026-12-15T10:00:00+08:00' })
  @IsOptional()
  @IsISO8601()
  submissionDeadline?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sourceUrl?: string;
}
