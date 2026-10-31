import { Module } from '@nestjs/common';
import { ComplianceController } from './compliance.controller';
import { ComplianceService } from './compliance.service';
import { EvaluatorRegistry } from './evaluators/evaluator.registry';

@Module({
  controllers: [ComplianceController],
  providers: [ComplianceService, EvaluatorRegistry],
  exports: [ComplianceService],
})
export class ComplianceModule {}
