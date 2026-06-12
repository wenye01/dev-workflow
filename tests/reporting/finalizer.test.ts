import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ArtifactStore } from '../../src/artifacts/artifact-store.js';
import {
  artifactIndexPath,
  artifactPath,
  finalSummaryPath,
  resolveArtifactRef,
  runStatePath,
  unitDecisionPath,
  unitStatePath,
} from '../../src/artifacts/paths.js';
import {
  asGitSha,
  asRunId,
  asUnitId,
  type ArtifactRef,
} from '../../src/core/types.js';
import { Finalizer } from '../../src/reporting/finalizer.js';
import type { ContextBuilderResult } from '../../src/context/context-builder.js';
import type { PlannerPipelineResult } from '../../src/planner/planner-pipeline.js';
import type { GeneratorPipelineResult } from '../../src/generator/generator-pipeline.js';
import type { EvaluatorPipelineResult } from '../../src/evaluator/evaluator-pipeline.js';

describe('Finalizer resume', () => {
  it('finalizes a passed unit decision exactly once', async () => {
    const repoRoot = await makeRunRoot();
    const runId = 'run-finalizer';
    const unitId = asUnitId('unit-auth-001');
    await seedRunState(repoRoot, runId);
    await seedUnitDecision(repoRoot, runId, unitId, 'pass');

    const result = await new Finalizer().resume({
      repoPath: repoRoot,
      runId,
    });

    expect(result).toMatchObject({
      status: 'finalized',
      action: 'finalized_from_pass_decision',
      report_ref: finalSummaryPath('json'),
    });

    const finalReport = JSON.parse(
      await readFile(
        resolveArtifactRef(repoRoot, finalSummaryPath('json')),
        'utf8',
      ),
    ) as Record<string, unknown>;
    expect(finalReport).toMatchObject({
      artifact_type: 'final_report',
      payload: {
        status: 'finalized',
        target_result: 'passed',
        unit_decisions: [unitDecisionPath(unitId, 0)],
      },
    });

    const second = await new Finalizer().resume({
      repoPath: repoRoot,
      runId,
    });
    expect(second).toMatchObject({
      status: 'finalized',
      action: 'already_finalized',
      report_ref: finalSummaryPath('json'),
    });

    const index = JSON.parse(
      await readFile(resolveArtifactRef(repoRoot, artifactIndexPath()), 'utf8'),
    ) as { readonly artifacts: readonly { readonly artifact_type: string }[] };
    expect(
      index.artifacts.filter((entry) => entry.artifact_type === 'final_report'),
    ).toHaveLength(1);
  });

  it('writes an explicit stop report for non-pass terminal decisions', async () => {
    const repoRoot = await makeRunRoot();
    const runId = 'run-stop';
    const unitId = asUnitId('unit-auth-001');
    await seedRunState(repoRoot, runId);
    await seedUnitDecision(repoRoot, runId, unitId, 'stop');

    const result = await new Finalizer().resume({
      repoPath: repoRoot,
      runId,
    });

    expect(result).toMatchObject({
      status: 'stopped',
      action: 'stopped_from_terminal_decision',
      report_ref: artifactPath('stop-report.json'),
      resume_from: 'stop',
    });

    const stopReport = JSON.parse(
      await readFile(
        resolveArtifactRef(repoRoot, artifactPath('stop-report.json')),
        'utf8',
      ),
    ) as Record<string, unknown>;
    expect(stopReport).toMatchObject({
      artifact_type: 'stop_report',
      payload: {
        status: 'stopped',
        reason_code: 'unit_decision_stop',
        resume_from: 'stop',
      },
    });
  });

  it('writes runtime budgets and counters on final run_state for pass', async () => {
    const repoRoot = await makeRunRoot();
    const runId = 'run-finalizer-pass-complete';
    const unitId = asUnitId('unit-final-001');
    const projectIndexRef = artifactPath('context', 'project-index-ref.json');
    const unitDecisionRef = unitDecisionPath(unitId, 0);

    await writeProjectIndexRefArtifact(repoRoot, projectIndexRef);
    await seedCompleteUnitDecision({
      repoRoot,
      runId,
      unitId,
      ref: unitDecisionRef,
      decision: 'pass',
      reasonCode: 'unit_complete',
    });

    const planner = {
      batchId: 'batch-001',
      maxFixRounds: 2,
      maxEvaluatorRetries: 4,
      unitId,
    } as unknown as PlannerPipelineResult;
    const generator = {
      generationInputRef: artifactPath('units', unitId, 'generation-input.initial.json'),
      routingDecisionRef: artifactPath('units', unitId, 'generator-routing.initial.json'),
      roleRunRequestRef: artifactPath('units', unitId, 'generator-request.initial.json'),
      roleInputRef: artifactPath('units', unitId, 'generator-input.initial.json'),
      roleOutputRef: artifactPath('units', unitId, 'generator-output.initial.json'),
      changePackageRef: artifactPath('units', unitId, 'change-package.initial.json'),
      unitStateRef: unitStatePath(unitId),
      commitRef: {
        sha: asGitSha('1111111111111111111111111111111111111111'),
      },
      mode: 'initial',
      changedFiles: ['src/example.ts'],
    } as unknown as GeneratorPipelineResult;
    const evaluator = {
      evaluationInputRef: artifactPath('units', unitId, 'evaluation-input.0.json'),
      routingDecisionRef: artifactPath('units', unitId, 'evaluator-routing.0.json'),
      roleRunRequestRef: artifactPath('units', unitId, 'evaluator-request.0.json'),
      roleInputRef: artifactPath('units', unitId, 'evaluator-input.0.json'),
      roleOutputRef: artifactPath('units', unitId, 'evaluator-output.0.json'),
      evaluatorReportRef: artifactPath('units', unitId, 'evaluator-report.0.json'),
      unitDecisionRef,
      unitStateRef: unitStatePath(unitId),
      unitDecision: {
        decision: 'pass',
        reason_code: 'unit_complete',
        evaluator_report: artifactPath('units', unitId, 'evaluator-report.0.json'),
        target_failures: [],
        failure_classification: 'none',
        evidence_refs: [],
        rule_triggered: 'finalizer_complete',
        rejected_paths: ['fix', 're_evaluate', 'stop'],
        next_pipeline: null,
        fix_round: 0,
        max_fix_rounds: 2,
      },
      decision: 'pass',
      verificationResults: [],
      failures: [],
    } as unknown as EvaluatorPipelineResult;

    const context = {
      outputs: {
        projectIndexRef,
      },
    } as unknown as ContextBuilderResult;

    const result = await new Finalizer().complete({
      repoRoot,
      runId,
      context,
      planner,
      generator,
      evaluator,
      budgets: {
        maxFixRounds: 2,
        maxEvaluatorRetries: 4,
      },
      counters: {
        fixLoops: 2,
        commitsCreated: 1,
        cliProcessesStarted: 3,
        schemaFailures: 1,
      },
      fixLoops: 2,
      commitsCreated: 1,
    });

    expect(result.status).toBe('finalized');
    const runState = JSON.parse(
      await readFile(resolveArtifactRef(repoRoot, runStatePath()), 'utf8'),
    ) as {
      readonly budgets: { readonly max_fix_rounds: number; readonly max_evaluator_retries: number };
      readonly counters: {
        readonly cli_processes_started: number;
        readonly commits_created: number;
        readonly schema_failures: number;
        readonly fix_loops: number;
      };
    };
    expect(runState.budgets.max_fix_rounds).toBe(2);
    expect(runState.budgets.max_evaluator_retries).toBe(4);
    expect(runState.counters.cli_processes_started).toBe(3);
    expect(runState.counters.commits_created).toBe(1);
    expect(runState.counters.schema_failures).toBe(1);
    expect(runState.counters.fix_loops).toBe(2);
  });

  it('writes runtime budgets and counters on final run_state for stop', async () => {
    const repoRoot = await makeRunRoot();
    const runId = 'run-finalizer-stop-complete';
    const unitId = asUnitId('unit-final-002');
    const projectIndexRef = artifactPath('context', 'project-index-ref.json');
    const unitDecisionRef = unitDecisionPath(unitId, 0);

    await writeProjectIndexRefArtifact(repoRoot, projectIndexRef);
    await seedCompleteUnitDecision({
      repoRoot,
      runId,
      unitId,
      ref: unitDecisionRef,
      decision: 'stop',
      reasonCode: 'unit_decision_stop',
    });

    const planner = {
      batchId: 'batch-001',
      maxFixRounds: 1,
      maxEvaluatorRetries: 1,
      unitId,
    } as unknown as PlannerPipelineResult;
    const generator = {
      generationInputRef: artifactPath('units', unitId, 'generation-input.initial.json'),
      routingDecisionRef: artifactPath('units', unitId, 'generator-routing.initial.json'),
      roleRunRequestRef: artifactPath('units', unitId, 'generator-request.initial.json'),
      roleInputRef: artifactPath('units', unitId, 'generator-input.initial.json'),
      roleOutputRef: artifactPath('units', unitId, 'generator-output.initial.json'),
      changePackageRef: artifactPath('units', unitId, 'change-package.initial.json'),
      unitStateRef: unitStatePath(unitId),
      commitRef: {
        sha: asGitSha('2222222222222222222222222222222222222222'),
      },
      mode: 'initial',
      changedFiles: ['src/example.ts'],
    } as unknown as GeneratorPipelineResult;
    const evaluator = {
      evaluationInputRef: artifactPath('units', unitId, 'evaluation-input.0.json'),
      routingDecisionRef: artifactPath('units', unitId, 'evaluator-routing.0.json'),
      roleRunRequestRef: artifactPath('units', unitId, 'evaluator-request.0.json'),
      roleInputRef: artifactPath('units', unitId, 'evaluator-input.0.json'),
      roleOutputRef: artifactPath('units', unitId, 'evaluator-output.0.json'),
      evaluatorReportRef: artifactPath('units', unitId, 'evaluator-report.0.json'),
      unitDecisionRef,
      unitStateRef: unitStatePath(unitId),
      unitDecision: {
        decision: 'stop',
        reason_code: 'unit_decision_stop',
        evaluator_report: artifactPath('units', unitId, 'evaluator-report.0.json'),
        target_failures: [],
        failure_classification: 'environment_failure',
        evidence_refs: [],
        rule_triggered: 'finalizer_stop',
        rejected_paths: ['pass'],
        next_pipeline: null,
        fix_round: 0,
        max_fix_rounds: 1,
      },
      decision: 'stop',
      verificationResults: [],
      failures: [],
    } as unknown as EvaluatorPipelineResult;

    const context = {
      outputs: {
        projectIndexRef,
      },
    } as unknown as ContextBuilderResult;

    const result = await new Finalizer().complete({
      repoRoot,
      runId,
      context,
      planner,
      generator,
      evaluator,
      budgets: {
        maxFixRounds: 1,
        maxEvaluatorRetries: 1,
      },
      counters: {
        fixLoops: 0,
        commitsCreated: 1,
        cliProcessesStarted: 2,
        schemaFailures: 0,
      },
      fixLoops: 0,
      commitsCreated: 1,
    });

    expect(result.status).toBe('stopped');
    const runState = JSON.parse(
      await readFile(resolveArtifactRef(repoRoot, runStatePath()), 'utf8'),
    ) as {
      readonly status: string;
      readonly stop_reason: string;
      readonly budgets: { readonly max_fix_rounds: number; readonly max_evaluator_retries: number };
      readonly counters: {
        readonly cli_processes_started: number;
        readonly commits_created: number;
        readonly schema_failures: number;
        readonly fix_loops: number;
      };
    };
    expect(runState.status).toBe('stopped');
    expect(runState.stop_reason).toBe('unit_decision_stop');
    expect(runState.budgets.max_fix_rounds).toBe(1);
    expect(runState.budgets.max_evaluator_retries).toBe(1);
    expect(runState.counters.cli_processes_started).toBe(2);
    expect(runState.counters.commits_created).toBe(1);
    expect(runState.counters.schema_failures).toBe(0);
    expect(runState.counters.fix_loops).toBe(0);
  });
});

async function makeRunRoot(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), 'agentflow-finalizer-'));
}

async function seedRunState(repoRoot: string, runId: string): Promise<void> {
  const now = '2026-05-12T00:00:00.000Z';
  await new ArtifactStore(repoRoot).writeStateArtifact({
    artifactType: 'run_state',
    ref: runStatePath(),
    state: {
      schema_version: 'agentflow.run_state.v1',
      run_id: runId,
      status: 'running',
      worktree_path: repoRoot,
      workspace_mode: 'git_worktree',
      current_batch_id: 'batch-001',
      started_at: now,
      updated_at: now,
      last_stable_state: 'decision_ready',
      resume_from: null,
      config_snapshot_ref: null,
      budgets: {
        max_batches: 1,
        max_units: 1,
        max_fix_rounds: 1,
        max_evaluator_retries: 1,
      },
      counters: {
        cli_processes_started: 0,
        commits_created: 0,
        schema_failures: 0,
        fix_loops: 0,
      },
      stop_reason: null,
    },
    metadata: {
      runId,
      artifactId: `run-state-${runId}`,
      producer: { kind: 'system' },
      createdAt: now,
    },
  });
}

async function writeProjectIndexRefArtifact(
  repoRoot: string,
  ref: ArtifactRef,
): Promise<void> {
  const target = resolveArtifactRef(repoRoot, ref);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(
    target,
    JSON.stringify(
      {
        project_index_refs: {
          manifest: {
            ref: artifactPath('project-index', 'manifest.json'),
          },
        },
      },
      null,
      2,
    ),
    'utf8',
  );
}

async function seedCompleteUnitDecision(options: {
  readonly repoRoot: string;
  readonly runId: string;
  readonly unitId: ReturnType<typeof asUnitId>;
  readonly ref: ArtifactRef;
  readonly decision: 'pass' | 'stop';
  readonly reasonCode: string;
}): Promise<void> {
  const artifact = {
    decision: options.decision,
    reason_code: options.reasonCode,
    evaluator_report: artifactPath(
      'units',
      options.unitId,
      'evaluator-report.0.json',
    ),
    target_failures: [],
    failure_classification:
      options.decision === 'pass' ? 'none' : 'environment_failure',
    evidence_refs: [],
    rule_triggered: `integration-${options.decision}`,
    rejected_paths:
      options.decision === 'pass'
        ? ['fix', 're_evaluate', 'stop']
        : ['pass'],
    next_pipeline: null,
    fix_round: 0,
    max_fix_rounds: 1,
  };
  const store = new ArtifactStore(options.repoRoot);
  await store.writeProgramArtifact({
    artifactType: 'unit_decision',
    ref: options.ref,
    payload: artifact,
    metadata: {
      runId: options.runId,
      artifactId: `unit-decision-${asRunId(options.runId)}-${String(options.unitId)}-0`,
      producer: {
        kind: 'system',
        module: 'decision',
        role: 'decision.engine',
      },
      batchId: 'batch-001',
      unitId: options.unitId,
      attempt: 0,
      inputArtifacts: [],
      commitRefs: [],
    },
    renderMarkdown: true,
  });
}

async function seedUnitDecision(
  repoRoot: string,
  runId: string,
  unitId: ReturnType<typeof asUnitId>,
  decision: 'pass' | 'stop',
): Promise<void> {
  await new ArtifactStore(repoRoot).writeProgramArtifact({
    artifactType: 'unit_decision',
    ref: unitDecisionPath(unitId, 0),
    payload: {
      decision,
      reason_code: decision === 'pass' ? 'passed' : 'unit_decision_stop',
      evaluator_report: artifactPath(
        'units',
        unitId,
        'evaluator-report.0.json',
      ),
      target_failures: [],
      failure_classification: decision === 'pass' ? 'none' : 'unsafe',
      evidence_refs: [],
      rule_triggered: 'test_seeded_decision',
      rejected_paths:
        decision === 'pass' ? ['fix', 're_evaluate', 'stop'] : ['pass'],
      next_pipeline: null,
      fix_round: 0,
      max_fix_rounds: 1,
    },
    metadata: {
      runId,
      batchId: 'batch-001',
      unitId,
      attempt: 0,
      producer: {
        kind: 'system',
        module: 'decision',
        role: 'decision.engine',
      },
      createdAt: '2026-05-12T00:00:01.000Z',
    },
  });
}
