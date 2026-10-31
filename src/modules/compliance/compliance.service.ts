import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { AppError } from '../../common/errors/app-error';
import { ErrorCode } from '../../common/errors/error-codes';
import {
  ComplianceAudit,
  ComplianceFinding,
  ComplianceRule,
  ComplianceRuleset,
  DocumentExtraction,
  DocumentType,
  DocumentVersion,
  Organization,
  Tender,
  TenderDocument,
} from '../../database/entities';
import {
  AuditStatus,
  AuditVerdict,
  BLOCKING_SEVERITIES,
  FindingStatus,
} from '../../database/enums';
import { EvaluatorRegistry } from './evaluators/evaluator.registry';
import { DocumentSnapshot, EvaluationContext, Finding } from './evaluators/types';

const RULESET_CODE = 'LKPP_KONSTRUKSI';

@Injectable()
export class ComplianceService {
  private readonly logger = new Logger(ComplianceService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly registry: EvaluatorRegistry,
  ) {}

  /**
   * Run every active rule against a tender's current documents.
   *
   * The audit row is written before the rules run and completed afterwards, so
   * a crash mid-run leaves a `running` audit rather than a missing one — the
   * same reasoning as the `pending` document version. A compliance system
   * should never lose the fact that it was asked.
   */
  async auditTender(params: {
    organizationId: string;
    tenderId: string;
    trigger: ComplianceAudit['trigger'];
  }): Promise<ComplianceAudit> {
    const { organizationId, tenderId, trigger } = params;

    const ruleset = await this.resolveRuleset(RULESET_CODE, new Date());

    const context = await this.buildContext(organizationId, tenderId);

    const audit = await this.dataSource.getRepository(ComplianceAudit).save(
      this.dataSource.getRepository(ComplianceAudit).create({
        organizationId,
        tenderId,
        rulesetId: ruleset.id,
        trigger,
        status: AuditStatus.Running,
        startedAt: new Date(),
      }),
    );

    try {
      const rules = await this.dataSource
        .getRepository(ComplianceRule)
        .find({ where: { rulesetId: ruleset.id, isActive: true }, order: { code: 'ASC' } });

      const findings = this.evaluate(rules, context, audit.id);
      return await this.completeAudit(audit, findings);
    } catch (error) {
      await this.dataSource.getRepository(ComplianceAudit).update(
        { id: audit.id },
        {
          status: AuditStatus.Failed,
          errorMessage: error instanceof Error ? error.message.slice(0, 2000) : String(error),
          completedAt: new Date(),
        },
      );
      throw error;
    }
  }

  async getAudit(organizationId: string, auditId: string) {
    const audit = await this.dataSource
      .getRepository(ComplianceAudit)
      .findOne({ where: { id: auditId, organizationId }, relations: { findings: true } });

    if (!audit) {
      throw AppError.notFound(ErrorCode.DOCUMENT_NOT_FOUND, 'No such audit.');
    }

    return {
      id: audit.id,
      tenderId: audit.tenderId,
      status: audit.status,
      verdict: audit.verdict,
      score: audit.score,
      trigger: audit.trigger,
      totals: {
        rules: audit.totalRules,
        passed: audit.passedCount,
        failed: audit.failedCount,
        warnings: audit.warningCount,
      },
      startedAt: audit.startedAt,
      completedAt: audit.completedAt,
      findings: (audit.findings ?? [])
        // Worst first: the reader wants the blockers, not an alphabetical list.
        .sort((a, b) => severityRank(a) - severityRank(b))
        .map((finding) => ({
          rule: finding.ruleCodeSnapshot,
          severity: finding.severitySnapshot,
          status: finding.status,
          message: finding.message,
          documentId: finding.documentId,
          versionId: finding.versionId,
          evidence: finding.evidence,
        })),
    };
  }

  async listAuditsForTender(organizationId: string, tenderId: string) {
    const audits = await this.dataSource.getRepository(ComplianceAudit).find({
      where: { organizationId, tenderId },
      order: { createdAt: 'DESC' },
      take: 20,
    });

    return audits.map((audit) => ({
      id: audit.id,
      status: audit.status,
      verdict: audit.verdict,
      score: audit.score,
      trigger: audit.trigger,
      failedCount: audit.failedCount,
      warningCount: audit.warningCount,
      createdAt: audit.createdAt,
    }));
  }

  // ---------------------------------------------------------------------------

  /**
   * Pick the ruleset to audit under.
   *
   * `is_active` and the effective window answer different questions, and both
   * have to hold. `is_active` is the operator's switch — which version of this
   * ruleset the product is currently running, enforced as one per code by a
   * partial unique index. `effective_from`/`effective_to` are the regulator's
   * calendar — when that version actually applies.
   *
   * Selecting on `is_active` alone, as this did originally, makes the two date
   * columns decorative: a v2 prepared in October for a January rule change
   * would take effect the moment someone flipped the switch. Requiring both
   * means a future version can be loaded, reviewed and staged in advance, and
   * still start applying on the date it is supposed to.
   */
  private async resolveRuleset(code: string, asOf: Date): Promise<ComplianceRuleset> {
    const today = asOf.toISOString().slice(0, 10);

    const ruleset = await this.dataSource
      .getRepository(ComplianceRuleset)
      .createQueryBuilder('ruleset')
      .where('ruleset.code = :code', { code })
      .andWhere('ruleset.is_active = true')
      .andWhere('ruleset.effective_from <= :today', { today })
      .andWhere('(ruleset.effective_to IS NULL OR ruleset.effective_to > :today)', { today })
      .getOne();

    if (ruleset) return ruleset;

    // Distinguish "nothing seeded" from "seeded but not in force today" — the
    // two have completely different fixes, and a single generic message would
    // send an operator looking in the wrong place.
    const anyVersion = await this.dataSource
      .getRepository(ComplianceRuleset)
      .findOneBy({ code, isActive: true });

    throw AppError.internal(
      ErrorCode.INTERNAL_ERROR,
      anyVersion
        ? `Compliance ruleset "${code}" v${anyVersion.version} is active but not in force on ${today} ` +
            `(effective ${anyVersion.effectiveFrom} to ${anyVersion.effectiveTo ?? 'open'}).`
        : `No active compliance ruleset "${code}". Run the seed migration.`,
    );
  }

  private evaluate(
    rules: ComplianceRule[],
    context: EvaluationContext,
    auditId: string,
  ): Array<Partial<ComplianceFinding>> {
    const rows: Array<Partial<ComplianceFinding>> = [];

    for (const rule of rules) {
      const evaluator = this.registry.get(rule.evaluator);

      // A rule naming an evaluator this build does not have is a deployment
      // skew, not a reason to abandon the audit. It is reported as
      // inconclusive so the gap is visible instead of silently absent.
      if (!evaluator) {
        this.logger.error(
          { rule: rule.code, evaluator: rule.evaluator },
          'Rule references an unknown evaluator',
        );
        rows.push(
          this.toRow(auditId, rule, {
            status: FindingStatus.Inconclusive,
            message: `Rule ${rule.code} could not be evaluated: unknown evaluator "${rule.evaluator}".`,
            evidence: { evaluator: rule.evaluator },
          }),
        );
        continue;
      }

      let findings: Finding[];
      try {
        findings = evaluator.evaluate(rule, context);
      } catch (error) {
        // One malfunctioning evaluator must not take the audit down with it.
        this.logger.error({ rule: rule.code, err: error }, 'Evaluator threw');
        findings = [
          {
            status: FindingStatus.Inconclusive,
            message: `Rule ${rule.code} failed to evaluate.`,
            evidence: { error: error instanceof Error ? error.message : String(error) },
          },
        ];
      }

      for (const finding of findings) {
        rows.push(this.toRow(auditId, rule, finding));
      }
    }

    return rows;
  }

  private toRow(
    auditId: string,
    rule: ComplianceRule,
    finding: Finding,
  ): Partial<ComplianceFinding> {
    return {
      auditId,
      ruleId: rule.id,
      // Snapshotted: re-tuning the rule later must not rewrite history.
      ruleCodeSnapshot: rule.code,
      severitySnapshot: rule.severity,
      status: finding.status,
      documentId: finding.documentId ?? null,
      versionId: finding.versionId ?? null,
      message: finding.message,
      evidence: finding.evidence ?? {},
    };
  }

  private async completeAudit(
    audit: ComplianceAudit,
    findings: Array<Partial<ComplianceFinding>>,
  ): Promise<ComplianceAudit> {
    const passed = findings.filter((f) => f.status === FindingStatus.Pass).length;
    const failed = findings.filter((f) => f.status === FindingStatus.Fail).length;
    const warnings = findings.filter((f) => f.status === FindingStatus.Warning).length;

    const blocking = findings.some(
      (f) => f.status === FindingStatus.Fail && BLOCKING_SEVERITIES.has(f.severitySnapshot!),
    );

    const verdict = blocking
      ? AuditVerdict.NonCompliant
      : failed > 0 || warnings > 0
        ? AuditVerdict.CompliantWithWarnings
        : AuditVerdict.Compliant;

    // Score counts only findings that reached a verdict. Including
    // not-applicable and inconclusive ones would let an unreadable bid score
    // well simply by being unreadable.
    const decided = passed + failed + warnings;
    const score = decided === 0 ? '0.00' : (((passed + warnings * 0.5) / decided) * 100).toFixed(2);

    return this.dataSource.transaction(async (manager: EntityManager) => {
      if (findings.length > 0) {
        // TypeORM's QueryDeepPartialEntity cannot express a jsonb column typed
        // as Record<string, unknown> — `unknown` has no deep-partial form. The
        // rows are structurally complete, so the cast is localised here rather
        // than weakening every jsonb column in the entity layer to `any`.
        await manager
          .getRepository(ComplianceFinding)
          .insert(findings as QueryDeepPartialEntity<ComplianceFinding>[]);
      }

      await manager.getRepository(ComplianceAudit).update(
        { id: audit.id },
        {
          status: AuditStatus.Completed,
          verdict,
          score,
          totalRules: findings.length,
          passedCount: passed,
          failedCount: failed,
          warningCount: warnings,
          completedAt: new Date(),
        },
      );

      return manager.getRepository(ComplianceAudit).findOneByOrFail({ id: audit.id });
    });
  }

  /**
   * Load everything the rules need in a fixed number of queries.
   *
   * Evaluators receive a fully materialised snapshot rather than a repository,
   * which keeps them pure and keeps the query count independent of the number
   * of rules — twelve rules over thirty documents is still four queries, not
   * three hundred and sixty.
   */
  private async buildContext(
    organizationId: string,
    tenderId: string,
  ): Promise<EvaluationContext> {
    const organization = await this.dataSource
      .getRepository(Organization)
      .findOneBy({ id: organizationId });

    const tender = await this.dataSource
      .getRepository(Tender)
      .findOneBy({ id: tenderId, organizationId });

    if (!organization || !tender) {
      throw AppError.notFound(ErrorCode.TENDER_NOT_FOUND, 'No such tender.');
    }

    const documents = await this.dataSource.getRepository(TenderDocument).find({
      where: { tenderId, organizationId, deletedAt: IsNull() },
    });

    const types = await this.dataSource.getRepository(DocumentType).find();
    const typesByCode = new Map(types.map((type) => [type.code, type]));

    const versionIds = documents
      .map((document) => document.currentVersionId)
      .filter((id): id is string => id !== null);

    const versions = versionIds.length
      ? await this.dataSource
          .getRepository(DocumentVersion)
          .createQueryBuilder('version')
          .where('version.id IN (:...ids)', { ids: versionIds })
          .getMany()
      : [];
    const versionsById = new Map(versions.map((version) => [version.id, version]));

    const extractions = versionIds.length
      ? await this.dataSource
          .getRepository(DocumentExtraction)
          .createQueryBuilder('extraction')
          .where('extraction.version_id IN (:...ids)', { ids: versionIds })
          .getMany()
      : [];
    const extractionsByVersion = new Map(
      extractions.map((extraction) => [extraction.versionId, extraction]),
    );

    const snapshots: DocumentSnapshot[] = documents.map((document) => {
      const version = document.currentVersionId
        ? versionsById.get(document.currentVersionId) ?? null
        : null;

      return {
        document,
        type: typesByCode.get(document.documentTypeCode)!,
        version,
        extraction: version ? extractionsByVersion.get(version.id) ?? null : null,
      };
    });

    return { organization, tender, documents: snapshots, now: new Date() };
  }
}

const SEVERITY_ORDER = ['blocker', 'critical', 'major', 'minor', 'info'];

function severityRank(finding: ComplianceFinding): number {
  const failing = finding.status === FindingStatus.Fail ? 0 : finding.status === FindingStatus.Warning ? 100 : 200;
  return failing + SEVERITY_ORDER.indexOf(finding.severitySnapshot);
}
