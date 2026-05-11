import type { Command } from 'commander';

import {
  ConfigError,
  loadAgentflowConfig,
} from '../../config/config-loader.js';
import { ProviderRegistry } from '../../config/provider-registry.js';
import { RoleCatalog, RoleCatalogError } from '../../config/role-catalog.js';
import { addJsonOutputNote, failNotImplemented } from './shared.js';

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
    .action(() => failNotImplemented('tool state'));

  const artifact = tool
    .command('artifact')
    .description('Read artifact content or index.');

  artifact
    .command('get')
    .description('Read one artifact by ref.')
    .requiredOption('--run-dir <path>', 'Run directory containing .agentflow')
    .requiredOption('--ref <artifact_ref>', 'Artifact ref under .agentflow')
    .action(() => failNotImplemented('tool artifact get'));

  artifact
    .command('index')
    .description('Read the artifact index.')
    .requiredOption('--run-dir <path>', 'Run directory containing .agentflow')
    .action(() => failNotImplemented('tool artifact index'));

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
    .action(() => failNotImplemented('tool context get'));

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
    .action(() => failNotImplemented('tool worktree status'));

  worktree
    .command('diff-summary')
    .description('Read a summary of worktree changes.')
    .requiredOption('--run-dir <path>', 'Run directory containing .agentflow')
    .action(() => failNotImplemented('tool worktree diff-summary'));
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

  return {
    error: {
      code: 'AGENTFLOW_TOOL_FAILED',
      message: error instanceof Error ? error.message : String(error),
    },
  };
}
