import { describe, expect, it } from 'vitest';

import { DecisionEngine } from '../../src/core/decision-engine.js';
import { parseArtifactRef } from '../../src/artifacts/paths.js';

describe('DecisionEngine', () => {
  const evaluatorReportRef = parseArtifactRef(
    '.agentflow/units/auth-refresh/evaluator-report.0.json',
  );

  it('passes only when all must criteria passed with sufficient evidence', () => {
    const result = new DecisionEngine().decide({
      evaluatorReportRef,
      evaluatorReport: report({
        overall: 'pass',
        evidence_sufficiency: 'sufficient_for_pass',
        allow_unit_complete: true,
        criteria_results: [
          {
            criterion: 'criterion-single-unit',
            status: 'pass',
            severity: 'must',
            evidence: ['ev-tests'],
            reason: 'Tests passed.',
          },
        ],
      }),
      fixRound: 0,
      maxFixRounds: 1,
      evaluatorAttempt: 0,
      maxEvaluatorRetries: 1,
    });

    expect(result.decision).toBe('pass');
    expect(result.rule_triggered).toBe(
      'overall_pass_requires_all_must_criteria',
    );
  });

  it('routes auto-fixable test failures to generator fix while budget remains', () => {
    const result = new DecisionEngine().decide({
      evaluatorReportRef,
      evaluatorReport: report({
        overall: 'fail',
        failures: [
          {
            ref: 'failure-tests',
            criterion: 'criterion-single-unit',
            description: 'Tests failed.',
            classification: 'test_failure',
            severity: 'must',
            auto_fixable: true,
            evidence: ['ev-tests'],
          },
        ],
      }),
      fixRound: 0,
      maxFixRounds: 1,
      evaluatorAttempt: 0,
      maxEvaluatorRetries: 1,
    });

    expect(result.decision).toBe('fix');
    expect(result.next_pipeline).toMatchObject({
      module: 'generator',
      mode: 'fix',
    });
  });

  it('prioritizes unsafe and contract gaps as stop decisions', () => {
    const engine = new DecisionEngine();
    expect(
      engine.decide({
        evaluatorReportRef,
        evaluatorReport: report({ overall: 'unsafe' }),
        fixRound: 0,
        maxFixRounds: 1,
        evaluatorAttempt: 0,
        maxEvaluatorRetries: 1,
      }).decision,
    ).toBe('stop');

    const contractGap = engine.decide({
      evaluatorReportRef,
      evaluatorReport: report({
        overall: 'fail',
        plan_gaps: ['Missing must criterion.'],
      }),
      fixRound: 0,
      maxFixRounds: 1,
      evaluatorAttempt: 0,
      maxEvaluatorRetries: 1,
    });
    expect(contractGap.decision).toBe('stop');
    expect(contractGap.failure_classification).toBe('contract_gap');
  });

  it('re-evaluates insufficient evidence only while retry budget remains', () => {
    const engine = new DecisionEngine();
    const input = {
      evaluatorReportRef,
      evaluatorReport: report({
        evidence_sufficiency: 'insufficient',
        allow_unit_complete: false,
      }),
      fixRound: 0,
      maxFixRounds: 1,
      evaluatorAttempt: 0,
      maxEvaluatorRetries: 1,
    };

    expect(engine.decide(input).decision).toBe('re_evaluate');
    expect(
      engine.decide({
        ...input,
        evaluatorAttempt: 1,
      }).decision,
    ).toBe('stop');
  });
});

function report(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    overall: 'fail',
    summary: 'Evaluator report.',
    contract_completeness: {
      status: 'complete',
      missing: [],
    },
    evidence_sufficiency: 'sufficient_for_fail',
    criteria_results: [
      {
        criterion: 'criterion-single-unit',
        status: 'fail',
        severity: 'must',
        evidence: ['ev-tests'],
        reason: 'Tests failed.',
      },
    ],
    evidence: [
      {
        ref: 'ev-tests',
        type: 'test_result',
        summary: 'npm test failed.',
        supports: ['criterion-single-unit'],
        confidence: 'medium',
      },
    ],
    failures: [],
    plan_gaps: [],
    environment_issues: [],
    unsafe_findings: [],
    allow_unit_complete: false,
    allow_batch_continue: false,
    eligible_next_actions: ['stop'],
    blocked_next_actions: [],
    residual_risks: [],
    ...overrides,
  };
}
