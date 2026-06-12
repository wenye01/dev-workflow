import { loadAgentflowConfig } from '../config/config-loader.js';
import { ContextBuilder } from '../context/context-builder.js';
import { EvaluatorPipelineResult } from '../evaluator/evaluator-pipeline.js';
import { GeneratorPipelineResult } from '../generator/generator-pipeline.js';
import {
  PlannerPipeline,
  type PlannerPipelineResult,
} from '../planner/planner-pipeline.js';
import { Finalizer, type FinalizerResult } from '../reporting/finalizer.js';
import {
  DEFAULT_MAX_EVALUATOR_RETRIES,
  DEFAULT_MAX_FIX_ROUNDS,
} from './budgets.js';
import { Orchestrator, type OrchestratorResult } from './orchestrator.js';
import type { ContextBuilderResult } from '../context/context-builder.js';

export interface RunOrchestratorOptions {
  readonly repo: string;
  readonly task: string;
  readonly projectIndexDir: string;
  readonly forceProjectIndex?: boolean;
  readonly runId?: string;
  readonly maxFixRounds?: number;
  readonly maxEvaluatorRetries?: number;
  readonly onContextBuilt?: (context: ContextBuilderResult) => void;
}

export interface RunOrchestratorResult {
  readonly status: FinalizerResult['status'];
  readonly runId: string;
  readonly repo: string;
  readonly context: ContextBuilderResult;
  readonly planner: PlannerPipelineResult;
  readonly generator: GeneratorPipelineResult;
  readonly evaluator: EvaluatorPipelineResult;
  readonly unit: OrchestratorResult;
  readonly finalizer: FinalizerResult;
  readonly output: RunCommandOutput;
}

export interface RunCommandOutput {
  readonly status: FinalizerResult['status'];
  readonly run_id: string;
  readonly repo: string;
  readonly context_status: ContextBuilderResult['status'];
  readonly project_index_status: ContextBuilderResult['projectIndexStatus'];
  readonly outputs: Record<string, unknown>;
  readonly unit: {
    readonly unit_id: PlannerPipelineResult['unitId'];
    readonly batch_id: PlannerPipelineResult['batchId'];
    readonly generator_mode: GeneratorPipelineResult['mode'];
    readonly changed_files: GeneratorPipelineResult['changedFiles'];
    readonly commit: GeneratorPipelineResult['commitRef'] | null;
    readonly decision: EvaluatorPipelineResult['decision'];
    readonly fix_rounds: OrchestratorResult['fixRounds'];
    readonly evaluator_attempts: OrchestratorResult['evaluatorAttempts'];
    readonly verification_results: EvaluatorPipelineResult['verificationResults'];
  };
  readonly resume_from: FinalizerResult['resumeFrom'];
  readonly cannot_resume_reason: FinalizerResult['cannotResumeReason'] | null;
}

/**
 * Runs the single-repository, single-unit pipeline used by the CLI today.
 * Batch scheduling, dependency handling, and worktree isolation remain M15+ concerns.
 */
export class RunOrchestrator {
  constructor(
    private readonly contextBuilder = new ContextBuilder(),
    private readonly planner = new PlannerPipeline(),
    private readonly unitOrchestrator = new Orchestrator(),
    private readonly finalizer = new Finalizer(),
  ) {}

  async run(options: RunOrchestratorOptions): Promise<RunOrchestratorResult> {
    const config = await loadAgentflowConfig({ repoPath: options.repo });
    const maxFixRounds =
      options.maxFixRounds ??
      config.budgets.maxFixRounds ??
      DEFAULT_MAX_FIX_ROUNDS;
    const maxEvaluatorRetries =
      options.maxEvaluatorRetries ??
      config.budgets.maxEvaluatorRetries ??
      DEFAULT_MAX_EVALUATOR_RETRIES;

    const context = await this.contextBuilder.build({
      repoPath: options.repo,
      taskPath: options.task,
      projectIndexDir: options.projectIndexDir,
      forceProjectIndex: options.forceProjectIndex ?? false,
      runId: options.runId,
    });
    options.onContextBuilt?.(context);

    const planner = await this.planner.build({
      repoRoot: context.repoRoot,
      runId: context.runId,
      taskPath: options.task,
      context,
      maxFixRounds,
      maxEvaluatorRetries,
    });

    const unit = await this.unitOrchestrator.runUnit({
      repoRoot: context.repoRoot,
      runId: context.runId,
      context,
      planner,
      maxFixRounds,
      maxEvaluatorRetries,
    });

    const finalizer = await this.finalizer.complete({
      repoRoot: context.repoRoot,
      runId: context.runId,
      context,
      planner,
      generator: unit.generator,
      evaluator: unit.evaluator,
      budgets: unit.budgets,
      counters: unit.counters,
      fixLoops: unit.fixRounds,
      commitsCreated: unit.commitsCreated,
    });

    return {
      status: finalizer.status,
      runId: context.runId,
      repo: context.repoRoot,
      context,
      planner,
      generator: unit.generator,
      evaluator: unit.evaluator,
      unit,
      finalizer,
      output: toRunCommandOutput({
        context,
        planner,
        unit,
        finalizer,
      }),
    };
  }
}

function toRunCommandOutput(input: {
  readonly context: ContextBuilderResult;
  readonly planner: PlannerPipelineResult;
  readonly unit: OrchestratorResult;
  readonly finalizer: FinalizerResult;
}): RunCommandOutput {
  const { context, planner, unit, finalizer } = input;
  const generator = unit.generator;
  const evaluator = unit.evaluator;

  return {
    status: finalizer.status,
    run_id: context.runId,
    repo: context.repoRoot,
    context_status: context.status,
    project_index_status: context.projectIndexStatus,
    outputs: {
      ...context.outputs,
      routing_decision: planner.routingDecisionRef,
      role_run_requests: planner.roleRunRequestRefs,
      planner_package: planner.plannerPackageRef,
      batch_schedule: planner.batchScheduleRef,
      acceptance_contract: planner.acceptanceContractRef,
      run_state: planner.runStateRef,
      unit_state: planner.unitStateRef,
      generation_input: generator.generationInputRef,
      generator_routing_decision: generator.routingDecisionRef,
      generator_role_run_request: generator.roleRunRequestRef,
      generator_role_input: generator.roleInputRef,
      generator_role_output: generator.roleOutputRef,
      change_package: generator.changePackageRef,
      evaluation_input: evaluator.evaluationInputRef,
      evaluator_routing_decision: evaluator.routingDecisionRef,
      evaluator_role_run_request: evaluator.roleRunRequestRef,
      evaluator_role_input: evaluator.roleInputRef,
      evaluator_role_output: evaluator.roleOutputRef,
      evaluator_report: evaluator.evaluatorReportRef,
      unit_decision: evaluator.unitDecisionRef,
      final_or_stop_report: finalizer.reportRef,
      final_run_state: finalizer.runStateRef,
    },
    unit: {
      unit_id: planner.unitId,
      batch_id: planner.batchId,
      generator_mode: generator.mode,
      changed_files: generator.changedFiles,
      commit: generator.commitRef ?? null,
      decision: evaluator.decision,
      fix_rounds: unit.fixRounds,
      evaluator_attempts: unit.evaluatorAttempts,
      verification_results: evaluator.verificationResults,
    },
    resume_from: finalizer.resumeFrom,
    cannot_resume_reason: finalizer.cannotResumeReason ?? null,
  };
}
