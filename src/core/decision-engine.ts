import type { ArtifactRef } from './types.js';
import { isRecord } from '../schemas/validator.js';

export type UnitDecision = 'pass' | 'fix' | 're_evaluate' | 'stop';

export interface DecisionEngineInput {
  readonly evaluatorReportRef: ArtifactRef;
  readonly evaluatorReport: Record<string, unknown>;
  readonly fixRound: number;
  readonly maxFixRounds: number;
  readonly evaluatorAttempt: number;
  readonly maxEvaluatorRetries: number;
  readonly unsafe?: boolean;
}

export interface DecisionEngineResult {
  readonly decision: UnitDecision;
  readonly reason_code: string;
  readonly evaluator_report: ArtifactRef;
  readonly target_failures: readonly string[];
  readonly failure_classification:
    | 'implementation_failure'
    | 'test_failure'
    | 'environment_failure'
    | 'contract_gap'
    | 'unsafe'
    | 'insufficient_evidence'
    | 'none';
  readonly evidence_refs: readonly string[];
  readonly rule_triggered: string;
  readonly rejected_paths: readonly UnitDecision[];
  readonly next_pipeline: Record<string, unknown> | null;
  readonly fix_round: number;
  readonly max_fix_rounds: number;
}

export class DecisionEngine {
  decide(input: DecisionEngineInput): DecisionEngineResult {
    const report = input.evaluatorReport;
    const failures = readFailures(report);
    const criteria = readCriteria(report);
    const evidenceRefs = readEvidenceRefs(report, failures, criteria);
    const classification = primaryClassification(
      report,
      failures,
      input.unsafe,
    );
    const targetFailures = failures.map((failure) => String(failure.ref));
    const base = {
      evaluator_report: input.evaluatorReportRef,
      target_failures: targetFailures,
      failure_classification: classification,
      evidence_refs: evidenceRefs,
      fix_round: input.fixRound,
      max_fix_rounds: input.maxFixRounds,
    } as const;

    if (
      input.unsafe ||
      report.overall === 'unsafe' ||
      classification === 'unsafe'
    ) {
      return {
        ...base,
        decision: 'stop',
        reason_code: 'unsafe_findings',
        rule_triggered: 'unsafe_priority_stop',
        rejected_paths: ['pass', 'fix', 're_evaluate'],
        next_pipeline: null,
      };
    }

    if (classification === 'contract_gap') {
      return {
        ...base,
        decision: 'stop',
        reason_code: 'contract_gap',
        rule_triggered: 'mvp0_contract_gap_stop',
        rejected_paths: ['pass', 'fix', 're_evaluate'],
        next_pipeline: null,
      };
    }

    if (classification === 'environment_failure') {
      return {
        ...base,
        decision: 'stop',
        reason_code: 'environment_failure',
        rule_triggered: 'environment_failure_no_generator_fix',
        rejected_paths: ['pass', 'fix', 're_evaluate'],
        next_pipeline: null,
      };
    }

    if (report.evidence_sufficiency === 'insufficient') {
      if (input.evaluatorAttempt < input.maxEvaluatorRetries) {
        return {
          ...base,
          decision: 're_evaluate',
          reason_code: 'insufficient_evidence',
          failure_classification: 'insufficient_evidence',
          rule_triggered: 'insufficient_evidence_retry_budget_available',
          rejected_paths: ['pass', 'fix'],
          next_pipeline: {
            module: 'evaluator',
            mode: 're_evaluate',
            attempt: input.evaluatorAttempt + 1,
          },
        };
      }

      return {
        ...base,
        decision: 'stop',
        reason_code: 'evaluator_retry_budget_exceeded',
        failure_classification: 'insufficient_evidence',
        rule_triggered: 'insufficient_evidence_retry_budget_exceeded',
        rejected_paths: ['pass', 'fix', 're_evaluate'],
        next_pipeline: null,
      };
    }

    if (
      (report.overall === 'pass' || report.overall === 'pass_with_risk') &&
      report.allow_unit_complete === true &&
      allMustCriteriaPassed(criteria)
    ) {
      return {
        ...base,
        decision: 'pass',
        reason_code:
          report.overall === 'pass_with_risk' ? 'pass_with_risk' : 'passed',
        failure_classification: 'none',
        rule_triggered: 'overall_pass_requires_all_must_criteria',
        rejected_paths: ['fix', 're_evaluate', 'stop'],
        next_pipeline: null,
      };
    }

    if (
      isGeneratorFixable(classification, failures) &&
      input.fixRound < input.maxFixRounds
    ) {
      return {
        ...base,
        decision: 'fix',
        reason_code: 'fixable_evaluator_failure',
        rule_triggered: 'fix_budget_available_for_auto_fixable_failure',
        rejected_paths: ['pass', 're_evaluate'],
        next_pipeline: {
          module: 'generator',
          mode: 'fix',
          fix_round: input.fixRound + 1,
          target_failures: targetFailures,
        },
      };
    }

    return {
      ...base,
      decision: 'stop',
      reason_code:
        input.fixRound >= input.maxFixRounds
          ? 'fix_budget_exceeded'
          : 'non_fixable_failure',
      rule_triggered: 'no_safe_next_action',
      rejected_paths: ['pass', 'fix', 're_evaluate'],
      next_pipeline: null,
    };
  }
}

function readFailures(
  report: Record<string, unknown>,
): readonly Record<string, unknown>[] {
  return Array.isArray(report.failures) ? report.failures.filter(isRecord) : [];
}

function readCriteria(
  report: Record<string, unknown>,
): readonly Record<string, unknown>[] {
  return Array.isArray(report.criteria_results)
    ? report.criteria_results.filter(isRecord)
    : [];
}

function readEvidenceRefs(
  report: Record<string, unknown>,
  failures: readonly Record<string, unknown>[],
  criteria: readonly Record<string, unknown>[],
): readonly string[] {
  const refs = new Set<string>();
  for (const evidence of Array.isArray(report.evidence)
    ? report.evidence.filter(isRecord)
    : []) {
    if (typeof evidence.ref === 'string') {
      refs.add(evidence.ref);
    }
  }
  for (const item of [...failures, ...criteria]) {
    if (Array.isArray(item.evidence)) {
      for (const ref of item.evidence) {
        if (typeof ref === 'string') {
          refs.add(ref);
        }
      }
    }
  }
  return [...refs];
}

function primaryClassification(
  report: Record<string, unknown>,
  failures: readonly Record<string, unknown>[],
  unsafe?: boolean,
): DecisionEngineResult['failure_classification'] {
  if (unsafe || report.overall === 'unsafe') {
    return 'unsafe';
  }
  if (hasItems(report.unsafe_findings)) {
    return 'unsafe';
  }
  if (hasItems(report.plan_gaps)) {
    return 'contract_gap';
  }
  if (hasItems(report.environment_issues)) {
    return 'environment_failure';
  }
  if (report.evidence_sufficiency === 'insufficient') {
    return 'insufficient_evidence';
  }

  const first = failures.find(
    (failure) => typeof failure.classification === 'string',
  );
  return isFailureClassification(first?.classification)
    ? first.classification
    : 'none';
}

function hasItems(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function allMustCriteriaPassed(
  criteria: readonly Record<string, unknown>[],
): boolean {
  const mustCriteria = criteria.filter(
    (criterion) => criterion.severity === 'must',
  );
  return (
    mustCriteria.length > 0 &&
    mustCriteria.every(
      (criterion) =>
        criterion.status === 'pass' &&
        Array.isArray(criterion.evidence) &&
        criterion.evidence.length > 0,
    )
  );
}

function isGeneratorFixable(
  classification: DecisionEngineResult['failure_classification'],
  failures: readonly Record<string, unknown>[],
): boolean {
  if (
    classification !== 'implementation_failure' &&
    classification !== 'test_failure'
  ) {
    return false;
  }
  return failures.some((failure) => failure.auto_fixable === true);
}

function isFailureClassification(
  value: unknown,
): value is DecisionEngineResult['failure_classification'] {
  return (
    value === 'implementation_failure' ||
    value === 'test_failure' ||
    value === 'environment_failure' ||
    value === 'contract_gap' ||
    value === 'unsafe' ||
    value === 'insufficient_evidence' ||
    value === 'none'
  );
}
