import { access, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';

import { isRecord } from '../schemas/validator.js';

export type ProviderType = 'mock' | 'codex' | 'claude';

export interface ProviderCapabilityOverrides {
  readonly nonInteractive?: boolean;
  readonly jsonOutput?: boolean;
  readonly jsonlOutput?: boolean;
  readonly schemaOutput?: boolean;
  readonly cwd?: boolean;
  readonly modelSelection?: boolean;
  readonly permissionMode?: boolean;
  readonly debug?: boolean;
  readonly usage?: boolean;
  readonly sandbox?: boolean;
  readonly approval?: boolean;
}

export interface ProviderConfig {
  readonly name: string;
  readonly type: ProviderType;
  readonly command: string;
  readonly model?: string;
  readonly enabled: boolean;
  readonly available?: boolean;
  readonly authenticated?: boolean;
  readonly maxParallelProcesses?: number;
  readonly currentParallelProcesses?: number;
  readonly sandbox?: string;
  readonly approval?: string;
  readonly providerPermissionMode?: string;
  readonly outputFormat?: string;
  readonly inputFormat?: string;
  readonly outputSchemaPath?: string;
  readonly jsonSchema?: unknown;
  readonly json?: boolean;
  readonly jsonl?: boolean;
  readonly verbose?: boolean;
  readonly debug?: boolean | string;
  readonly mockScenario?: string;
  readonly extraArgs: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly capabilityOverrides: ProviderCapabilityOverrides;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface ProviderCandidateConfig {
  readonly provider: string;
  readonly model?: string;
  readonly reason?: string;
}

export interface RoleConfig {
  readonly name: string;
  readonly module?: string;
  readonly writePermission?: string;
  readonly providerCandidates: readonly ProviderCandidateConfig[];
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface AgentflowConfig {
  readonly filePath: string;
  readonly sources: readonly string[];
  readonly providers: Readonly<Record<string, ProviderConfig>>;
  readonly roles: Readonly<Record<string, RoleConfig>>;
  readonly raw: Readonly<Record<string, unknown>>;
}

export class ConfigError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(options: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
    readonly cause?: unknown;
  }) {
    super(options.message);
    this.name = 'ConfigError';
    this.code = options.code;
    this.details = options.details;
    this.cause = options.cause;
  }
}

export const PROJECT_CONFIG_PATH = path.join('.agentflow', 'settings.json');
export const LEGACY_PROJECT_CONFIG_FILE = 'agentflow.config.yaml';
export const GLOBAL_CONFIG_PATH = path.join(
  os.homedir(),
  '.agentflow',
  'settings.json',
);

export interface LoadAgentflowConfigOptions {
  readonly configPath?: string;
  readonly repoPath?: string;
  readonly cwd?: string;
  readonly globalConfigPath?: string | false;
}

const DEFAULT_CONFIG: Readonly<Record<string, unknown>> = {
  providers: {
    codex: {
      type: 'codex',
      command: 'codex',
    },
  },
  roles: {
    'planner.router': {
      provider_candidates: [{ provider: 'codex' }],
    },
    'generator.implementer': {
      module: 'generator',
      write_permission: 'worktree_write',
      provider_candidates: [{ provider: 'codex' }],
    },
    'evaluator.contract_checker': {
      module: 'evaluator',
      write_permission: 'readonly',
      provider_candidates: [{ provider: 'codex' }],
    },
  },
};

export async function loadAgentflowConfig(
  options: string | LoadAgentflowConfigOptions = {},
): Promise<AgentflowConfig> {
  const resolvedOptions =
    typeof options === 'string' ? { configPath: options } : options;
  const sources = await resolveConfigSources(resolvedOptions);
  const parsedSources = await Promise.all(
    sources.map(async (sourcePath) =>
      parseConfigDocument(await readFile(sourcePath, 'utf8'), sourcePath),
    ),
  );
  const merged = parsedSources.reduce(
    (current, source) => mergeConfigRecords(current, source),
    DEFAULT_CONFIG,
  );

  return normalizeConfig(
    merged,
    sources.length > 0 ? sources.join(path.delimiter) : '<defaults>',
    sources,
  );
}

export function parseConfigDocument(
  source: string,
  sourceName = '<config>',
): Readonly<Record<string, unknown>> {
  try {
    const parsed = source.trim().startsWith('{')
      ? (JSON.parse(source) as unknown)
      : (parseYaml(source) as unknown);

    if (parsed === null || parsed === undefined) {
      return {};
    }

    if (!isRecord(parsed) || Array.isArray(parsed)) {
      throw new ConfigError({
        code: 'AGENTFLOW_CONFIG_INVALID_ROOT',
        message: `Agentflow config must be a mapping: ${sourceName}`,
      });
    }

    return parsed;
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }

    throw new ConfigError({
      code: 'AGENTFLOW_CONFIG_PARSE_FAILED',
      message:
        error instanceof Error
          ? `Failed to parse config ${sourceName}: ${error.message}`
          : `Failed to parse config ${sourceName}.`,
      cause: error,
    });
  }
}

export function normalizeConfig(
  raw: Readonly<Record<string, unknown>>,
  filePath = '<config>',
  sources: readonly string[] = filePath === '<config>' ? [] : [filePath],
): AgentflowConfig {
  return {
    filePath,
    sources,
    providers: normalizeProviders(readRecord(raw, 'providers') ?? {}),
    roles: normalizeRoles(readRecord(raw, 'roles') ?? {}),
    raw,
  };
}

export async function resolveConfigSources(
  options: LoadAgentflowConfigOptions = {},
): Promise<readonly string[]> {
  if (options.configPath) {
    return [path.resolve(options.cwd ?? process.cwd(), options.configPath)];
  }

  const repoRoot = path.resolve(
    options.cwd ?? process.cwd(),
    options.repoPath ?? '.',
  );
  const candidates = [
    options.globalConfigPath === false
      ? undefined
      : (options.globalConfigPath ?? GLOBAL_CONFIG_PATH),
    path.join(repoRoot, LEGACY_PROJECT_CONFIG_FILE),
    path.join(repoRoot, PROJECT_CONFIG_PATH),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const existing = await Promise.all(
    candidates.map(async (candidate) =>
      (await pathExists(candidate)) ? candidate : undefined,
    ),
  );

  return existing.filter((candidate): candidate is string =>
    Boolean(candidate),
  );
}

function mergeConfigRecords(
  base: Readonly<Record<string, unknown>>,
  override: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const entries = new Map<string, unknown>(Object.entries(base));

  for (const [key, value] of Object.entries(override)) {
    const previous = entries.get(key);
    entries.set(
      key,
      isPlainRecord(previous) && isPlainRecord(value)
        ? mergeConfigRecords(previous, value)
        : value,
    );
  }

  return Object.fromEntries(entries);
}

function isPlainRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return isRecord(value) && !Array.isArray(value);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeProviders(
  providers: Readonly<Record<string, unknown>>,
): Readonly<Record<string, ProviderConfig>> {
  return Object.fromEntries(
    Object.entries(providers).map(([name, value]) => {
      const raw = normalizeNamedRecord(value, `providers.${name}`);
      const type = normalizeProviderType(
        readString(raw, 'type') ?? inferProviderType(name),
        name,
      );
      const command =
        readString(raw, 'command') ??
        (type === 'mock' ? 'agentflow-mock' : type);

      return [
        name,
        {
          name,
          type,
          command,
          model: readString(raw, 'model'),
          enabled: readBoolean(raw, 'enabled') ?? true,
          available: readBoolean(raw, 'available'),
          authenticated: readBoolean(raw, 'authenticated'),
          maxParallelProcesses: readNumber(raw, 'max_parallel_processes'),
          currentParallelProcesses: readNumber(
            raw,
            'current_parallel_processes',
          ),
          sandbox: readString(raw, 'sandbox'),
          approval: readString(raw, 'approval'),
          providerPermissionMode:
            readString(raw, 'provider_permission_mode') ??
            readString(raw, 'permission_mode'),
          outputFormat: readString(raw, 'output_format'),
          inputFormat: readString(raw, 'input_format'),
          outputSchemaPath: readString(raw, 'output_schema_path'),
          jsonSchema: raw.json_schema,
          json: readBoolean(raw, 'json'),
          jsonl: readBoolean(raw, 'jsonl'),
          verbose: readBoolean(raw, 'verbose'),
          debug: readDebug(raw),
          mockScenario:
            readString(raw, 'mock_scenario') ?? readString(raw, 'scenario'),
          extraArgs: readStringArray(raw, 'extra_args'),
          environment: readStringRecord(raw, 'environment'),
          capabilityOverrides: readCapabilityOverrides(raw),
          raw,
        },
      ];
    }),
  );
}

function normalizeRoles(
  roles: Readonly<Record<string, unknown>>,
): Readonly<Record<string, RoleConfig>> {
  return Object.fromEntries(
    Object.entries(roles).map(([name, value]) => {
      const raw = normalizeNamedRecord(value, `roles.${name}`);
      const providerCandidates = normalizeProviderCandidates(raw, name);

      return [
        name,
        {
          name,
          module: readString(raw, 'module'),
          writePermission: readString(raw, 'write_permission'),
          providerCandidates,
          raw,
        },
      ];
    }),
  );
}

function normalizeProviderCandidates(
  role: Readonly<Record<string, unknown>>,
  roleName: string,
): readonly ProviderCandidateConfig[] {
  const rawCandidates =
    role.provider_candidates ?? role.providerCandidates ?? role.providers;

  if (Array.isArray(rawCandidates)) {
    return rawCandidates.map((candidate, index) => {
      if (typeof candidate === 'string') {
        return { provider: candidate };
      }

      if (!isRecord(candidate)) {
        throw new ConfigError({
          code: 'AGENTFLOW_ROLE_CANDIDATE_INVALID',
          message: `Role provider candidate must be a mapping: ${roleName}[${index}]`,
        });
      }

      const provider = readString(candidate, 'provider');
      if (!provider) {
        throw new ConfigError({
          code: 'AGENTFLOW_ROLE_CANDIDATE_MISSING_PROVIDER',
          message: `Role provider candidate is missing provider: ${roleName}[${index}]`,
        });
      }

      return {
        provider,
        model: readString(candidate, 'model'),
        reason: readString(candidate, 'reason'),
      };
    });
  }

  const provider = readString(role, 'provider');
  if (provider) {
    return [
      {
        provider,
        model: readString(role, 'model'),
      },
    ];
  }

  return [];
}

function normalizeProviderType(
  value: string,
  providerName: string,
): ProviderType {
  if (value === 'mock' || value === 'codex' || value === 'claude') {
    return value;
  }

  throw new ConfigError({
    code: 'AGENTFLOW_PROVIDER_TYPE_UNSUPPORTED',
    message: `Unsupported provider type for ${providerName}: ${value}`,
  });
}

function inferProviderType(providerName: string): ProviderType {
  if (providerName.includes('codex')) {
    return 'codex';
  }

  if (providerName.includes('claude')) {
    return 'claude';
  }

  return 'mock';
}

function readCapabilityOverrides(
  raw: Readonly<Record<string, unknown>>,
): ProviderCapabilityOverrides {
  const nested = readRecord(raw, 'capabilities') ?? {};

  return {
    nonInteractive:
      readBoolean(raw, 'supports_non_interactive') ??
      readBoolean(nested, 'non_interactive'),
    jsonOutput:
      readBoolean(raw, 'supports_json') ?? readBoolean(nested, 'json'),
    jsonlOutput:
      readBoolean(raw, 'supports_jsonl') ?? readBoolean(nested, 'jsonl'),
    schemaOutput:
      readBoolean(raw, 'supports_output_schema') ??
      readBoolean(raw, 'supports_json_schema') ??
      readBoolean(nested, 'schema_output'),
    cwd: readBoolean(raw, 'supports_cwd') ?? readBoolean(nested, 'cwd'),
    modelSelection:
      readBoolean(raw, 'supports_model') ??
      readBoolean(nested, 'model_selection'),
    permissionMode:
      readBoolean(raw, 'supports_permission_mode') ??
      readBoolean(nested, 'permission_mode'),
    debug: readBoolean(raw, 'supports_debug') ?? readBoolean(nested, 'debug'),
    usage: readBoolean(raw, 'supports_usage') ?? readBoolean(nested, 'usage'),
    sandbox:
      readBoolean(raw, 'supports_sandbox') ?? readBoolean(nested, 'sandbox'),
    approval:
      readBoolean(raw, 'supports_approval') ?? readBoolean(nested, 'approval'),
  };
}

function normalizeNamedRecord(
  value: unknown,
  name: string,
): Readonly<Record<string, unknown>> {
  if (isRecord(value) && !Array.isArray(value)) {
    return value;
  }

  throw new ConfigError({
    code: 'AGENTFLOW_CONFIG_SECTION_INVALID',
    message: `Config section must be a mapping: ${name}`,
  });
}

function readRecord(
  raw: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> | undefined {
  const value = raw[key];
  return isRecord(value) && !Array.isArray(value) ? value : undefined;
}

function readString(
  raw: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = raw[key] ?? raw[toCamelCase(key)];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readBoolean(
  raw: Readonly<Record<string, unknown>>,
  key: string,
): boolean | undefined {
  const value = raw[key] ?? raw[toCamelCase(key)];
  return typeof value === 'boolean' ? value : undefined;
}

function readNumber(
  raw: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined {
  const value = raw[key] ?? raw[toCamelCase(key)];

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  return value;
}

function readStringArray(
  raw: Readonly<Record<string, unknown>>,
  key: string,
): readonly string[] {
  const value = raw[key] ?? raw[toCamelCase(key)];

  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === 'string');
}

function readStringRecord(
  raw: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, string>> {
  const value = raw[key] ?? raw[toCamelCase(key)];

  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function readDebug(
  raw: Readonly<Record<string, unknown>>,
): boolean | string | undefined {
  const value = raw.debug;
  return typeof value === 'boolean' || typeof value === 'string'
    ? value
    : undefined;
}

function toCamelCase(value: string): string {
  return value.replace(/_([a-z])/g, (_, letter: string) =>
    letter.toUpperCase(),
  );
}
