import type {
  AgentflowConfig,
  ProviderCandidateConfig,
  RoleConfig,
} from './config-loader.js';

export interface ProviderSelectionHints {
  readonly providerHint?: string;
  readonly modelHint?: string;
}

export interface ResolvedProviderCandidate extends ProviderCandidateConfig {
  readonly hinted: boolean;
  readonly hintAccepted: boolean;
}

export interface ResolvedRoleCandidates {
  readonly role: RoleConfig;
  readonly candidates: readonly ResolvedProviderCandidate[];
  readonly rejectedProviderHint?: string;
  readonly modelHintIgnored?: string;
}

export class RoleCatalogError extends Error {
  readonly code: string;

  constructor(options: { readonly code: string; readonly message: string }) {
    super(options.message);
    this.name = 'RoleCatalogError';
    this.code = options.code;
  }
}

export class RoleCatalog {
  constructor(private readonly config: AgentflowConfig) {}

  list(): readonly RoleConfig[] {
    return Object.values(this.config.roles).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }

  get(roleName: string): RoleConfig {
    const role = this.config.roles[roleName];
    if (!role) {
      throw new RoleCatalogError({
        code: 'AGENTFLOW_ROLE_NOT_FOUND',
        message: `Role is not configured: ${roleName}`,
      });
    }

    if (role.providerCandidates.length === 0) {
      throw new RoleCatalogError({
        code: 'AGENTFLOW_ROLE_HAS_NO_PROVIDER_CANDIDATES',
        message: `Role has no provider_candidates: ${roleName}`,
      });
    }

    return role;
  }

  resolveCandidates(
    roleName: string,
    hints: ProviderSelectionHints = {},
  ): ResolvedRoleCandidates {
    const role = this.get(roleName);
    const hintedCandidate = hints.providerHint
      ? role.providerCandidates.find(
          (candidate) => candidate.provider === hints.providerHint,
        )
      : undefined;
    const rejectedProviderHint =
      hints.providerHint && !hintedCandidate ? hints.providerHint : undefined;

    const ordered = hintedCandidate
      ? [
          hintedCandidate,
          ...role.providerCandidates.filter(
            (candidate) => candidate.provider !== hintedCandidate.provider,
          ),
        ]
      : [...role.providerCandidates];

    const candidates = ordered.map((candidate, index) => {
      const hintAccepted = candidate.provider === hintedCandidate?.provider;
      const model =
        hintAccepted && hints.modelHint ? hints.modelHint : candidate.model;

      return {
        ...candidate,
        model,
        hinted: index === 0 && hintAccepted,
        hintAccepted,
      };
    });

    return {
      role,
      candidates,
      rejectedProviderHint,
      modelHintIgnored:
        hints.modelHint && !hintedCandidate ? hints.modelHint : undefined,
    };
  }
}
