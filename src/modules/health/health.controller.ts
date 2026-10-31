import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { IngestionQueueService } from '../ingestion/ingestion.queue';

/**
 * Probes sit outside URI versioning: an orchestrator's health check should not
 * have to follow the API's version history.
 */
@ApiTags('health')
@Controller({ version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly queue: IngestionQueueService,
  ) {}

  /**
   * Liveness. Deliberately checks nothing external — a readiness failure in
   * Postgres should not get the process killed and restarted into the same
   * failure.
   */
  @Get('healthz')
  @ApiOperation({ summary: 'Liveness probe' })
  live() {
    return { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) };
  }

  /** Readiness. Checks the dependencies a request actually needs. */
  @Get('readyz')
  @ApiOperation({ summary: 'Readiness probe with dependency status' })
  async ready() {
    const [database, queue] = await Promise.all([
      this.check(() => this.dataSource.query('SELECT 1')),
      this.check(() => this.queue.counts()),
    ]);

    const ready = database.ok && queue.ok;
    return { status: ready ? 'ready' : 'degraded', checks: { database, queue } };
  }

  /** Queue depth, for the scalability story in the README. */
  @Get('metrics/queue')
  @ApiOperation({ summary: 'Ingestion queue depth by state' })
  async queueDepth() {
    return this.queue.counts();
  }

  private async check(probe: () => Promise<unknown>) {
    const startedAt = Date.now();
    try {
      await probe();
      return { ok: true, latencyMs: Date.now() - startedAt };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
