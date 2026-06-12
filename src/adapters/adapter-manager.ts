import type { ArtifactRef } from '../core/types.js';
import type {
  AgentRunCandidate,
  AgentRunRequest,
  AgentRunResult,
} from '../core/types.js';
import type {
  AgentflowConfig,
  ProviderConfig,
} from '../config/config-loader.js';
import {
  ProviderRegistry,
  type ProviderRequirements,
} from '../config/provider-registry.js';
import { RoleCatalog } from '../config/role-catalog.js';
import { CodeagentWrapperClient } from './codeagent-wrapper-adapter.js';
import type { AgentAdapter } from './types.js';

export interface AdapterManagerRunOptions {
  readonly requestId: string;
  readonly role: string;
  readonly cwd: string;
  readonly prompt: string;
  readonly inputArtifacts?: readonly ArtifactRef[];
  readonly outputArtifact?: ArtifactRef;
  readonly environment?: Readonly<Record<string, string>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly providerHint?: string;
  readonly modelHint?: string;
  readonly requireSchemaOutput?: boolean;
  readonly requireJsonOutput?: boolean;
}

export interface AdapterManagerOptions {
  readonly wrapperClient?: AgentAdapter;
  readonly activeProcessCounts?: ReadonlyMap<string, number>;
  readonly checkCommandAvailability?: boolean;
  readonly onCliProcessStarted?: () => void;
}

export class AdapterSelectionError extends Error {
  readonly code: string;
  readonly role: string;
  readonly candidates: readonly AgentRunCandidate[];
  readonly fallbackReasons: readonly string[];

  constructor(options: {
    readonly code: string;
    readonly message: string;
    readonly role: string;
    readonly candidates: readonly AgentRunCandidate[];
    readonly fallbackReasons: readonly string[];
  }) {
    super(options.message);
    this.name = 'AdapterSelectionError';
    this.code = options.code;
    this.role = options.role;
    this.candidates = options.candidates;
    this.fallbackReasons = options.fallbackReasons;
  }

  toStopReportPayload(): Record<string, unknown> {
    return {
      status: 'stopped',
      reason_code: 'provider_selection_failed',
      classification: 'provider_unavailable',
      message: this.message,
      role: this.role,
      candidates: this.candidates,
      fallback_reasons: this.fallbackReasons,
      resume_from: null,
      cannot_resume_reason:
        'No configured provider candidate satisfied the role capability, authentication, concurrency, and worktree requirements.',
      suggested_actions: [
        'Inspect provider capabilities with agentflow tool provider capabilities.',
        'Fix provider authentication or CLI installation.',
        'Update the role provider_candidates in the run config.',
      ],
    };
  }
}

export class AdapterManager {
  private readonly roleCatalog: RoleCatalog;
  private readonly providerRegistry: ProviderRegistry;
  private readonly wrapperClient: AgentAdapter;

  constructor(
    private readonly config: AgentflowConfig,
    private readonly options: AdapterManagerOptions = {},
  ) {
    this.roleCatalog = new RoleCatalog(config);
    this.providerRegistry = new ProviderRegistry(config.providers);
    this.wrapperClient = options.wrapperClient ?? new CodeagentWrapperClient();
  }

  async runRole(options: AdapterManagerRunOptions): Promise<AgentRunResult> {
    const resolved = this.roleCatalog.resolveCandidates(options.role, {
      providerHint: options.providerHint,
      modelHint: options.modelHint,
    });
    const candidates = resolved.candidates.map((candidate) => ({
      provider: candidate.provider,
      model:
        candidate.model ??
        this.config.providers[candidate.provider]?.model ??
        'default',
      reason: candidate.hinted
        ? 'provider_hint_accepted'
        : (candidate.reason ?? 'role_candidate'),
    }));
    const fallbackReasons: string[] = [];

    if (resolved.rejectedProviderHint) {
      fallbackReasons.push(
        `provider_hint_rejected_not_candidate:${resolved.rejectedProviderHint}`,
      );
    }

    if (resolved.modelHintIgnored) {
      fallbackReasons.push(`model_hint_ignored:${resolved.modelHintIgnored}`);
    }

    for (const candidate of resolved.candidates) {
      const provider = this.config.providers[candidate.provider];
      const candidateModel = candidate.model ?? provider?.model ?? 'default';

      if (!provider) {
        fallbackReasons.push(`provider_not_configured:${candidate.provider}`);
        continue;
      }

      const readiness = await this.providerRegistry.inspect(
        provider,
        requirementsForRun(options, candidateModel),
        {
          activeProcessCounts: this.options.activeProcessCounts,
          checkCommandAvailability: this.options.checkCommandAvailability,
        },
      );

      if (readiness.issues.length > 0) {
        fallbackReasons.push(
          `${provider.name}:${readiness.issues
            .map((issue) => issue.code)
            .join(',')}`,
        );
        continue;
      }

      const request = buildRunRequest(options, provider, candidateModel);
      this.options.onCliProcessStarted?.();
      const result = await this.wrapperClient.run(request, provider);
      const decorated = decorateResult({
        result,
        candidates,
        selectionReason: candidate.hinted
          ? 'provider_hint_accepted'
          : 'first_available_candidate',
        fallbackReasons,
      });

      if (!isFallbackableRunFailure(result)) {
        return decorated;
      }

      fallbackReasons.push(
        `${provider.name}:${result.error?.code ?? 'provider_failed'}`,
      );
    }

    throw new AdapterSelectionError({
      code: 'AGENTFLOW_NO_AVAILABLE_PROVIDER',
      message: `No available provider candidate for role: ${options.role}`,
      role: options.role,
      candidates,
      fallbackReasons,
    });
  }

  buildRunRequest(
    options: AdapterManagerRunOptions,
    providerName: string,
    model: string,
  ): AgentRunRequest {
    const provider = this.config.providers[providerName];
    if (!provider) {
      throw new AdapterSelectionError({
        code: 'AGENTFLOW_PROVIDER_NOT_CONFIGURED',
        message: `Provider is not configured: ${providerName}`,
        role: options.role,
        candidates: [],
        fallbackReasons: [`provider_not_configured:${providerName}`],
      });
    }

    return buildRunRequest(options, provider, model);
  }
}

function requirementsForRun(
  options: AdapterManagerRunOptions,
  model: string,
): ProviderRequirements {
  return {
    nonInteractive: true,
    cwd: true,
    modelSelection: model !== 'default',
    schemaOutput:
      options.requireSchemaOutput ?? Boolean(options.outputArtifact),
    jsonOutput: options.requireJsonOutput,
  };
}

function buildRunRequest(
  options: AdapterManagerRunOptions,
  provider: ProviderConfig,
  model: string,
): AgentRunRequest {
  return {
    requestId: options.requestId,
    role: options.role,
    provider: provider.name,
    model,
    cwd: options.cwd,
    prompt: options.prompt,
    inputArtifacts: options.inputArtifacts ?? [],
    outputArtifact: options.outputArtifact,
    environment: options.environment,
    metadata: options.metadata,
  };
}

function decorateResult(options: {
  readonly result: AgentRunResult;
  readonly candidates: readonly AgentRunCandidate[];
  readonly selectionReason: string;
  readonly fallbackReasons: readonly string[];
}): AgentRunResult {
  return {
    ...options.result,
    candidates: options.candidates,
    selectionReason: options.selectionReason,
    fallbackReason:
      options.fallbackReasons.length > 0
        ? options.fallbackReasons.join(';')
        : undefined,
  };
}

function isFallbackableRunFailure(result: AgentRunResult): boolean {
  if (result.status === 'completed' || result.outputArtifact) {
    return false;
  }

  return [
    'AGENTFLOW_PROVIDER_AUTH_FAILED',
    'AGENTFLOW_PROVIDER_PROCESS_START_FAILED',
    'AGENTFLOW_PROVIDER_UNAVAILABLE',
    'AGENTFLOW_PROVIDER_CONCURRENCY_LIMIT',
    'AGENTFLOW_PROVIDER_CAPABILITY_MISSING',
  ].includes(result.error?.code ?? '');
}
