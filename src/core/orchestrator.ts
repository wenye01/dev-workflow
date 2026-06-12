import {
  GeneratorPipeline,
  type GeneratorPipelineResult,
} from '../generator/generator-pipeline.js';
import {
  EvaluatorPipeline,
  type EvaluatorPipelineResult,
} from '../evaluator/evaluator-pipeline.js';
import type { ContextBuilderResult } from '../context/context-builder.js';
import type { PlannerPipelineResult } from '../planner/planner-pipeline.js';
import {
  DEFAULT_MAX_EVALUATOR_RETRIES,
  DEFAULT_MAX_FIX_ROUNDS,
  normalizeBudget,
} from './budgets.js';
import {
  type DecisionEngineResult,
  type NextPipelineGeneratorFix,
  type UnitDecision,
} from './decision-engine.js';

export interface OrchestratorOptions {
  readonly repoRoot: string;
  readonly runId: string;
  readonly configPath?: string;
  readonly context: ContextBuilderResult;
  readonly planner: PlannerPipelineResult;
  readonly maxFixRounds?: number;
  readonly maxEvaluatorRetries?: number;
  readonly onCliProcessStarted?: () => void;
  readonly onSchemaFailure?: () => void;
}

export interface OrchestratorResult {
  readonly status: 'pass' | 'stop';
  readonly decision: UnitDecision;
  readonly generator: GeneratorPipelineResult;
  readonly evaluator: EvaluatorPipelineResult;
  readonly fixRounds: number;
  readonly evaluatorAttempts: number;
  readonly commitsCreated: number;
  readonly budgets: {
    readonly maxFixRounds: number;
    readonly maxEvaluatorRetries: number;
  };
  readonly counters: {
    readonly fixLoops: number;
    readonly commitsCreated: number;
    readonly cliProcessesStarted: number;
    readonly schemaFailures: number;
  };
}

export class OrchestratorError extends Error {
  readonly code: string;
  readonly classification: string;

  constructor(options: {
    readonly code: string;
    readonly message: string;
    readonly classification?: string;
  }) {
    super(options.message);
    this.name = 'OrchestratorError';
    this.code = options.code;
    this.classification = options.classification ?? 'orchestrator_failed';
  }
}

type GeneratorRunner = Pick<GeneratorPipeline, 'build'>;
type EvaluatorRunner = Pick<EvaluatorPipeline, 'build'>;

/**
 * Drives a single execution unit to a terminal state by looping the
 * generator and evaluator stages according to the DecisionEngine output.
 * The loop is bounded by budgets so it always terminates.
 */
export class Orchestrator {
  constructor(
    private readonly generator: GeneratorRunner = new GeneratorPipeline(),
    private readonly evaluator: EvaluatorRunner = new EvaluatorPipeline(),
  ) {}

  async runUnit(options: OrchestratorOptions): Promise<OrchestratorResult> {
    const maxFixRounds = normalizeBudget(
      options.maxFixRounds ?? options.planner.maxFixRounds,
      DEFAULT_MAX_FIX_ROUNDS,
    );
    const maxEvaluatorRetries = normalizeBudget(
      options.maxEvaluatorRetries ?? options.planner.maxEvaluatorRetries,
      DEFAULT_MAX_EVALUATOR_RETRIES,
    );
    const iterationCap = (maxFixRounds + 1) * (maxEvaluatorRetries + 1) + 2;

    let fixRound = 0;
    let attempt = 0;
    let evaluatorAttempts = 0;
    const counters = {
      fixLoops: 0,
      commitsCreated: 0,
      cliProcessesStarted: 0,
      schemaFailures: 0,
    };
    let iterations = 0;

    const bumpCliProcesses = () => {
      counters.cliProcessesStarted += 1;
      options.onCliProcessStarted?.();
    };
    const bumpSchemaFailures = () => {
      counters.schemaFailures += 1;
      options.onSchemaFailure?.();
    };

    let generator = await this.generator.build({
      repoRoot: options.repoRoot,
      runId: options.runId,
      configPath: options.configPath,
      context: options.context,
      planner: options.planner,
      mode: 'initial',
      previousFailures: [],
      onCliProcessStarted: bumpCliProcesses,
      onSchemaFailure: bumpSchemaFailures,
    });
    if (generator.commitRef) {
      counters.commitsCreated += 1;
    }

    for (;;) {
      if (++iterations > iterationCap) {
        throw new OrchestratorError({
          code: 'AGENTFLOW_ORCHESTRATOR_ITERATION_CAP_EXCEEDED',
          message: `Orchestrator exceeded its iteration cap (${iterationCap}) without reaching a terminal decision.`,
        });
      }

      const evaluator = await this.evaluator.build({
        repoRoot: options.repoRoot,
        runId: options.runId,
        configPath: options.configPath,
        context: options.context,
        planner: options.planner,
        generator,
        onCliProcessStarted: bumpCliProcesses,
        onSchemaFailure: bumpSchemaFailures,
        attempt,
        fixRound,
        maxFixRounds,
        maxEvaluatorRetries,
      });
      evaluatorAttempts += 1;

      const unitDecision = evaluator.unitDecision;
      assertHasExpectedDecisionShape(unitDecision);
      const decision = unitDecision.decision;

      if (decision === 'pass' || decision === 'stop') {
        return {
          status: decision === 'pass' ? 'pass' : 'stop',
          decision,
          generator,
          evaluator,
          fixRounds: fixRound,
          evaluatorAttempts,
          commitsCreated: counters.commitsCreated,
          budgets: {
            maxFixRounds,
            maxEvaluatorRetries,
          },
          counters,
        };
      }

      if (!unitDecision.next_pipeline) {
        throw new OrchestratorError({
          code: 'AGENTFLOW_ORCHESTRATOR_INVALID_NEXT_PIPELINE',
          message:
            'Decision is non-terminal but next_pipeline is null; cannot route to the next stage.',
          classification: 'orchestrator_routing_failed',
        });
      }

      if (unitDecision.next_pipeline.module === 'evaluator') {
        if (
          decision !== 're_evaluate' ||
          unitDecision.next_pipeline.mode !== 're_evaluate'
        ) {
          throw new OrchestratorError({
            code: 'AGENTFLOW_ORCHESTRATOR_DECISION_MISMATCH',
            message: `Decision "${decision}" is incompatible with next_pipeline ${unitDecision.next_pipeline.module}/${unitDecision.next_pipeline.mode}.`,
            classification: 'orchestrator_routing_failed',
          });
        }

        attempt = normalizeBudget(unitDecision.next_pipeline.attempt, 0);
        continue;
      }

      if (
        unitDecision.next_pipeline.module === 'generator' &&
        unitDecision.next_pipeline.mode === 'fix'
      ) {
        if (
          decision !== 'fix' ||
          !isFixNextPipeline(unitDecision.next_pipeline)
        ) {
          throw new OrchestratorError({
            code: 'AGENTFLOW_ORCHESTRATOR_DECISION_MISMATCH',
            message: `Decision "${decision}" is incompatible with next_pipeline ${unitDecision.next_pipeline.module}/${unitDecision.next_pipeline.mode}.`,
            classification: 'orchestrator_routing_failed',
          });
        }

        const previousFailures = selectFailuresForFix(
          evaluator.failures,
          unitDecision.next_pipeline,
        );
        fixRound = normalizeBudget(unitDecision.next_pipeline.fix_round, 0);
        counters.fixLoops = Math.max(counters.fixLoops, fixRound);
        attempt = 0;
        generator = await this.generator.build({
          repoRoot: options.repoRoot,
          runId: options.runId,
          configPath: options.configPath,
          context: options.context,
          planner: options.planner,
          mode: 'fix',
          previousFailures,
          onCliProcessStarted: bumpCliProcesses,
          onSchemaFailure: bumpSchemaFailures,
        });
        if (generator.commitRef) {
          counters.commitsCreated += 1;
        }
        continue;
      }

      throw new OrchestratorError({
        code: 'AGENTFLOW_ORCHESTRATOR_INVALID_NEXT_PIPELINE',
        message: 'Unsupported next_pipeline path.',
        classification: 'orchestrator_routing_failed',
      });
    }
  }
}

function assertHasExpectedDecisionShape(
  unitDecision: DecisionEngineResult,
): void {
  if (unitDecision.decision !== 'pass' && unitDecision.decision !== 'stop') {
    if (!unitDecision.next_pipeline) {
      throw new OrchestratorError({
        code: 'AGENTFLOW_ORCHESTRATOR_INVALID_UNIT_DECISION',
        message: 'Expected next_pipeline for non-terminal decision.',
        classification: 'orchestrator_routing_failed',
      });
    }
  }
}

function isFixNextPipeline(
  value: DecisionEngineResult['next_pipeline'],
): value is NextPipelineGeneratorFix {
  return value !== null && value.mode === 'fix' && value.module === 'generator';
}

function selectFailuresForFix(
  failures: readonly Record<string, unknown>[],
  nextPipeline: NextPipelineGeneratorFix,
): readonly Record<string, unknown>[] {
  if (nextPipeline.target_failures.length === 0) {
    return failures;
  }

  const targetRefs = new Set(nextPipeline.target_failures);
  const selected = failures.filter((failure) =>
    typeof failure.ref === 'string' ? targetRefs.has(failure.ref) : false,
  );
  return selected.length > 0 ? selected : failures;
}
