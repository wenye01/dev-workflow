import type { Command } from 'commander';
import path from 'node:path';

import { ArtifactStore } from '../../artifacts/artifact-store.js';
import { artifactPath } from '../../artifacts/paths.js';
import { ContextBuilderError } from '../../context/context-builder.js';
import { PlannerPipelineError } from '../../planner/planner-pipeline.js';
import { GeneratorPipelineError } from '../../generator/generator-pipeline.js';
import { EvaluatorPipelineError } from '../../evaluator/evaluator-pipeline.js';
import { OrchestratorError } from '../../core/orchestrator.js';
import { RunOrchestrator } from '../../core/run-orchestrator.js';
import { ProjectIndexError } from '../../project-index/util.js';
import { SchemaValidationError } from '../../schemas/validator.js';

export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Start a new agentflow run for one git repository.')
    .requiredOption('--repo <path>', 'Git repository path')
    .requiredOption('--task <file>', 'Task markdown file')
    .option(
      '--project-index-dir <path>',
      'Project Index directory under the repository',
      '.agentflow/project-index',
    )
    .option(
      '--force-project-index',
      'Rebuild Project Index before context build',
    )
    .option('--run-id <id>', 'Explicit run id for generated context artifacts')
    .option(
      '--max-fix-rounds <n>',
      'Maximum generator retry rounds for auto-fixes',
      parseBudgetOption,
    )
    .option(
      '--max-evaluator-retries <n>',
      'Maximum evaluator re-evaluate retries for insufficient evidence',
      parseBudgetOption,
    )
    .action(
      async (options: {
        readonly repo: string;
        readonly task: string;
        readonly projectIndexDir: string;
        readonly forceProjectIndex?: boolean;
        readonly runId?: string;
        readonly maxFixRounds?: number;
        readonly maxEvaluatorRetries?: number;
      }) => {
        let stopReportRepo = options.repo;
        let stopReportRunId = options.runId;

        try {
          const result = await new RunOrchestrator().run({
            repo: options.repo,
            task: options.task,
            projectIndexDir: options.projectIndexDir,
            forceProjectIndex: options.forceProjectIndex,
            runId: options.runId,
            maxFixRounds: options.maxFixRounds,
            maxEvaluatorRetries: options.maxEvaluatorRetries,
            onContextBuilt: (context) => {
              stopReportRepo = context.repoRoot;
              stopReportRunId = context.runId;
            },
          });

          console.log(JSON.stringify(result.output, null, 2));
        } catch (error) {
          process.exitCode = 2;
          const stopReportRef = await tryWriteStopReport(
            stopReportRepo,
            error,
            stopReportRunId,
          );
          console.error(
            JSON.stringify(formatRunError(error, stopReportRef), null, 2),
          );
        }
      },
    );
}

async function tryWriteStopReport(
  repoPath: string,
  error: unknown,
  runId?: string,
): Promise<string | null> {
  try {
    const repoRoot = path.resolve(repoPath);
    const store = new ArtifactStore(repoRoot);
    const result = await store.writeProgramArtifact({
      artifactType: 'stop_report',
      ref: artifactPath('stop-report.json'),
      payload: stopReportPayloadForError(error),
      metadata: {
        runId: runId ?? `run-context-failed-${Date.now()}`,
        producer: {
          kind: 'orchestrator',
          module: 'decision',
        },
      },
      renderMarkdown: true,
    });

    return result.ref;
  } catch {
    return null;
  }
}

function formatRunError(
  error: unknown,
  stopReportRef: string | null,
): Record<string, unknown> {
  return {
    error: {
      code: codeForError(error),
      classification: classificationForError(error),
      message: messageForError(error),
      stop_report_ref: stopReportRef,
      ...(error instanceof ContextBuilderError && error.details
        ? { details: error.details }
        : {}),
    },
  };
}

function codeForError(error: unknown): string {
  if (
    error instanceof ContextBuilderError ||
    error instanceof PlannerPipelineError ||
    error instanceof GeneratorPipelineError ||
    error instanceof EvaluatorPipelineError ||
    error instanceof OrchestratorError ||
    error instanceof ProjectIndexError
  ) {
    return error.code;
  }

  if (error instanceof SchemaValidationError) {
    return error.code;
  }

  return 'AGENTFLOW_RUN_FAILED';
}

function classificationForError(error: unknown): string {
  if (error instanceof ContextBuilderError) {
    return error.classification;
  }

  if (error instanceof PlannerPipelineError) {
    return error.classification;
  }

  if (error instanceof GeneratorPipelineError) {
    return error.classification;
  }

  if (error instanceof EvaluatorPipelineError) {
    return error.classification;
  }

  if (error instanceof OrchestratorError) {
    return error.classification;
  }

  if (error instanceof SchemaValidationError) {
    return error.classification;
  }

  if (error instanceof ProjectIndexError) {
    return 'project_index_failed';
  }

  return 'run_failed';
}

function messageForError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stopReportPayloadForError(error: unknown): Record<string, unknown> {
  if (error instanceof PlannerPipelineError) {
    return {
      status: 'stopped',
      reason_code: 'planner_pipeline_failed',
      classification: error.classification,
      message: error.message,
      resume_from: null,
      cannot_resume_reason:
        'Planner could not form a valid single-unit plan for this run.',
      suggested_actions: [
        'Inspect the planner pipeline error details.',
        'Adjust the task scope or acceptance contract inputs.',
        'Run agentflow run again after correcting the plan inputs.',
      ],
    };
  }

  if (error instanceof GeneratorPipelineError) {
    return {
      status: 'stopped',
      reason_code: 'generator_pipeline_failed',
      classification: error.classification,
      message: error.message,
      details: error.details ?? null,
      resume_from: null,
      cannot_resume_reason:
        'Generator could not produce a valid in-scope Change Package for this run.',
      suggested_actions: [
        'Inspect the generator pipeline error details.',
        'Fix provider configuration or narrow the unit scope.',
        'Run agentflow run again after correcting the generator inputs.',
      ],
    };
  }

  if (error instanceof EvaluatorPipelineError) {
    return {
      status: 'stopped',
      reason_code: 'evaluator_pipeline_failed',
      classification: error.classification,
      message: error.message,
      details: error.details ?? null,
      resume_from: null,
      cannot_resume_reason:
        'Evaluator could not produce a valid structured decision for this run.',
      suggested_actions: [
        'Inspect the evaluator pipeline error details.',
        'Fix provider configuration or verification command failures.',
        'Run agentflow run again after correcting the evaluator inputs.',
      ],
    };
  }

  if (error instanceof ContextBuilderError) {
    return {
      status: 'stopped',
      reason_code: 'context_builder_failed',
      classification: error.classification,
      message: error.message,
      resume_from: null,
      cannot_resume_reason:
        'Context Builder failed before Planner startup; there is no safe in-progress role execution to resume.',
      suggested_actions: [
        'Inspect the Context Builder error details.',
        'Fix the task file, config file, git repository, or Project Index artifacts.',
        'Run agentflow run again after correcting the input.',
      ],
    };
  }

  if (error instanceof SchemaValidationError) {
    return {
      status: 'stopped',
      reason_code: 'schema_validation_failed',
      classification: error.classification,
      message: error.message,
      failed_schema_id: error.schemaId ?? null,
      resume_from: null,
      cannot_resume_reason:
        'The run produced an invalid schema payload and cannot safely continue.',
      suggested_actions: [
        'Inspect the schema validation errors.',
        'Fix the producing planner or context artifact.',
        'Run agentflow run again after correcting the payload.',
      ],
    };
  }

  return {
    status: 'stopped',
    reason_code: 'run_failed',
    classification: classificationForError(error),
    message: messageForError(error),
    resume_from: null,
    cannot_resume_reason:
      'The run failed before the next pipeline stage could start.',
    suggested_actions: [
      'Inspect the error details.',
      'Fix the repository, task, or configuration inputs.',
      'Run agentflow run again after correcting the problem.',
    ],
  };
}

function parseBudgetOption(value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error('Invalid budget value, expecting a non-negative integer.');
  }

  return Number.parseInt(value, 10);
}
