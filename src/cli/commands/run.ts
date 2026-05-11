import type { Command } from 'commander';
import path from 'node:path';

import { ArtifactStore } from '../../artifacts/artifact-store.js';
import { artifactPath } from '../../artifacts/paths.js';
import {
  ContextBuilder,
  ContextBuilderError,
} from '../../context/context-builder.js';
import { ProjectIndexError } from '../../project-index/util.js';
import { SchemaValidationError } from '../../schemas/validator.js';

export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Start a new agentflow run for one git repository.')
    .requiredOption('--repo <path>', 'Git repository path')
    .requiredOption('--task <file>', 'Task markdown file')
    .requiredOption('--config <file>', 'Agentflow config file')
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
    .action(
      async (options: {
        readonly repo: string;
        readonly task: string;
        readonly config: string;
        readonly projectIndexDir: string;
        readonly forceProjectIndex?: boolean;
        readonly runId?: string;
      }) => {
        try {
          const result = await new ContextBuilder().build({
            repoPath: options.repo,
            taskPath: options.task,
            configPath: options.config,
            projectIndexDir: options.projectIndexDir,
            forceProjectIndex: options.forceProjectIndex ?? false,
            runId: options.runId,
          });

          console.log(
            JSON.stringify(
              {
                status:
                  result.status === 'degraded'
                    ? 'context_degraded'
                    : 'context_ready',
                run_id: result.runId,
                repo: result.repoRoot,
                project_index_status: result.projectIndexStatus,
                outputs: result.outputs,
                next: 'Planner runtime is not implemented until Milestone 8.',
              },
              null,
              2,
            ),
          );
        } catch (error) {
          process.exitCode = 2;
          const stopReportRef = await tryWriteStopReport(options.repo, error);
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
): Promise<string | null> {
  try {
    const repoRoot = path.resolve(repoPath);
    const store = new ArtifactStore(repoRoot);
    const result = await store.writeProgramArtifact({
      artifactType: 'stop_report',
      ref: artifactPath('stop-report.json'),
      payload: {
        status: 'stopped',
        reason_code: 'context_builder_failed',
        classification: classificationForError(error),
        message: messageForError(error),
        resume_from: null,
        cannot_resume_reason:
          'Context Builder failed before Planner startup; there is no safe in-progress role execution to resume.',
        suggested_actions: [
          'Inspect the Context Builder error details.',
          'Fix the task file, config file, git repository, or Project Index artifacts.',
          'Run agentflow run again after correcting the input.',
        ],
      },
      metadata: {
        runId: `run-context-failed-${Date.now()}`,
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
