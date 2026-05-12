import type { Command } from 'commander';

import { ProjectIndexBuilder } from '../../project-index/project-index-builder.js';
import {
  parseProjectIndexShowName,
  readProjectIndexView,
} from '../../project-index/project-index-store.js';
import { ProjectIndexError } from '../../project-index/util.js';
import { SchemaValidationError } from '../../schemas/validator.js';
import { addJsonOutputNote } from './shared.js';

export function registerProjectIndexCommand(program: Command): void {
  const projectIndex = program
    .command('project-index')
    .description(
      'Build and inspect reusable project overview and document index artifacts.',
    );

  addJsonOutputNote(projectIndex);

  projectIndex
    .command('build')
    .description(
      'Build a project overview, command index, module index, and document index.',
    )
    .requiredOption('--repo <path>', 'Git repository to scan')
    .option(
      '--out <path>',
      'Directory for generated project index artifacts',
      '.agentflow/project-index',
    )
    .option('--force', 'Rebuild even when the existing index appears fresh')
    .action(
      async (options: {
        readonly repo: string;
        readonly out: string;
        readonly force?: boolean;
      }) => {
        try {
          const result = await new ProjectIndexBuilder().build({
            repoPath: options.repo,
            outDir: options.out,
            force: options.force ?? false,
          });

          console.log(
            JSON.stringify(
              {
                status: result.status,
                repo: result.repoRoot,
                index_dir: result.outDir,
                manifest: result.manifestPath,
                manifest_ref: result.manifestRef,
                artifacts: result.manifest.artifacts.length,
              },
              null,
              2,
            ),
          );
        } catch (error) {
          process.exitCode = 2;
          console.error(
            JSON.stringify(formatProjectIndexError(error), null, 2),
          );
        }
      },
    );

  projectIndex
    .command('show')
    .description('Read one generated project index artifact.')
    .requiredOption('--index-dir <path>', 'Project index directory')
    .requiredOption(
      '--name <name>',
      'Artifact name: manifest, overview, documents, commands, modules, or tree',
    )
    .action(
      async (options: { readonly indexDir: string; readonly name: string }) => {
        try {
          const name = parseProjectIndexShowName(options.name);
          const value = await readProjectIndexView(options.indexDir, name);
          console.log(JSON.stringify(value, null, 2));
        } catch (error) {
          process.exitCode = 2;
          console.error(
            JSON.stringify(formatProjectIndexError(error), null, 2),
          );
        }
      },
    );
}

function formatProjectIndexError(error: unknown): Record<string, unknown> {
  if (error instanceof ProjectIndexError) {
    return {
      error: {
        code: error.code,
        message: error.message,
      },
    };
  }

  if (error instanceof SchemaValidationError) {
    return {
      error: {
        code: error.code,
        classification: error.classification,
        schema_id: error.schemaId,
        message: error.message,
        errors: error.errors,
      },
    };
  }

  const maybe = error as { readonly code?: string; readonly message?: string };
  return {
    error: {
      code: maybe.code ?? 'AGENTFLOW_PROJECT_INDEX_FAILED',
      message: maybe.message ?? String(error),
    },
  };
}
