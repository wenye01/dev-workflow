import { mkdtemp, readFile } from 'node:fs/promises';
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
} from '../../src/artifacts/paths.js';
import { asUnitId } from '../../src/core/types.js';
import { Finalizer } from '../../src/reporting/finalizer.js';

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
