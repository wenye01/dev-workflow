import type { Command } from 'commander';

import { ClaudeAdapter } from '../../adapters/claude-adapter.js';
import { CodexAdapter } from '../../adapters/codex-adapter.js';
import { MockAdapter } from '../../adapters/mock-adapter.js';
import type { AgentAdapter } from '../../adapters/types.js';
import {
  ConfigError,
  type ProviderConfig,
  loadAgentflowConfig,
} from '../../config/config-loader.js';
import { ProviderRegistry } from '../../config/provider-registry.js';
import { RoleCatalog, RoleCatalogError } from '../../config/role-catalog.js';

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check local provider and configuration readiness.')
    .option(
      '--repo <path>',
      'Repository path for project settings',
      process.cwd(),
    )
    .option('--smoke', 'Run provider command smoke tests')
    .action(
      async (options: { readonly repo: string; readonly smoke?: boolean }) => {
        try {
          const config = await loadAgentflowConfig({ repoPath: options.repo });
          const registry = new ProviderRegistry(config.providers);
          const providers = await Promise.all(
            registry.list().map((provider) =>
              registry.inspect(
                provider,
                {
                  nonInteractive: true,
                  cwd: true,
                  schemaOutput: true,
                },
                { checkCommandAvailability: true },
              ),
            ),
          );
          const roleReadiness = await buildRoleReadiness(config, registry);
          const smokeTests =
            options.smoke === true
              ? await runSmokeTests(registry.list())
              : undefined;
          const ready =
            providers.every((provider) => provider.issues.length === 0) &&
            roleReadiness.every((role) => role.available_candidates > 0);

          if (!ready) {
            process.exitCode = 2;
          }

          console.log(
            JSON.stringify(
              {
                status: ready ? 'ready' : 'not_ready',
                config: config.filePath,
                providers,
                roles: roleReadiness,
                smoke_tests: smokeTests,
              },
              null,
              2,
            ),
          );
        } catch (error) {
          process.exitCode = 2;
          console.error(JSON.stringify(formatDoctorError(error), null, 2));
        }
      },
    );
}

async function buildRoleReadiness(
  config: Awaited<ReturnType<typeof loadAgentflowConfig>>,
  registry: ProviderRegistry,
): Promise<
  readonly {
    readonly role: string;
    readonly provider_candidates: readonly string[];
    readonly available_candidates: number;
    readonly issues: readonly string[];
  }[]
> {
  const catalog = new RoleCatalog(config);

  return await Promise.all(
    catalog.list().map(async (role) => {
      const readiness = await Promise.all(
        role.providerCandidates.map(async (candidate) => {
          const provider = registry.get(candidate.provider);
          if (!provider) {
            return {
              provider: candidate.provider,
              available: false,
              issues: [`provider_not_configured:${candidate.provider}`],
            };
          }

          const inspected = await registry.inspect(
            provider,
            {
              nonInteractive: true,
              cwd: true,
              schemaOutput: true,
            },
            { checkCommandAvailability: true },
          );
          return {
            provider: candidate.provider,
            available: inspected.issues.length === 0,
            issues: inspected.issues.map((issue) => issue.code),
          };
        }),
      );

      return {
        role: role.name,
        provider_candidates: role.providerCandidates.map(
          (candidate) => candidate.provider,
        ),
        available_candidates: readiness.filter((item) => item.available).length,
        issues: readiness.flatMap((item) =>
          item.issues.map((issue) => `${item.provider}:${issue}`),
        ),
      };
    }),
  );
}

async function runSmokeTests(
  providers: readonly ProviderConfig[],
): Promise<unknown[]> {
  const adapters = new Map<string, AgentAdapter>(
    [new MockAdapter(), new CodexAdapter(), new ClaudeAdapter()].map(
      (adapter) => [adapter.providerType, adapter],
    ),
  );

  return await Promise.all(
    providers.map(async (provider) => {
      const adapter = adapters.get(provider.type);
      if (!adapter?.smokeTest) {
        return {
          provider: provider.name,
          type: provider.type,
          status: 'failed',
          message: `No smoke test is registered for provider type: ${provider.type}`,
        };
      }

      return await adapter.smokeTest(provider);
    }),
  );
}

function formatDoctorError(error: unknown): Record<string, unknown> {
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
      code: 'AGENTFLOW_DOCTOR_FAILED',
      message: error instanceof Error ? error.message : String(error),
    },
  };
}
