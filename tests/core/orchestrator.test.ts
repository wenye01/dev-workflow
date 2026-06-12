import { describe, expect, it } from 'vitest';

import { Orchestrator } from '../../src/core/orchestrator.js';
import type { GeneratorPipeline } from '../../src/generator/generator-pipeline.js';
import type { EvaluatorPipeline } from '../../src/evaluator/evaluator-pipeline.js';
import type { GeneratorPipelineResult } from '../../src/generator/generator-pipeline.js';
import type { EvaluatorPipelineResult } from '../../src/evaluator/evaluator-pipeline.js';
import type {
  DecisionEngineResult,
} from '../../src/core/decision-engine.js';
import type { ArtifactRef } from '../../src/core/types.js';
import type { ContextBuilderResult } from '../../src/context/context-builder.js';
import type { PlannerPipelineResult } from '../../src/planner/planner-pipeline.js';
import { asGitSha, asUnitId } from '../../src/core/types.js';

interface GeneratorCall {
  readonly mode: 'initial' | 'fix';
  readonly previousFailures: readonly Record<string, unknown>[];
}

function makeGenerator(): {
  readonly pipeline: Pick<GeneratorPipeline, 'build'>;
  readonly calls: GeneratorCall[];
} {
  const calls: GeneratorCall[] = [];
  const pipeline: Pick<GeneratorPipeline, 'build'> = {
    async build(options) {
      const mode = options.mode ?? 'initial';
      calls.push({
        mode,
        previousFailures: options.previousFailures ?? [],
      });
      return {
        generationInputRef: '.agentflow/gen-input.json',
        routingDecisionRef: '.agentflow/gen-routing.json',
        roleRunRequestRef: '.agentflow/gen-request.json',
        roleInputRef: '.agentflow/gen-role-input.json',
        roleOutputRef: '.agentflow/gen-role-output.json',
        changePackageRef: '.agentflow/change-package.json',
        unitStateRef: '.agentflow/unit-state.json',
        commitRef: {
          sha: asGitSha(`sha-${mode}-${calls.length}`),
        },
        mode,
        changedFiles: ['src/example.ts'],
      } as unknown as GeneratorPipelineResult;
    },
  };
  return { pipeline, calls };
}

interface EvaluatorCall {
  readonly attempt: number;
  readonly fixRound: number;
}

function makeEvaluator(decisions: readonly DecisionEngineResult[]): {
  readonly pipeline: Pick<EvaluatorPipeline, 'build'>;
  readonly calls: EvaluatorCall[];
} {
  const calls: EvaluatorCall[] = [];
  let index = 0;
  const pipeline: Pick<EvaluatorPipeline, 'build'> = {
    async build(options) {
      const decision =
        decisions[Math.min(index, decisions.length - 1)] ??
        ({
          decision: 'stop',
          reason_code: 'test_reason',
          evaluator_report: unitDecisionReportRef,
          target_failures: [],
          failure_classification: 'none',
          evidence_refs: [],
          rule_triggered: 'default',
          rejected_paths: [],
          next_pipeline: null,
          fix_round: options.fixRound ?? 0,
          max_fix_rounds: 1,
        } satisfies DecisionEngineResult);
      index += 1;
      calls.push({
        attempt: options.attempt ?? 0,
        fixRound: options.fixRound ?? 0,
      });
      const unitDecision: DecisionEngineResult = decision;
      return {
        evaluationInputRef: '.agentflow/eval-input.json',
        routingDecisionRef: '.agentflow/eval-routing.json',
        roleRunRequestRef: '.agentflow/eval-request.json',
        roleInputRef: '.agentflow/eval-role-input.json',
        roleOutputRef: '.agentflow/eval-role-output.json',
        evaluatorReportRef: '.agentflow/evaluator-report.json',
        unitDecisionRef: '.agentflow/unit-decision.json',
        unitStateRef: '.agentflow/unit-state.json',
        decision: decision.decision,
        unitDecision,
        verificationResults: [],
        failures: decision.decision === 'fix'
          ? [{ ref: 'failure-1', classification: 'test_failure' }]
          : [],
      } as unknown as EvaluatorPipelineResult;
    },
  };
  return { pipeline, calls };
}

const baseOptions = {
  repoRoot: '/repo',
  runId: 'run-test',
  context: {} as unknown as ContextBuilderResult,
  planner: {
    unitId: asUnitId('unit-1'),
    batchId: 'batch-001',
    maxFixRounds: 1,
    maxEvaluatorRetries: 1,
} as unknown as PlannerPipelineResult,
};

const unitDecisionReportRef = '.agentflow/unit-decision-report.json' as unknown as ArtifactRef;

describe('Orchestrator.runUnit', () => {
  it('passes immediately when the first evaluation passes', async () => {
    const generator = makeGenerator();
    const evaluator = makeEvaluator([
      {
        decision: 'pass',
        reason_code: 'passed',
        evaluator_report: unitDecisionReportRef,
        target_failures: [],
        failure_classification: 'none',
        evidence_refs: [],
        rule_triggered: 'overall_pass',
        rejected_paths: ['fix', 're_evaluate', 'stop'],
        next_pipeline: null,
        fix_round: 0,
        max_fix_rounds: 1,
      },
    ]);
    const orchestrator = new Orchestrator(
      generator.pipeline,
      evaluator.pipeline,
    );

    const result = await orchestrator.runUnit(baseOptions);

    expect(result.status).toBe('pass');
    expect(result.fixRounds).toBe(0);
    expect(result.evaluatorAttempts).toBe(1);
    expect(result.commitsCreated).toBe(1);
    expect(generator.calls).toHaveLength(1);
    expect(generator.calls[0]?.mode).toBe('initial');
  });

  it('runs a fix round then passes, feeding failures back to the generator', async () => {
    const generator = makeGenerator();
    const evaluator = makeEvaluator([
      {
        decision: 'fix',
        reason_code: 'fixable_evaluator_failure',
        evaluator_report: unitDecisionReportRef,
        target_failures: ['failure-1'],
        failure_classification: 'test_failure',
        evidence_refs: [],
        rule_triggered: 'fix_budget_available_for_auto_fixable_failure',
        rejected_paths: ['pass', 're_evaluate'],
        next_pipeline: {
          module: 'generator',
          mode: 'fix',
          fix_round: 1,
          target_failures: ['failure-1'],
        },
        fix_round: 0,
        max_fix_rounds: 1,
      },
      {
        decision: 'pass',
        reason_code: 'passed',
        evaluator_report: unitDecisionReportRef,
        target_failures: [],
        failure_classification: 'none',
        evidence_refs: [],
        rule_triggered: 'overall_pass',
        rejected_paths: ['fix', 're_evaluate', 'stop'],
        next_pipeline: null,
        fix_round: 1,
        max_fix_rounds: 1,
      },
    ]);
    const orchestrator = new Orchestrator(
      generator.pipeline,
      evaluator.pipeline,
    );

    const result = await orchestrator.runUnit(baseOptions);

    expect(result.status).toBe('pass');
    expect(result.fixRounds).toBe(1);
    expect(result.evaluatorAttempts).toBe(2);
    expect(result.commitsCreated).toBe(2);
    expect(generator.calls.map((call) => call.mode)).toEqual([
      'initial',
      'fix',
    ]);
    expect(generator.calls[1]?.previousFailures).toEqual([
      { ref: 'failure-1', classification: 'test_failure' },
    ]);
    expect(evaluator.calls[1]?.fixRound).toBe(1);
  });

  it('re-evaluates the same generation without regenerating', async () => {
    const generator = makeGenerator();
    const evaluator = makeEvaluator([
      {
        decision: 're_evaluate',
        reason_code: 'insufficient_evidence',
        evaluator_report: unitDecisionReportRef,
        target_failures: [],
        failure_classification: 'insufficient_evidence',
        evidence_refs: [],
        rule_triggered: 'insufficient_evidence_retry_budget_available',
        rejected_paths: ['pass', 'fix'],
        next_pipeline: {
          module: 'evaluator',
          mode: 're_evaluate',
          attempt: 1,
        },
        fix_round: 0,
        max_fix_rounds: 1,
      },
      {
        decision: 'pass',
        reason_code: 'passed',
        evaluator_report: unitDecisionReportRef,
        target_failures: [],
        failure_classification: 'none',
        evidence_refs: [],
        rule_triggered: 'overall_pass',
        rejected_paths: ['fix', 're_evaluate', 'stop'],
        next_pipeline: null,
        fix_round: 0,
        max_fix_rounds: 1,
      },
    ]);
    const orchestrator = new Orchestrator(
      generator.pipeline,
      evaluator.pipeline,
    );

    const result = await orchestrator.runUnit(baseOptions);

    expect(result.status).toBe('pass');
    expect(result.fixRounds).toBe(0);
    expect(result.evaluatorAttempts).toBe(2);
    expect(generator.calls).toHaveLength(1);
    expect(evaluator.calls[0]?.attempt).toBe(0);
    expect(evaluator.calls[1]?.attempt).toBe(1);
  });

  it('stops after fix budget is exhausted without another generator round', async () => {
    const generator = makeGenerator();
    const evaluator = makeEvaluator([
      {
        decision: 'fix',
        reason_code: 'fixable_evaluator_failure',
        evaluator_report: unitDecisionReportRef,
        target_failures: ['failure-1'],
        failure_classification: 'test_failure',
        evidence_refs: [],
        rule_triggered: 'fix_budget_available_for_auto_fixable_failure',
        rejected_paths: ['pass', 're_evaluate'],
        next_pipeline: {
          module: 'generator',
          mode: 'fix',
          fix_round: 1,
          target_failures: ['failure-1'],
        },
        fix_round: 0,
        max_fix_rounds: 1,
      },
      {
        decision: 'stop',
        reason_code: 'fix_budget_exceeded',
        evaluator_report: unitDecisionReportRef,
        target_failures: [],
        failure_classification: 'implementation_failure',
        evidence_refs: [],
        rule_triggered: 'no_safe_next_action',
        rejected_paths: ['pass', 'fix', 're_evaluate'],
        next_pipeline: null,
        fix_round: 1,
        max_fix_rounds: 1,
      },
    ]);
    const orchestrator = new Orchestrator(
      generator.pipeline,
      evaluator.pipeline,
    );

    const result = await orchestrator.runUnit(baseOptions);

    expect(result.status).toBe('stop');
    expect(result.decision).toBe('stop');
    expect(result.fixRounds).toBe(1);
    expect(result.evaluatorAttempts).toBe(2);
    expect(result.commitsCreated).toBe(2);
    expect(generator.calls.map((call) => call.mode)).toEqual([
      'initial',
      'fix',
    ]);
  });

  it('stops when the decision is stop', async () => {
    const generator = makeGenerator();
    const evaluator = makeEvaluator([
      {
        decision: 'stop',
        reason_code: 'environment_failure',
        evaluator_report: unitDecisionReportRef,
        target_failures: [],
        failure_classification: 'environment_failure',
        evidence_refs: [],
        rule_triggered: 'environment_failure_no_generator_fix',
        rejected_paths: ['pass', 'fix', 're_evaluate'],
        next_pipeline: null,
        fix_round: 0,
        max_fix_rounds: 1,
      },
    ]);
    const orchestrator = new Orchestrator(
      generator.pipeline,
      evaluator.pipeline,
    );

    const result = await orchestrator.runUnit(baseOptions);

    expect(result.status).toBe('stop');
    expect(result.decision).toBe('stop');
    expect(generator.calls).toHaveLength(1);
  });

  it('throws when a non-terminal decision has no next_pipeline', async () => {
    const generator = makeGenerator();
    const evaluator = makeEvaluator([
      {
        decision: 'fix',
        reason_code: 'invalid_fixture',
        evaluator_report: unitDecisionReportRef,
        target_failures: ['failure-1'],
        failure_classification: 'test_failure',
        evidence_refs: [],
        rule_triggered: 'invalid_fixture',
        rejected_paths: ['pass', 're_evaluate'],
        next_pipeline: null,
        fix_round: 0,
        max_fix_rounds: 1,
      },
    ]);
    const orchestrator = new Orchestrator(
      generator.pipeline,
      evaluator.pipeline,
    );

    await expect(async () => {
      await orchestrator.runUnit(baseOptions);
    }).rejects.toHaveProperty('code', 'AGENTFLOW_ORCHESTRATOR_INVALID_UNIT_DECISION');
  });

  it('uses evaluator.next_pipeline attempt for re-evaluate routing', async () => {
    const generator = makeGenerator();
    const evaluator = makeEvaluator([
      {
        decision: 're_evaluate',
        reason_code: 'insufficient_evidence',
        evaluator_report: unitDecisionReportRef,
        target_failures: [],
        failure_classification: 'insufficient_evidence',
        evidence_refs: [],
        rule_triggered: 'insufficient_evidence_retry_budget_available',
        rejected_paths: ['pass', 'fix'],
        next_pipeline: {
          module: 'evaluator',
          mode: 're_evaluate',
          attempt: 3,
        },
        fix_round: 0,
        max_fix_rounds: 1,
      },
      {
        decision: 'pass',
        reason_code: 'passed',
        evaluator_report: unitDecisionReportRef,
        target_failures: [],
        failure_classification: 'none',
        evidence_refs: [],
        rule_triggered: 'overall_pass',
        rejected_paths: ['fix', 're_evaluate', 'stop'],
        next_pipeline: null,
        fix_round: 0,
        max_fix_rounds: 1,
      },
    ]);
    const orchestrator = new Orchestrator(
      generator.pipeline,
      evaluator.pipeline,
    );

    const result = await orchestrator.runUnit(baseOptions);

    expect(result.status).toBe('pass');
    expect(evaluator.calls[1]?.attempt).toBe(3);
    expect(evaluator.calls).toHaveLength(2);
  });

  it('allows multiple fix rounds when max_fix_rounds is raised', async () => {
    const generator = makeGenerator();
    const evaluator = makeEvaluator([
      {
        decision: 'fix',
        reason_code: 'fixable_evaluator_failure',
        evaluator_report: unitDecisionReportRef,
        target_failures: ['failure-1'],
        failure_classification: 'test_failure',
        evidence_refs: [],
        rule_triggered: 'fix_budget_available_for_auto_fixable_failure',
        rejected_paths: ['pass', 're_evaluate'],
        next_pipeline: {
          module: 'generator',
          mode: 'fix',
          fix_round: 1,
          target_failures: ['failure-1'],
        },
        fix_round: 0,
        max_fix_rounds: 2,
      },
      {
        decision: 'fix',
        reason_code: 'fixable_evaluator_failure',
        evaluator_report: unitDecisionReportRef,
        target_failures: ['failure-1'],
        failure_classification: 'test_failure',
        evidence_refs: [],
        rule_triggered: 'fix_budget_available_for_auto_fixable_failure',
        rejected_paths: ['pass', 're_evaluate'],
        next_pipeline: {
          module: 'generator',
          mode: 'fix',
          fix_round: 2,
          target_failures: ['failure-1'],
        },
        fix_round: 1,
        max_fix_rounds: 2,
      },
      {
        decision: 'pass',
        reason_code: 'passed',
        evaluator_report: unitDecisionReportRef,
        target_failures: [],
        failure_classification: 'none',
        evidence_refs: [],
        rule_triggered: 'overall_pass',
        rejected_paths: ['fix', 're_evaluate', 'stop'],
        next_pipeline: null,
        fix_round: 2,
        max_fix_rounds: 2,
      },
    ]);
    const orchestrator = new Orchestrator(
      generator.pipeline,
      evaluator.pipeline,
    );

    const result = await orchestrator.runUnit({
      ...baseOptions,
      maxFixRounds: 2,
      maxEvaluatorRetries: 2,
    });

    expect(result.status).toBe('pass');
    expect(result.fixRounds).toBe(2);
    expect(result.evaluatorAttempts).toBe(3);
    expect(result.commitsCreated).toBe(3);
    expect(generator.calls.map((call) => call.mode)).toEqual([
      'initial',
      'fix',
      'fix',
    ]);
  });

  it('honors max_evaluator_retries when routing re-evaluate decisions', async () => {
    const generator = makeGenerator();
    const evaluator = makeEvaluator([
      {
        decision: 're_evaluate',
        reason_code: 'insufficient_evidence',
        evaluator_report: unitDecisionReportRef,
        target_failures: [],
        failure_classification: 'insufficient_evidence',
        evidence_refs: [],
        rule_triggered: 'insufficient_evidence_retry_budget_available',
        rejected_paths: ['pass', 'fix'],
        next_pipeline: {
          module: 'evaluator',
          mode: 're_evaluate',
          attempt: 2,
        },
        fix_round: 0,
        max_fix_rounds: 2,
      },
      {
        decision: 're_evaluate',
        reason_code: 'insufficient_evidence',
        evaluator_report: unitDecisionReportRef,
        target_failures: [],
        failure_classification: 'insufficient_evidence',
        evidence_refs: [],
        rule_triggered: 'insufficient_evidence_retry_budget_available',
        rejected_paths: ['pass', 'fix'],
        next_pipeline: {
          module: 'evaluator',
          mode: 're_evaluate',
          attempt: 3,
        },
        fix_round: 0,
        max_fix_rounds: 2,
      },
      {
        decision: 'pass',
        reason_code: 'passed',
        evaluator_report: unitDecisionReportRef,
        target_failures: [],
        failure_classification: 'none',
        evidence_refs: [],
        rule_triggered: 'overall_pass',
        rejected_paths: ['fix', 're_evaluate', 'stop'],
        next_pipeline: null,
        fix_round: 0,
        max_fix_rounds: 2,
      },
    ]);
    const orchestrator = new Orchestrator(
      generator.pipeline,
      evaluator.pipeline,
    );

    const result = await orchestrator.runUnit({
      ...baseOptions,
      maxFixRounds: 2,
      maxEvaluatorRetries: 2,
    });

    expect(result.status).toBe('pass');
    expect(evaluator.calls.map((call) => call.attempt)).toEqual([0, 2, 3]);
    expect(result.evaluatorAttempts).toBe(3);
  });

  it('returns run-time budgets and counters from callback-based tracking', async () => {
    const unitId = asUnitId('unit-1');
    const runId = 'run-test-metrics';
    let evaluatorBuilds = 0;

    const generator = {
      async build(options: {
        mode?: string;
        onCliProcessStarted?: () => void;
        onSchemaFailure?: () => void;
        [key: string]: unknown;
      }) {
        const mode = options.mode ?? 'initial';
        const commitSuffix =
          mode === 'initial'
            ? 'initial'
            : `fix-${mode}-${evaluatorBuilds}`;
        const changedFiles = ['src/example.ts'];
        options.onCliProcessStarted?.();
        return {
          generationInputRef: '.agentflow/gen-input.json',
          routingDecisionRef: '.agentflow/gen-routing.json',
          roleRunRequestRef: '.agentflow/gen-request.json',
          roleInputRef: '.agentflow/gen-role-input.json',
          roleOutputRef: '.agentflow/gen-role-output.json',
          changePackageRef: '.agentflow/change-package.json',
          unitStateRef: '.agentflow/unit-state.json',
          commitRef: {
            sha: asGitSha(`aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa${commitSuffix}`.slice(0, 40)),
          },
          mode,
          changedFiles,
        } as unknown as GeneratorPipelineResult;
      },
    };

    const evaluator = {
      async build(options: {
        onCliProcessStarted?: () => void;
        onSchemaFailure?: () => void;
        [key: string]: unknown;
      }) {
        options.onCliProcessStarted?.();
        if (evaluatorBuilds === 0) {
          options.onSchemaFailure?.();
        }

        const decisions: DecisionEngineResult[] = [
          {
            decision: 'fix',
            reason_code: 'fixable_evaluator_failure',
            evaluator_report: unitDecisionReportRef,
            target_failures: ['failure-1'],
            failure_classification: 'test_failure',
            evidence_refs: [],
            rule_triggered: 'fix_budget_available_for_auto_fixable_failure',
            rejected_paths: ['pass', 're_evaluate'],
            next_pipeline: {
              module: 'generator',
              mode: 'fix',
              fix_round: 1,
              target_failures: ['failure-1'],
            },
            fix_round: 0,
            max_fix_rounds: 2,
          },
          {
            decision: 'fix',
            reason_code: 'fixable_evaluator_failure',
            evaluator_report: unitDecisionReportRef,
            target_failures: ['failure-1'],
            failure_classification: 'test_failure',
            evidence_refs: [],
            rule_triggered: 'fix_budget_available_for_auto_fixable_failure',
            rejected_paths: ['pass', 're_evaluate'],
            next_pipeline: {
              module: 'generator',
              mode: 'fix',
              fix_round: 2,
              target_failures: ['failure-1'],
            },
            fix_round: 1,
            max_fix_rounds: 2,
          },
          {
            decision: 'pass',
            reason_code: 'passed',
            evaluator_report: unitDecisionReportRef,
            target_failures: [],
            failure_classification: 'none',
            evidence_refs: [],
            rule_triggered: 'overall_pass',
            rejected_paths: ['fix', 're_evaluate', 'stop'],
            next_pipeline: null,
            fix_round: 2,
            max_fix_rounds: 2,
          },
        ];

        const decision = decisions[evaluatorBuilds] ?? decisions[decisions.length - 1];
        evaluatorBuilds += 1;

        return {
          evaluationInputRef: '.agentflow/eval-input.json',
          routingDecisionRef: '.agentflow/eval-routing.json',
          roleRunRequestRef: '.agentflow/eval-request.json',
          roleInputRef: '.agentflow/eval-role-input.json',
          roleOutputRef: '.agentflow/eval-role-output.json',
          evaluatorReportRef: '.agentflow/evaluator-report.json',
          unitDecisionRef: '.agentflow/unit-decision.json',
          unitStateRef: '.agentflow/unit-state.json',
          unitDecision: decision,
          decision: decision.decision,
          verificationResults: [],
          failures: [{ ref: 'failure-1', classification: 'test_failure' }],
        } as unknown as EvaluatorPipelineResult;
      },
    };

    const orchestrator = new Orchestrator(
      generator as unknown as GeneratorPipeline,
      evaluator as unknown as EvaluatorPipeline,
    );
    let cliProcessStarted = 0;
    let schemaFailures = 0;
    const result = await orchestrator.runUnit({
      repoRoot: '/repo',
      runId,
      context: baseOptions.context,
      planner: {
        ...baseOptions.planner,
        runId,
      } as unknown as PlannerPipelineResult,
      maxFixRounds: 2,
      maxEvaluatorRetries: 1,
      onCliProcessStarted: () => {
        cliProcessStarted += 1;
      },
      onSchemaFailure: () => {
        schemaFailures += 1;
      },
    });

    expect(result.status).toBe('pass');
    expect(result.fixRounds).toBe(2);
    expect(result.evaluatorAttempts).toBe(3);
    expect(result.commitsCreated).toBe(3);
    expect(result.budgets).toEqual({
      maxFixRounds: 2,
      maxEvaluatorRetries: 1,
    });
    expect(result.counters.fixLoops).toBe(2);
    expect(result.counters.cliProcessesStarted).toBe(6);
    expect(result.counters.schemaFailures).toBe(1);
    expect(result.counters.commitsCreated).toBe(3);
    expect(cliProcessStarted).toBe(6);
    expect(schemaFailures).toBe(1);
  });
});
