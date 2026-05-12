import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { ArtifactStore } from '../artifacts/artifact-store.js';
import {
  artifactIndexPath,
  artifactPath,
  finalSummaryPath,
  parseArtifactRef,
  resolveArtifactRef,
  runStatePath,
} from '../artifacts/paths.js';
import type { ArtifactIndex } from '../artifacts/artifact-index.js';
import type { ArtifactRef, CommitRef, RunId } from '../core/types.js';
import { asRunId } from '../core/types.js';
import type { ContextBuilderResult } from '../context/context-builder.js';
import type { EvaluatorPipelineResult } from '../evaluator/evaluator-pipeline.js';
import type { GeneratorPipelineResult } from '../generator/generator-pipeline.js';
import type { PlannerPipelineResult } from '../planner/planner-pipeline.js';
import { SchemaRegistry } from '../schemas/registry.js';
import { isRecord, parseJsonObject } from '../schemas/validator.js';

const execFileAsync = promisify(execFile);

export interface FinalizerInput {
  readonly repoRoot: string;
  readonly runId: string;
  readonly context: ContextBuilderResult;
  readonly planner: PlannerPipelineResult;
  readonly generator: GeneratorPipelineResult;
  readonly evaluator: EvaluatorPipelineResult;
}

export interface FinalizerResult {
  readonly status: 'finalized' | 'stopped';
  readonly reportRef: ArtifactRef;
  readonly runStateRef: ArtifactRef;
  readonly resumeFrom: string | null;
  readonly cannotResumeReason?: string;
}

export interface ResumeResult {
  readonly status: 'finalized' | 'stopped' | 'resume_ready';
  readonly run_id: string;
  readonly action:
    | 'already_finalized'
    | 'already_stopped'
    | 'finalized_from_pass_decision'
    | 'stopped_from_terminal_decision'
    | 'resume_requires_pipeline_replay'
    | 'stopped_unrecoverable';
  readonly report_ref?: ArtifactRef;
  readonly cannot_resume_reason?: string;
  readonly resume_from?: string | null;
}

export class Finalizer {
  constructor(private readonly registry = SchemaRegistry.load()) {}

  async complete(input: FinalizerInput): Promise<FinalizerResult> {
    if (input.evaluator.decision === 'pass') {
      return await this.writeFinalReport(input);
    }

    return await this.writeDecisionStopReport(input);
  }

  async resume(options: {
    readonly repoPath: string;
    readonly runId: string;
  }): Promise<ResumeResult> {
    const repoRoot = path.resolve(options.repoPath);
    const runState = await readRunState(repoRoot);
    if (runState.run_id !== options.runId) {
      return await this.stopUnrecoverable({
        repoRoot,
        runId: options.runId,
        reasonCode: 'run_id_mismatch',
        classification: 'resume_integrity_failed',
        message: `Run state belongs to ${String(runState.run_id)}, not ${options.runId}.`,
        resumeFrom: null,
      });
    }

    const artifactIndex = await readArtifactIndex(repoRoot, this.registry);
    const existingFinal = latestRef(artifactIndex, options.runId, 'final_report');
    if (existingFinal) {
      return {
        status: 'finalized',
        run_id: options.runId,
        action: 'already_finalized',
        report_ref: existingFinal,
        resume_from: null,
      };
    }

    const existingStop = latestRef(artifactIndex, options.runId, 'stop_report');
    if (existingStop) {
      return {
        status: 'stopped',
        run_id: options.runId,
        action: 'already_stopped',
        report_ref: existingStop,
        resume_from: null,
      };
    }

    if (isRecord(runState.pending_transition)) {
      return await this.stopUnrecoverable({
        repoRoot,
        runId: options.runId,
        reasonCode: 'pending_transition_in_run_state',
        classification: 'resume_integrity_failed',
        message: 'Run state contains a pending transition that cannot be replayed safely.',
        resumeFrom: String(runState.resume_from ?? 'pending_transition'),
      });
    }

    const unitDecisionRef = latestRef(artifactIndex, options.runId, 'unit_decision');
    if (unitDecisionRef) {
      const decision = await readCanonicalPayload(repoRoot, unitDecisionRef);
      const decisionValue = String(decision.decision ?? '');
      if (decisionValue === 'pass') {
        const reportRef = await this.writeFinalReportFromArtifacts({
          repoRoot,
          runId: options.runId,
          artifactIndex,
          unitDecisionRef,
          decisionPayload: decision,
        });
        await this.writeRunState(repoRoot, {
          ...runState,
          status: 'finalized',
          last_stable_state: 'finalized',
          resume_from: null,
          updated_at: new Date().toISOString(),
        });
        await commitAgentflowArtifacts(repoRoot, options.runId, 'resume-finalize');
        return {
          status: 'finalized',
          run_id: options.runId,
          action: 'finalized_from_pass_decision',
          report_ref: reportRef,
          resume_from: null,
        };
      }

      const reportRef = await this.writeResumeStopReport({
        repoRoot,
        runId: options.runId,
        artifactIndex,
        runState,
        reasonCode: `unit_decision_${decisionValue || 'unknown'}`,
        classification: String(decision.failure_classification ?? 'unit_not_passed'),
        message: `Resume found terminal unit decision: ${decisionValue || 'unknown'}.`,
        resumeFrom: decisionValue || null,
        cannotResumeReason:
          'This MVP-0 runtime cannot continue provider-backed fix or re-evaluate work from resume without a persisted executable pipeline snapshot.',
        suggestedActions: [
          'Inspect the unit decision and evaluator report artifacts.',
          'Start a new run after addressing the failure, or rerun from the original task and config.',
        ],
      });
      await this.writeRunState(repoRoot, {
        ...runState,
        status: 'stopped',
        stop_reason: `unit_decision_${decisionValue || 'unknown'}`,
        resume_from: decisionValue || null,
        updated_at: new Date().toISOString(),
      });
      await commitAgentflowArtifacts(repoRoot, options.runId, 'resume-stop');
      return {
        status: 'stopped',
        run_id: options.runId,
        action: 'stopped_from_terminal_decision',
        report_ref: reportRef,
        resume_from: decisionValue || null,
        cannot_resume_reason:
          'This MVP-0 runtime cannot continue provider-backed fix or re-evaluate work from resume without a persisted executable pipeline snapshot.',
      };
    }

    const resumeFrom = inferResumePoint(artifactIndex, options.runId);
    return {
      status: 'resume_ready',
      run_id: options.runId,
      action: 'resume_requires_pipeline_replay',
      resume_from: resumeFrom,
      cannot_resume_reason:
        'A restart point was detected, but this MVP-0 CLI only performs idempotent report completion during resume.',
    };
  }

  private async writeFinalReport(input: FinalizerInput): Promise<FinalizerResult> {
    const artifactIndex = await readArtifactIndex(input.repoRoot, this.registry);
    const decisionPayload = await readCanonicalPayload(
      input.repoRoot,
      input.evaluator.unitDecisionRef,
    );
    const reportRef = await this.writeFinalReportFromArtifacts({
      repoRoot: input.repoRoot,
      runId: input.runId,
      artifactIndex,
      unitDecisionRef: input.evaluator.unitDecisionRef,
      decisionPayload,
      projectIndexManifestRef: await projectIndexManifestRef(
        input.repoRoot,
        input.context.outputs.projectIndexRef,
      ),
      verificationResults: input.evaluator.verificationResults,
      commitRefs: input.generator.commitRef ? [input.generator.commitRef] : [],
    });

    await this.writeRunState(input.repoRoot, {
      schema_version: 'agentflow.run_state.v1',
      run_id: input.runId,
      status: 'finalized',
      worktree_path: input.repoRoot,
      workspace_mode: 'git_worktree',
      current_batch_id: input.planner.batchId,
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_stable_state: 'finalized',
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
        commits_created: input.generator.commitRef ? 1 : 0,
        schema_failures: 0,
        fix_loops: input.generator.mode === 'fix' ? 1 : 0,
      },
      stop_reason: null,
    });
    await commitAgentflowArtifacts(input.repoRoot, input.runId, 'finalize');

    return {
      status: 'finalized',
      reportRef,
      runStateRef: runStatePath(),
      resumeFrom: null,
    };
  }

  private async writeDecisionStopReport(
    input: FinalizerInput,
  ): Promise<FinalizerResult> {
    const artifactIndex = await readArtifactIndex(input.repoRoot, this.registry);
    const decisionPayload = await readCanonicalPayload(
      input.repoRoot,
      input.evaluator.unitDecisionRef,
    );
    const reportRef = await this.writeResumeStopReport({
      repoRoot: input.repoRoot,
      runId: input.runId,
      artifactIndex,
      runState: await maybeReadRunState(input.repoRoot),
      reasonCode: String(decisionPayload.reason_code ?? input.evaluator.decision),
      classification: String(
        decisionPayload.failure_classification ?? 'unit_not_passed',
      ),
      message: `Unit decision is ${input.evaluator.decision}; run cannot finalize.`,
      resumeFrom: input.evaluator.decision,
      cannotResumeReason:
        input.evaluator.decision === 'stop'
          ? 'DecisionEngine selected stop; there is no safe next pipeline action.'
          : 'This MVP-0 runtime does not execute fix or re-evaluate loops from finalize.',
      suggestedActions: [
        'Inspect the evaluator report and unit decision artifacts.',
        'Address the reported failure before starting a new run.',
      ],
      projectIndexManifestRef: await projectIndexManifestRef(
        input.repoRoot,
        input.context.outputs.projectIndexRef,
      ),
    });

    await this.writeRunState(input.repoRoot, {
      schema_version: 'agentflow.run_state.v1',
      run_id: input.runId,
      status: 'stopped',
      worktree_path: input.repoRoot,
      workspace_mode: 'git_worktree',
      current_batch_id: input.planner.batchId,
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_stable_state: 'decision_ready',
      resume_from: input.evaluator.decision,
      config_snapshot_ref: null,
      budgets: {
        max_batches: 1,
        max_units: 1,
        max_fix_rounds: 1,
        max_evaluator_retries: 1,
      },
      counters: {
        cli_processes_started: 0,
        commits_created: input.generator.commitRef ? 1 : 0,
        schema_failures: 0,
        fix_loops: input.generator.mode === 'fix' ? 1 : 0,
      },
      stop_reason: String(decisionPayload.reason_code ?? input.evaluator.decision),
    });
    await commitAgentflowArtifacts(input.repoRoot, input.runId, 'stop');

    return {
      status: 'stopped',
      reportRef,
      runStateRef: runStatePath(),
      resumeFrom: input.evaluator.decision,
      cannotResumeReason:
        input.evaluator.decision === 'stop'
          ? 'DecisionEngine selected stop; there is no safe next pipeline action.'
          : 'This MVP-0 runtime does not execute fix or re-evaluate loops from finalize.',
    };
  }

  private async writeFinalReportFromArtifacts(options: {
    readonly repoRoot: string;
    readonly runId: string;
    readonly artifactIndex: ArtifactIndex;
    readonly unitDecisionRef: ArtifactRef;
    readonly decisionPayload: Record<string, unknown>;
    readonly projectIndexManifestRef?: ArtifactRef;
    readonly verificationResults?: readonly Record<string, unknown>[];
    readonly commitRefs?: readonly CommitRef[];
  }): Promise<ArtifactRef> {
    const finalRef = finalSummaryPath('json');
    const existing = latestRef(options.artifactIndex, options.runId, 'final_report');
    if (existing) {
      return existing;
    }

    const projectIndexRef =
      options.projectIndexManifestRef ??
      latestProjectIndexManifestRef(options.artifactIndex) ??
      artifactPath('project-index', 'manifest.json');
    const commitRefs =
      options.commitRefs ??
      uniqueCommitRefs(
        options.artifactIndex.artifacts
          .filter((entry) => entry.run_id === options.runId)
          .flatMap((entry) => entry.commit_refs),
      );
    const residualRisks = await residualRisksForDecision(
      options.repoRoot,
      options.decisionPayload,
    );
    const payload = {
      status: 'finalized',
      summary: 'Run finalized after the unit decision passed.',
      target_result: String(
        options.decisionPayload.reason_code ?? 'single unit accepted',
      ),
      unit_decisions: [options.unitDecisionRef],
      residual_risks: residualRisks,
      artifact_refs: refsForRun(options.artifactIndex, options.runId),
      commit_refs: commitRefs,
      project_index_manifest_ref: projectIndexRef,
      metrics: metricsSummary(options.artifactIndex, options.runId, {
        verificationResults: options.verificationResults,
      }),
    };

    const store = new ArtifactStore(options.repoRoot, this.registry);
    const result = await store.writeProgramArtifact({
      artifactType: 'final_report',
      ref: finalRef,
      payload,
      metadata: {
        runId: options.runId,
        artifactId: `final-report-${options.runId}`,
        producer: {
          kind: 'orchestrator',
          module: 'finalize',
        },
        inputArtifacts: [options.unitDecisionRef, artifactIndexPath()],
        commitRefs,
      },
      renderMarkdown: true,
    });
    return result.ref;
  }

  private async stopUnrecoverable(options: {
    readonly repoRoot: string;
    readonly runId: string;
    readonly reasonCode: string;
    readonly classification: string;
    readonly message: string;
    readonly resumeFrom: string | null;
  }): Promise<ResumeResult> {
    const artifactIndex = await readArtifactIndex(options.repoRoot, this.registry);
    const reportRef = await this.writeResumeStopReport({
      repoRoot: options.repoRoot,
      runId: options.runId,
      artifactIndex,
      runState: await maybeReadRunState(options.repoRoot),
      reasonCode: options.reasonCode,
      classification: options.classification,
      message: options.message,
      resumeFrom: options.resumeFrom,
      cannotResumeReason: options.message,
      suggestedActions: [
        'Inspect run state, artifact index, and recent role artifacts.',
        'Start a new run after correcting the inconsistent state.',
      ],
    });
    return {
      status: 'stopped',
      run_id: options.runId,
      action: 'stopped_unrecoverable',
      report_ref: reportRef,
      resume_from: options.resumeFrom,
      cannot_resume_reason: options.message,
    };
  }

  private async writeResumeStopReport(options: {
    readonly repoRoot: string;
    readonly runId: string;
    readonly artifactIndex: ArtifactIndex;
    readonly runState: Record<string, unknown> | null;
    readonly reasonCode: string;
    readonly classification: string;
    readonly message: string;
    readonly resumeFrom: string | null;
    readonly cannotResumeReason: string;
    readonly suggestedActions: readonly string[];
    readonly projectIndexManifestRef?: ArtifactRef;
  }): Promise<ArtifactRef> {
    const store = new ArtifactStore(options.repoRoot, this.registry);
    const commitRefs = uniqueCommitRefs(
      options.artifactIndex.artifacts
        .filter((entry) => entry.run_id === options.runId)
        .flatMap((entry) => entry.commit_refs),
    );
    const git = await gitSnapshot(options.repoRoot);
    const payload = {
      status: 'stopped',
      reason_code: options.reasonCode,
      classification: options.classification,
      message: options.message,
      run_state: options.runState ?? {},
      worktree_path:
        stringValue(options.runState?.worktree_path) ?? options.repoRoot,
      branch: git.branch,
      commits: commitRefs,
      recent_failure: recentFailure(options.artifactIndex, options.runId),
      project_index: {
        manifest_ref:
          options.projectIndexManifestRef ??
          latestProjectIndexManifestRef(options.artifactIndex) ??
          null,
        status: projectIndexStatus(options.artifactIndex),
      },
      context_builder: {
        status: latestRef(options.artifactIndex, options.runId, 'role_input')
          ? 'materialized'
          : 'unknown',
      },
      artifact_index_ref: artifactIndexPath(),
      resume_from: options.resumeFrom,
      cannot_resume_reason: options.cannotResumeReason,
      suggested_actions: options.suggestedActions,
    };
    const result = await store.writeProgramArtifact({
      artifactType: 'stop_report',
      ref: artifactPath('stop-report.json'),
      payload,
      metadata: {
        runId: options.runId,
        artifactId: `stop-report-${options.runId}`,
        producer: {
          kind: 'orchestrator',
          module: 'finalize',
        },
        inputArtifacts: [artifactIndexPath()],
        commitRefs,
      },
      renderMarkdown: true,
    });
    return result.ref;
  }

  private async writeRunState(
    repoRoot: string,
    state: Record<string, unknown>,
  ): Promise<ArtifactRef> {
    const store = new ArtifactStore(repoRoot, this.registry);
    await store.writeStateArtifact({
      artifactType: 'run_state',
      ref: runStatePath(),
      state,
      metadata: {
        runId: String(state.run_id),
        artifactId: `run-state-${String(state.run_id)}`,
        producer: {
          kind: 'system',
        },
      },
    });
    return runStatePath();
  }
}

async function readArtifactIndex(
  repoRoot: string,
  registry: SchemaRegistry,
): Promise<ArtifactIndex> {
  const index = parseJsonObject(
    await readFile(resolveArtifactRef(repoRoot, artifactIndexPath()), 'utf8'),
  );
  registry.assertCanonicalArtifact('artifact_index', index);
  return index as unknown as ArtifactIndex;
}

async function readRunState(repoRoot: string): Promise<Record<string, unknown>> {
  return parseJsonObject(
    await readFile(resolveArtifactRef(repoRoot, runStatePath()), 'utf8'),
  );
}

async function maybeReadRunState(
  repoRoot: string,
): Promise<Record<string, unknown> | null> {
  try {
    return await readRunState(repoRoot);
  } catch {
    return null;
  }
}

async function readCanonicalPayload(
  repoRoot: string,
  ref: ArtifactRef,
): Promise<Record<string, unknown>> {
  const artifact = parseJsonObject(
    await readFile(resolveArtifactRef(repoRoot, ref), 'utf8'),
  );
  return isRecord(artifact.payload) ? artifact.payload : artifact;
}

async function projectIndexManifestRef(
  repoRoot: string,
  projectIndexRef: ArtifactRef,
): Promise<ArtifactRef> {
  const payload = await readCanonicalPayload(repoRoot, projectIndexRef);
  const refs = isRecord(payload.project_index_refs)
    ? payload.project_index_refs
    : {};
  const manifest = isRecord(refs.manifest) ? refs.manifest.ref : null;
  return typeof manifest === 'string'
    ? parseArtifactRef(manifest)
    : artifactPath('project-index', 'manifest.json');
}

function latestRef(
  index: ArtifactIndex,
  runId: string,
  artifactType: string,
): ArtifactRef | undefined {
  return [...index.artifacts]
    .filter((entry) => entry.run_id === runId && entry.artifact_type === artifactType)
    .sort((left, right) => right.created_at.localeCompare(left.created_at))[0]
    ?.ref;
}

function refsForRun(index: ArtifactIndex, runId: string): readonly ArtifactRef[] {
  return index.artifacts
    .filter((entry) => entry.run_id === runId)
    .map((entry) => entry.ref)
    .sort();
}

function uniqueCommitRefs(commits: readonly CommitRef[]): readonly CommitRef[] {
  const bySha = new Map<string, CommitRef>();
  for (const commit of commits) {
    bySha.set(commit.sha, commit);
  }
  return [...bySha.values()];
}

function latestProjectIndexManifestRef(
  index: ArtifactIndex,
): ArtifactRef | undefined {
  const entry = index.artifacts.find((item) =>
    item.ref.endsWith('/project-index/manifest.json'),
  );
  return entry?.ref;
}

async function residualRisksForDecision(
  repoRoot: string,
  decisionPayload: Record<string, unknown>,
): Promise<readonly unknown[]> {
  const evaluatorReportRef = stringValue(decisionPayload.evaluator_report);
  if (!evaluatorReportRef) {
    return [];
  }
  try {
    const report = await readCanonicalPayload(repoRoot, parseArtifactRef(evaluatorReportRef));
    return Array.isArray(report.residual_risks) ? report.residual_risks : [];
  } catch {
    return [];
  }
}

function metricsSummary(
  index: ArtifactIndex,
  runId: string,
  extra: { readonly verificationResults?: readonly Record<string, unknown>[] },
): Record<string, unknown> {
  const entries = index.artifacts.filter((entry) => entry.run_id === runId);
  return {
    artifact_count: entries.length,
    role_output_count: entries.filter((entry) => entry.artifact_type === 'role_output')
      .length,
    routing_decision_count: entries.filter(
      (entry) => entry.artifact_type === 'routing_decision',
    ).length,
    commit_count: uniqueCommitRefs(entries.flatMap((entry) => entry.commit_refs))
      .length,
    verification: {
      total: extra.verificationResults?.length ?? 0,
      passed:
        extra.verificationResults?.filter((item) => item.status === 'passed')
          .length ?? 0,
      failed:
        extra.verificationResults?.filter((item) => item.status === 'failed')
          .length ?? 0,
    },
  };
}

async function gitSnapshot(
  repoRoot: string,
): Promise<{ readonly branch: string; readonly head: string | null }> {
  try {
    const [{ stdout: branch }, { stdout: head }] = await Promise.all([
      execFileAsync('git', ['branch', '--show-current'], { cwd: repoRoot }),
      execFileAsync('git', ['rev-parse', '--short=12', 'HEAD'], {
        cwd: repoRoot,
      }),
    ]);
    return {
      branch: branch.trim() || 'HEAD',
      head: head.trim() || null,
    };
  } catch {
    return { branch: 'unknown', head: null };
  }
}

function recentFailure(
  index: ArtifactIndex,
  runId: string,
): Record<string, unknown> | null {
  const entry = [...index.artifacts]
    .filter(
      (item) =>
        item.run_id === runId &&
        ['role_output', 'evaluator_report', 'unit_decision'].includes(
          item.artifact_type,
        ),
    )
    .sort((left, right) => right.created_at.localeCompare(left.created_at))[0];
  if (!entry) {
    return null;
  }
  return {
    artifact_ref: entry.ref,
    artifact_type: entry.artifact_type,
    producer: entry.producer,
  };
}

function projectIndexStatus(index: ArtifactIndex): string {
  return latestProjectIndexManifestRef(index) ? 'available' : 'unknown';
}

function inferResumePoint(index: ArtifactIndex, runId: string): string | null {
  const types = new Set(
    index.artifacts
      .filter((entry) => entry.run_id === runId)
      .map((entry) => entry.artifact_type),
  );
  if (types.has('evaluator_report')) {
    return 'decision';
  }
  if (types.has('role_output')) {
    return 'aggregate_role_output';
  }
  if (types.has('role_run_request')) {
    return 'run_role';
  }
  if (types.has('planner_package')) {
    return 'generator';
  }
  return null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

async function commitAgentflowArtifacts(
  repoRoot: string,
  runId: string,
  phase: 'finalize' | 'stop' | 'resume-finalize' | 'resume-stop',
): Promise<void> {
  if (!(await isGitRepository(repoRoot))) {
    return;
  }

  await execFileAsync('git', ['add', '--', '.agentflow'], { cwd: repoRoot });
  const { stdout } = await execFileAsync(
    'git',
    ['diff', '--cached', '--name-only', '--', '.agentflow'],
    { cwd: repoRoot },
  );
  if (!stdout.trim()) {
    return;
  }

  await execFileAsync(
    'git',
    ['commit', '-m', `agentflow ${phase}: ${runId}`],
    { cwd: repoRoot },
  );
}

async function isGitRepository(repoRoot: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--is-inside-work-tree'],
      { cwd: repoRoot },
    );
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

export function runIdFromString(value: string): RunId {
  return asRunId(value);
}
