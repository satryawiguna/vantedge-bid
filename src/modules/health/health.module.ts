import { Module } from '@nestjs/common';
import { IngestionModule } from '../ingestion/ingestion.module';
import { HealthController } from './health.controller';

@Module({
  imports: [IngestionModule],
  controllers: [HealthController],
})
export class HealthModule {}
