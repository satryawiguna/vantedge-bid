import { Injectable } from '@nestjs/common';
import { RuleEvaluator } from './types';
import {
  ConditionallyRequiredEvaluator,
  DocumentReadableEvaluator,
  MandatoryDocumentsPresentEvaluator,
} from './completeness.evaluators';
import {
  IssuedWithinDaysEvaluator,
  NotExpiredAtDeadlineEvaluator,
  ValidForDaysAfterDeadlineEvaluator,
} from './validity.evaluators';
import { ClassificationMatchEvaluator, MonetaryThresholdEvaluator } from './substance.evaluators';
import { ExtractionConfidenceEvaluator, FieldConsistencyEvaluator } from './consistency.evaluators';

/**
 * The closed set of things a rule is allowed to do.
 *
 * Rules live in the database and can be edited without a deploy; what they can
 * *express* is bounded by this registry. That boundary is deliberate — an
 * arbitrary expression language in a compliance engine means a verdict nobody
 * can fully explain and an input nobody has reviewed.
 */
@Injectable()
export class EvaluatorRegistry {
  private readonly evaluators = new Map<string, RuleEvaluator>();

  constructor() {
    for (const evaluator of [
      new MandatoryDocumentsPresentEvaluator(),
      new DocumentReadableEvaluator(),
      new ConditionallyRequiredEvaluator(),
      new NotExpiredAtDeadlineEvaluator(),
      new IssuedWithinDaysEvaluator(),
      new ValidForDaysAfterDeadlineEvaluator(),
      new ClassificationMatchEvaluator(),
      new MonetaryThresholdEvaluator(),
      new FieldConsistencyEvaluator(),
      new ExtractionConfidenceEvaluator(),
    ]) {
      this.evaluators.set(evaluator.key, evaluator);
    }
  }

  get(key: string): RuleEvaluator | null {
    return this.evaluators.get(key) ?? null;
  }

  keys(): string[] {
    return [...this.evaluators.keys()].sort();
  }
}
