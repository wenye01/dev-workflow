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
import type { UnitDecision } from './decision-engine.js';

export interface OrchestratorOptions {
  readonly repoRoot: string;
  readonly runId: string;
  readonly configPath?: string;
  readonly context: ContextBuilderResult;
  readonly planner: PlannerPipelineResult;
  readonly maxFixRounds?: number;
  readonly maxEvaluatorRetries?: number;
}

export interface OrchestratorResult {
  readonly status: 'pass' | 'stop';
  readonly decision: UnitDecision;
  readonly generator: GeneratorPipelineResult;
  readonly evaluator: EvaluatorPipelineResult;
  readonly fixRounds: number;
  readonly evaluatorAttempts: number;
  readonly commitsCreated: number;
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
 * generator and evaluator stages according to the DecisionEngine output
 * surfaced by the evaluator. The loop is bounded by the fix-round and
 * evaluator-retry budgets so it always terminates.
 */
export class Orchestrator {
  constructor(
    private readonly generator: GeneratorRunner = new GeneratorPipeline(),
    private readonly evaluator: EvaluatorRunner = new EvaluatorPipeline(),
  ) {}

  async runUnit(options: OrchestratorOptions): Promise<OrchestratorResult> {
    const maxFixRounds = nonNegativeInt(
      options.maxFixRounds ?? options.planner.maxFixRounds,
      1,
    );
    const maxEvaluatorRetries = nonNegativeInt(
      options.maxEvaluatorRetries ?? options.planner.maxEvaluatorRetries,
      1,
    );
    const iterationCap = (maxFixRounds + 1) * (maxEvaluatorRetries + 1) + 2;

    let fixRound = 0;
    let attempt = 0;
    let evaluatorAttempts = 0;
    let commitsCreated = 0;
    let iterations = 0;

    let generator = await this.generator.build({
      repoRoot: options.repoRoot,
      runId: options.runId,
      configPath: options.configPath,
      context: options.context,
      planner: options.planner,
      mode: 'initial',
      previousFailures: [],
    });
    if (generator.commitRef) {
      commitsCreated += 1;
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
        attempt,
        fixRound,
        maxFixRounds,
        maxEvaluatorRetries,
      });
      evaluatorAttempts += 1;

      const decision = evaluator.decision;

      if (decision === 'pass' || decision === 'stop') {
        return {
          status: decision === 'pass' ? 'pass' : 'stop',
          decision,
          generator,
          evaluator,
          fixRounds: fixRound,
          evaluatorAttempts,
          commitsCreated,
        };
      }

      if (decision === 're_evaluate') {
        attempt += 1;
        continue;
      }

      // decision === 'fix': regenerate against the evaluator's failures,
      // then reset the evaluator-retry counter for the fresh generation.
      fixRound += 1;
      attempt = 0;
      generator = await this.generator.build({
        repoRoot: options.repoRoot,
        runId: options.runId,
        configPath: options.configPath,
        context: options.context,
        planner: options.planner,
        mode: 'fix',
        previousFailures: evaluator.failures,
      });
      if (generator.commitRef) {
        commitsCreated += 1;
      }
    }
  }
}

function nonNegativeInt(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}
