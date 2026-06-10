import { describe, expect, it } from 'vitest';

import { Orchestrator } from '../../src/core/orchestrator.js';
import type { GeneratorPipeline } from '../../src/generator/generator-pipeline.js';
import type { EvaluatorPipeline } from '../../src/evaluator/evaluator-pipeline.js';
import type { GeneratorPipelineResult } from '../../src/generator/generator-pipeline.js';
import type { EvaluatorPipelineResult } from '../../src/evaluator/evaluator-pipeline.js';
import type { UnitDecision } from '../../src/core/decision-engine.js';
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

function makeEvaluator(decisions: readonly UnitDecision[]): {
  readonly pipeline: Pick<EvaluatorPipeline, 'build'>;
  readonly calls: EvaluatorCall[];
} {
  const calls: EvaluatorCall[] = [];
  let index = 0;
  const pipeline: Pick<EvaluatorPipeline, 'build'> = {
    async build(options) {
      const decision = decisions[Math.min(index, decisions.length - 1)];
      index += 1;
      calls.push({
        attempt: options.attempt ?? 0,
        fixRound: options.fixRound ?? 0,
      });
      return {
        evaluationInputRef: '.agentflow/eval-input.json',
        routingDecisionRef: '.agentflow/eval-routing.json',
        roleRunRequestRef: '.agentflow/eval-request.json',
        roleInputRef: '.agentflow/eval-role-input.json',
        roleOutputRef: '.agentflow/eval-role-output.json',
        evaluatorReportRef: '.agentflow/evaluator-report.json',
        unitDecisionRef: '.agentflow/unit-decision.json',
        unitStateRef: '.agentflow/unit-state.json',
        decision,
        verificationResults: [],
        failures:
          decision === 'fix'
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

describe('Orchestrator.runUnit', () => {
  it('passes immediately when the first evaluation passes', async () => {
    const generator = makeGenerator();
    const evaluator = makeEvaluator(['pass']);
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
    const evaluator = makeEvaluator(['fix', 'pass']);
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
    const evaluator = makeEvaluator(['re_evaluate', 'pass']);
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
    const evaluator = makeEvaluator(['fix', 'stop']);
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
    const evaluator = makeEvaluator(['stop']);
    const orchestrator = new Orchestrator(
      generator.pipeline,
      evaluator.pipeline,
    );

    const result = await orchestrator.runUnit(baseOptions);

    expect(result.status).toBe('stop');
    expect(result.decision).toBe('stop');
    expect(generator.calls).toHaveLength(1);
  });
});
