import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { COMPLIANCE_AUDIT_QUEUE } from '../ingestion/ingestion.constants';
import { ComplianceController } from './compliance.controller';
import { ComplianceService } from './compliance.service';
import { ComplianceQueueService } from './compliance.queue';
import { EvaluatorRegistry } from './evaluators/evaluator.registry';

/**
 * Registers the audit queue but not its processor: the API must be able to
 * request an audit without becoming a consumer. WorkerModule adds the
 * processor, the same split the ingestion queue uses.
 */
@Module({
  imports: [BullModule.registerQueue({ name: COMPLIANCE_AUDIT_QUEUE })],
  controllers: [ComplianceController],
  providers: [ComplianceService, ComplianceQueueService, EvaluatorRegistry],
  exports: [ComplianceService, ComplianceQueueService, BullModule],
})
export class ComplianceModule {}
