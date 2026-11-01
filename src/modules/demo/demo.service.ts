import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Organization } from '../../database/entities';
import { DemoOrganizationQueryDto } from './dto/demo-organization-query.dto';
import { DemoOrganizationListDto } from './dto/demo-organization-response.dto';

/** Read-only. Never creates, changes or deletes anything. */
@Injectable()
export class DemoService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * One page of organisations, newest first, with the total.
   *
   * Only the four exposed columns are selected, so NPWP and NIB are never even
   * read from the database, and ordering ends in `id` so equal timestamps still
   * give a stable, repeatable page boundary. The page is fetched with
   * LIMIT/OFFSET; the table is never loaded whole into memory.
   */
  async listOrganizations(query: DemoOrganizationQueryDto): Promise<DemoOrganizationListDto> {
    const { limit, offset } = query;

    const [rows, total] = await this.dataSource.getRepository(Organization).findAndCount({
      select: { id: true, slug: true, name: true, createdAt: true },
      order: { createdAt: 'DESC', id: 'DESC' },
      take: limit,
      skip: offset,
    });

    return {
      data: rows.map((row) => ({
        id: row.id,
        slug: row.slug,
        name: row.name,
        createdAt: row.createdAt,
      })),
      pagination: { total, limit, offset },
    };
  }
}
