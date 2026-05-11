import type { Command } from 'commander';

import {
  ConfigError,
  loadAgentflowConfig,
} from '../../config/config-loader.js';
import { ProviderRegistry } from '../../config/provider-registry.js';
import { RoleCatalog, RoleCatalogError } from '../../config/role-catalog.js';
import { SchemaValidationError } from '../../schemas/validator.js';
import { RouterToolbox } from '../../routers/router-tools.js';
import { addJsonOutputNote } from './shared.js';

export function registerToolCommand(program: Command): void {
  const tool = program
    .command('tool')
    .description('Read-only tools intended for agent skill integrations.');

  addJsonOutputNote(tool);

  tool
    .command('state')
    .description('Read run state and optionally one unit state.')
    .requiredOption('--run-dir <path>', 'Run directory containing .agentflow')
    .option('--unit <unit_id>', 'Unit id')
    .action(
      async (options: { readonly runDir: string; readonly unit?: string }) => {
        try {
          const toolbox = new RouterToolbox(options.runDir);
          const runState = await toolbox.readRunState();
          const result: Record<string, unknown> = { run_state: runState };

          if (options.unit) {
            result.unit_state = await toolbox.readUnitState(options.unit);
          }

          console.log(JSON.stringify(result, null, 2));
        } catch (error) {
          process.exitCode = 2;
          console.error(JSON.stringify(formatToolError(error), null, 2));
        }
      },
    );

  const artifact = tool
    .command('artifact')
    .description('Read artifact content or index.');

  artifact
    .command('get')
    .description('Read one artifact by ref.')
    .requiredOption('--run-dir <path>', 'Run directory containing .agentflow')
    .requiredOption('--ref <artifact_ref>', 'Artifact ref under .agentflow')
    .action(
      async (options: { readonly runDir: string; readonly ref: string }) => {
        try {
          const toolbox = new RouterToolbox(options.runDir);
          const artifact = await toolbox.readArtifact(options.ref);
          console.log(
            JSON.stringify(
              {
                ref: options.ref,
                artifact,
              },
              null,
              2,
            ),
          );
        } catch (error) {
          process.exitCode = 2;
          console.error(JSON.stringify(formatToolError(error), null, 2));
        }
      },
    );

  artifact
    .command('index')
    .description('Read the artifact index.')
    .requiredOption('--run-dir <path>', 'Run directory containing .agentflow')
    .action(async (options: { readonly runDir: string }) => {
      try {
        const toolbox = new RouterToolbox(options.runDir);
        const artifactIndex = await toolbox.readArtifactIndex();
        console.log(JSON.stringify({ artifact_index: artifactIndex }, null, 2));
      } catch (error) {
        process.exitCode = 2;
        console.error(JSON.stringify(formatToolError(error), null, 2));
      }
    });

  const context = tool
    .command('context')
    .description('Read generated context artifacts.');

  context
    .command('get')
    .description('Read a named context artifact.')
    .requiredOption('--run-dir <path>', 'Run directory containing .agentflow')
    .requiredOption(
      '--name <name>',
      'Context name: project-index-ref, selected-project-context, or worktree-status',
    )
    .action(
      async (options: { readonly runDir: string; readonly name: string }) => {
        try {
          const toolbox = new RouterToolbox(options.runDir);
          const context = await toolbox.readContext(
            options.name as
              | 'project-index-ref'
              | 'selected-project-context'
              | 'worktree-status',
          );
          console.log(
            JSON.stringify(
              {
                name: context.name,
                ref: context.ref,
                artifact: context.value,
              },
              null,
              2,
            ),
          );
        } catch (error) {
          process.exitCode = 2;
          console.error(JSON.stringify(formatToolError(error), null, 2));
        }
      },
    );

  const roleCatalog = tool
    .command('role-catalog')
    .description('Inspect configured roles.');

  roleCatalog
    .command('list')
    .description('List role catalog entries.')
    .requiredOption('--config <file>', 'Agentflow config file')
    .action(async (options: { readonly config: string }) => {
      try {
        const config = await loadAgentflowConfig(options.config);
        const catalog = new RoleCatalog(config);
        console.log(
          JSON.stringify(
            {
              roles: catalog.list().map((role) => ({
                name: role.name,
                module: role.module,
                write_permission: role.writePermission,
                provider_candidates: role.providerCandidates,
              })),
            },
            null,
            2,
          ),
        );
      } catch (error) {
        process.exitCode = 2;
        console.error(JSON.stringify(formatToolError(error), null, 2));
      }
    });

  const provider = tool
    .command('provider')
    .description('Inspect provider capabilities.');

  provider
    .command('capabilities')
    .description('List provider capabilities derived from config.')
    .requiredOption('--config <file>', 'Agentflow config file')
    .action(async (options: { readonly config: string }) => {
      try {
        const config = await loadAgentflowConfig(options.config);
        const registry = new ProviderRegistry(config.providers);
        const providers = await Promise.all(
          registry.list().map(async (providerConfig) => {
            const readiness = await registry.inspect(
              providerConfig,
              {},
              { checkCommandAvailability: false },
            );

            return {
              provider: readiness.provider,
              type: readiness.type,
              command: readiness.command,
              available: readiness.available,
              authenticated: readiness.authenticated,
              concurrency: readiness.concurrency,
              capabilities: readiness.capabilities,
              issues: readiness.issues,
            };
          }),
        );

        console.log(JSON.stringify({ providers }, null, 2));
      } catch (error) {
        process.exitCode = 2;
        console.error(JSON.stringify(formatToolError(error), null, 2));
      }
    });

  const worktree = tool
    .command('worktree')
    .description('Inspect the run worktree.');

  worktree
    .command('status')
    .description('Read worktree status.')
    .requiredOption('--run-dir <path>', 'Run directory containing .agentflow')
    .action(async (options: { readonly runDir: string }) => {
      try {
        const toolbox = new RouterToolbox(options.runDir);
        const worktreeStatus = await toolbox.readWorktreeStatus();
        console.log(
          JSON.stringify({ worktree_status: worktreeStatus }, null, 2),
        );
      } catch (error) {
        process.exitCode = 2;
        console.error(JSON.stringify(formatToolError(error), null, 2));
      }
    });

  worktree
    .command('diff-summary')
    .description('Read a summary of worktree changes.')
    .requiredOption('--run-dir <path>', 'Run directory containing .agentflow')
    .action(async (options: { readonly runDir: string }) => {
      try {
        const toolbox = new RouterToolbox(options.runDir);
        const diffSummary = await toolbox.readWorktreeDiffSummary();
        console.log(JSON.stringify(diffSummary, null, 2));
      } catch (error) {
        process.exitCode = 2;
        console.error(JSON.stringify(formatToolError(error), null, 2));
      }
    });
}

function formatToolError(error: unknown): Record<string, unknown> {
  if (error instanceof ConfigError || error instanceof RoleCatalogError) {
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

  return {
    error: {
      code: 'AGENTFLOW_TOOL_FAILED',
      message: error instanceof Error ? error.message : String(error),
    },
  };
}
