import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type {
  ProviderCapabilityOverrides,
  ProviderConfig,
  ProviderType,
} from './config-loader.js';

const execFileAsync = promisify(execFile);

export interface ProviderCapabilities {
  readonly nonInteractive: boolean;
  readonly jsonOutput: boolean;
  readonly jsonlOutput: boolean;
  readonly schemaOutput: boolean;
  readonly cwd: boolean;
  readonly modelSelection: boolean;
  readonly permissionMode: boolean;
  readonly debug: boolean;
  readonly usage: boolean;
  readonly sandbox: boolean;
  readonly approval: boolean;
}

export interface ProviderRequirements {
  readonly nonInteractive?: boolean;
  readonly jsonOutput?: boolean;
  readonly schemaOutput?: boolean;
  readonly cwd?: boolean;
  readonly modelSelection?: boolean;
  readonly permissionMode?: boolean;
  readonly sandbox?: boolean;
  readonly approval?: boolean;
}

export type ProviderReadinessIssueCode =
  | 'provider_disabled'
  | 'provider_command_unavailable'
  | 'provider_auth_failed'
  | 'provider_concurrency_limit'
  | 'provider_missing_capability';

export interface ProviderReadinessIssue {
  readonly code: ProviderReadinessIssueCode;
  readonly message: string;
  readonly capability?: keyof ProviderCapabilities;
}

export interface ProviderReadiness {
  readonly provider: string;
  readonly type: ProviderType;
  readonly command: string;
  readonly available: boolean;
  readonly authenticated: boolean;
  readonly concurrency: {
    readonly current: number;
    readonly max: number | null;
    readonly available: boolean;
  };
  readonly capabilities: ProviderCapabilities;
  readonly issues: readonly ProviderReadinessIssue[];
}

export interface ProviderRegistryOptions {
  readonly checkCommandAvailability?: boolean;
  readonly commandTimeoutMs?: number;
  readonly activeProcessCounts?: ReadonlyMap<string, number>;
}

const DEFAULT_CAPABILITIES: Readonly<
  Record<ProviderType, ProviderCapabilities>
> = {
  mock: {
    nonInteractive: true,
    jsonOutput: true,
    jsonlOutput: true,
    schemaOutput: true,
    cwd: true,
    modelSelection: true,
    permissionMode: true,
    debug: true,
    usage: true,
    sandbox: true,
    approval: true,
  },
  codex: {
    nonInteractive: true,
    jsonOutput: false,
    jsonlOutput: true,
    schemaOutput: true,
    cwd: true,
    modelSelection: true,
    permissionMode: true,
    debug: true,
    usage: false,
    sandbox: true,
    approval: true,
  },
  claude: {
    nonInteractive: true,
    jsonOutput: true,
    jsonlOutput: true,
    schemaOutput: true,
    cwd: true,
    modelSelection: true,
    permissionMode: true,
    debug: true,
    usage: false,
    sandbox: false,
    approval: false,
  },
};

export class ProviderRegistry {
  private readonly commandAvailability = new Map<string, Promise<boolean>>();

  constructor(
    private readonly providers: Readonly<Record<string, ProviderConfig>>,
  ) {}

  list(): readonly ProviderConfig[] {
    return Object.values(this.providers).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }

  get(providerName: string): ProviderConfig | undefined {
    return this.providers[providerName];
  }

  capabilitiesFor(provider: ProviderConfig): ProviderCapabilities {
    return mergeCapabilities(
      DEFAULT_CAPABILITIES[provider.type],
      provider.capabilityOverrides,
    );
  }

  async inspect(
    provider: ProviderConfig,
    requirements: ProviderRequirements = {},
    options: ProviderRegistryOptions = {},
  ): Promise<ProviderReadiness> {
    const capabilities = this.capabilitiesFor(provider);
    const issues: ProviderReadinessIssue[] = [];
    const commandAvailable = await this.isProviderCommandAvailable(
      provider,
      options,
    );
    const enabled = provider.enabled;
    const authenticated = provider.authenticated !== false;
    const maxParallelProcesses = provider.maxParallelProcesses;
    const max =
      typeof maxParallelProcesses === 'number' && maxParallelProcesses >= 0
        ? maxParallelProcesses
        : null;
    const current =
      options.activeProcessCounts?.get(provider.name) ??
      provider.currentParallelProcesses ??
      0;
    const concurrencyAvailable = max === null || current < max;

    if (!enabled) {
      issues.push({
        code: 'provider_disabled',
        message: `Provider is disabled: ${provider.name}`,
      });
    }

    if (!commandAvailable) {
      issues.push({
        code: 'provider_command_unavailable',
        message: `Provider command is not available: ${provider.command}`,
      });
    }

    if (!authenticated) {
      issues.push({
        code: 'provider_auth_failed',
        message: `Provider is not authenticated: ${provider.name}`,
      });
    }

    if (!concurrencyAvailable) {
      issues.push({
        code: 'provider_concurrency_limit',
        message: `Provider concurrency limit is exhausted: ${provider.name}`,
      });
    }

    for (const issue of missingCapabilities(capabilities, requirements)) {
      issues.push(issue);
    }

    return {
      provider: provider.name,
      type: provider.type,
      command: provider.command,
      available: enabled && commandAvailable,
      authenticated,
      concurrency: {
        current,
        max,
        available: concurrencyAvailable,
      },
      capabilities,
      issues,
    };
  }

  private async isProviderCommandAvailable(
    provider: ProviderConfig,
    options: ProviderRegistryOptions,
  ): Promise<boolean> {
    if (provider.available !== undefined) {
      return provider.available;
    }

    if (provider.type === 'mock') {
      return true;
    }

    if (options.checkCommandAvailability === false) {
      return true;
    }

    const timeoutMs = options.commandTimeoutMs ?? 5_000;
    const cacheKey = `${provider.command}:${timeoutMs}`;
    const cached = this.commandAvailability.get(cacheKey);
    if (cached) {
      return await cached;
    }

    const availability = isCommandAvailable(provider.command, timeoutMs);
    this.commandAvailability.set(cacheKey, availability);
    return await availability;
  }
}

export async function isCommandAvailable(
  command: string,
  timeoutMs = 5_000,
): Promise<boolean> {
  try {
    await execFileAsync(command, ['--version'], {
      timeout: timeoutMs,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function mergeCapabilities(
  defaults: ProviderCapabilities,
  overrides: ProviderCapabilityOverrides,
): ProviderCapabilities {
  return {
    nonInteractive: overrides.nonInteractive ?? defaults.nonInteractive,
    jsonOutput: overrides.jsonOutput ?? defaults.jsonOutput,
    jsonlOutput: overrides.jsonlOutput ?? defaults.jsonlOutput,
    schemaOutput: overrides.schemaOutput ?? defaults.schemaOutput,
    cwd: overrides.cwd ?? defaults.cwd,
    modelSelection: overrides.modelSelection ?? defaults.modelSelection,
    permissionMode: overrides.permissionMode ?? defaults.permissionMode,
    debug: overrides.debug ?? defaults.debug,
    usage: overrides.usage ?? defaults.usage,
    sandbox: overrides.sandbox ?? defaults.sandbox,
    approval: overrides.approval ?? defaults.approval,
  };
}

function missingCapabilities(
  capabilities: ProviderCapabilities,
  requirements: ProviderRequirements,
): readonly ProviderReadinessIssue[] {
  const issues: ProviderReadinessIssue[] = [];
  const requiredCapabilities: readonly (keyof ProviderRequirements)[] = [
    'nonInteractive',
    'jsonOutput',
    'schemaOutput',
    'cwd',
    'modelSelection',
    'permissionMode',
    'sandbox',
    'approval',
  ];

  for (const key of requiredCapabilities) {
    if (!requirements[key]) {
      continue;
    }

    if (key === 'jsonOutput') {
      if (!capabilities.jsonOutput && !capabilities.jsonlOutput) {
        issues.push(missingCapabilityIssue('jsonOutput'));
      }
      continue;
    }

    const capability = key as keyof ProviderCapabilities;
    if (!capabilities[capability]) {
      issues.push(missingCapabilityIssue(capability));
    }
  }

  return issues;
}

function missingCapabilityIssue(
  capability: keyof ProviderCapabilities,
): ProviderReadinessIssue {
  return {
    code: 'provider_missing_capability',
    capability,
    message: `Provider is missing required capability: ${capability}`,
  };
}
