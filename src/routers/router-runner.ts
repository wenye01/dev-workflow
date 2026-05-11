import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { ArtifactStore } from '../artifacts/artifact-store.js';
import { artifactPath, routingPath } from '../artifacts/paths.js';
import type { ArtifactRef } from '../core/types.js';
import { AdapterManager } from '../adapters/adapter-manager.js';
import { loadAgentflowConfig } from '../config/config-loader.js';
import { SchemaRegistry, type LlmPayloadType, type ArtifactType } from '../schemas/registry.js';
import { parseJsonObject } from '../schemas/validator.js';

type RouterOutputType = 'router_dispatch' | 'planner_package' | 'change_package' | 'evaluator_report';

const ROUTER_OUTPUT_MAPPING: Readonly<
  Record<
    RouterOutputType,
    {
      readonly payloadType: LlmPayloadType;
      readonly artifactType: ArtifactType;
    }
  >
> = {
  router_dispatch: {
    payloadType: 'router_dispatch',
    artifactType: 'routing_decision',
  },
  planner_package: {
    payloadType: 'planner_package',
    artifactType: 'planner_package',
  },
  change_package: {
    payloadType: 'change_package',
    artifactType: 'change_package',
  },
  evaluator_report: {
    payloadType: 'evaluator_report',
    artifactType: 'evaluator_report',
  },
};

export interface RouterRouteRunOptions {
  readonly runRoot: string;
  readonly configPath: string;
  readonly requestId: string;
  readonly role: string;
  readonly prompt: string;
  readonly outputArtifact: ArtifactRef;
  readonly providerHint?: string;
  readonly modelHint?: string;
  readonly inputArtifacts?: readonly ArtifactRef[];
  readonly rawPayload?: unknown;
  readonly requiredOutputSchemas?: Readonly<Record<string, string>>;
  readonly roleOutputArtifacts?: Readonly<Record<string, ArtifactRef>>;
  readonly selectedProjectContext?: Record<string, unknown>;
  readonly selectedProjectContexts?: Readonly<Record<string, Record<string, unknown>>>;
  readonly defaultRequiredOutputSchema?: string;
  readonly outputArtifactRef?: ArtifactRef;
}

export interface RouterAggregateRunOptions {
  readonly runRoot: string;
  readonly configPath: string;
  readonly requestId: string;
  readonly role: string;
  readonly prompt: string;
  readonly outputType: RouterOutputType;
  readonly outputArtifact: ArtifactRef;
  readonly providerHint?: string;
  readonly modelHint?: string;
  readonly inputArtifacts?: readonly ArtifactRef[];
  readonly rawPayload?: unknown;
}

export interface RouterRunArtifact {
  readonly ref: ArtifactRef;
  readonly artifact: unknown;
}

export interface RouterRouteRunResult {
  readonly routingDecision: RouterRunArtifact;
  readonly roleRunRequests: readonly RouterRunArtifact[];
}

export interface RouterAggregateRunResult {
  readonly output: RouterRunArtifact;
}

export class RouterRunner {
  constructor(private readonly registry = SchemaRegistry.load()) {}

  async route(options: RouterRouteRunOptions): Promise<RouterRouteRunResult> {
    const rawPayload =
      options.rawPayload ??
      (await this.runRouterAdapter({
        ...options,
        outputArtifact: options.outputArtifact,
      }));
    const store = new ArtifactStore(options.runRoot, this.registry);
    const routeRef = routingPath('decision.json');
    const routeResult = await store.writeFromPayload({
      payloadType: 'router_dispatch',
      artifactType: 'routing_decision',
      ref: routeRef,
      payload: rawPayload,
      metadata: {
        runId: options.requestId,
        artifactId: `routing-decision-${options.requestId}`,
        producer: {
          kind: 'router',
          module: inferModuleFromRole(options.role),
          role: options.role,
        },
        inputArtifacts: options.inputArtifacts ?? [],
        createdAt: new Date().toISOString(),
      },
      renderMarkdown: true,
    });

    const selectedRoles = extractSelectedRoles(rawPayload);
    const roleRunRequests = await Promise.all(
      selectedRoles.map(async (selectedRole, index) => {
        const requestRef = routingRequestPath(index, selectedRole.role);
        const requestPayload = buildRoleRunRequestPayload({
          requestId: `${options.requestId}-${index + 1}`,
          selectedRole,
          context: selectedProjectContextForRole(options, selectedRole.role),
          defaultRequiredOutputSchema:
            options.defaultRequiredOutputSchema ??
            'agentflow.schema.artifact.role_output.v1',
          requiredOutputSchema:
            options.requiredOutputSchemas?.[selectedRole.role] ??
            options.defaultRequiredOutputSchema ??
            'agentflow.schema.artifact.role_output.v1',
          outputArtifact:
            options.roleOutputArtifacts?.[selectedRole.role] ??
            options.outputArtifactRef,
          inputArtifacts: options.inputArtifacts ?? [],
        });

        const result = await store.writeProgramArtifact({
          artifactType: 'role_run_request',
          ref: requestRef,
          payload: requestPayload,
          metadata: {
            runId: options.requestId,
            artifactId: `role-run-request-${options.requestId}-${index + 1}`,
            producer: {
              kind: 'router',
              module: inferModuleFromRole(options.role),
              role: options.role,
            },
            inputArtifacts: options.inputArtifacts ?? [],
            createdAt: new Date().toISOString(),
          },
          renderMarkdown: true,
        });

        return {
          ref: result.ref,
          artifact: result.artifact,
        };
      }),
    );

    return {
      routingDecision: {
        ref: routeResult.ref,
        artifact: routeResult.artifact,
      },
      roleRunRequests,
    };
  }

  async aggregate(
    options: RouterAggregateRunOptions,
  ): Promise<RouterAggregateRunResult> {
    const rawPayload =
      options.rawPayload ??
      (await this.runRouterAdapter({
        ...options,
        outputArtifact: options.outputArtifact,
      }));
    const mapping = ROUTER_OUTPUT_MAPPING[options.outputType];
    const store = new ArtifactStore(options.runRoot, this.registry);
    const result = await store.writeFromPayload({
      payloadType: mapping.payloadType,
      artifactType: mapping.artifactType,
      ref: options.outputArtifact,
      payload: rawPayload,
      metadata: {
        runId: options.requestId,
        artifactId: `${mapping.artifactType}-${options.requestId}`,
        producer: {
          kind: 'router',
          module: inferModuleFromRole(options.role),
          role: options.role,
        },
        inputArtifacts: options.inputArtifacts ?? [],
        createdAt: new Date().toISOString(),
      },
      renderMarkdown: true,
    });

    return {
      output: {
        ref: result.ref,
        artifact: result.artifact,
      },
    };
  }

  private async runRouterAdapter(
    options:
      | RouterRouteRunOptions
      | RouterAggregateRunOptions & { readonly outputArtifact: ArtifactRef },
  ): Promise<Record<string, unknown>> {
    const config = await loadAgentflowConfig(options.configPath);
    const adapterManager = new AdapterManager(config, {
      checkCommandAvailability: false,
    });
    const result = await adapterManager.runRole({
      requestId: options.requestId,
      role: options.role,
      cwd: options.runRoot,
      prompt: options.prompt,
      outputArtifact: options.outputArtifact,
      inputArtifacts: options.inputArtifacts,
      providerHint: options.providerHint,
      modelHint: options.modelHint,
      requireSchemaOutput: true,
    });

    if (!result.outputArtifact) {
      throw new Error(`Router role did not write an output artifact: ${options.role}`);
    }

    const filePath = path.resolve(options.runRoot, result.outputArtifact);
    const raw = await readFile(filePath, 'utf8');
    return parseJsonObject(raw);
  }
}

function extractSelectedRoles(payload: unknown): readonly {
  readonly role: string;
  readonly task: Record<string, unknown>;
  readonly context: Record<string, unknown>;
  readonly write_permission: 'readonly' | 'artifact_write' | 'worktree_write';
  readonly provider_hint?: string;
}[] {
  if (!isRecord(payload)) {
    throw new Error('Router dispatch payload must be an object.');
  }

  const selectedRoles = payload.selected_roles;
  if (!Array.isArray(selectedRoles)) {
    return [];
  }

  return selectedRoles
    .filter(isRecord)
    .map((selectedRole) => ({
      role: String(selectedRole.role ?? ''),
      task: isRecord(selectedRole.task) ? selectedRole.task : {},
      context: isRecord(selectedRole.context) ? selectedRole.context : {},
      write_permission: normalizeWritePermission(
        selectedRole.write_permission,
      ),
      provider_hint:
        typeof selectedRole.provider_hint === 'string'
          ? selectedRole.provider_hint
          : undefined,
    }))
    .filter((selectedRole) => selectedRole.role.length > 0);
}

function buildRoleRunRequestPayload(options: {
  readonly requestId: string;
  readonly selectedRole: {
    readonly role: string;
    readonly task: Record<string, unknown>;
    readonly write_permission: 'readonly' | 'artifact_write' | 'worktree_write';
    readonly provider_hint?: string;
  };
  readonly context: Record<string, unknown>;
  readonly requiredOutputSchema: string;
  readonly outputArtifact?: ArtifactRef;
  readonly inputArtifacts: readonly ArtifactRef[];
  readonly defaultRequiredOutputSchema: string;
}): Record<string, unknown> {
  return {
    request_id: options.requestId,
    role: options.selectedRole.role,
    task: options.selectedRole.task,
    context: options.context,
    write_permission: options.selectedRole.write_permission,
    ...(options.selectedRole.provider_hint
      ? { provider_hint: options.selectedRole.provider_hint }
      : {}),
    ...(options.inputArtifacts.length > 0
      ? { input_artifacts: options.inputArtifacts }
      : {}),
    ...(options.outputArtifact ? { output_artifact: options.outputArtifact } : {}),
    required_output_schema:
      options.requiredOutputSchema || options.defaultRequiredOutputSchema,
  };
}

function selectedProjectContextForRole(
  options: RouterRouteRunOptions,
  role: string,
): Record<string, unknown> {
  return (
    options.selectedProjectContexts?.[role] ??
    options.selectedProjectContext ??
    {}
  );
}

function normalizeWritePermission(
  value: unknown,
): 'readonly' | 'artifact_write' | 'worktree_write' {
  if (value === 'artifact_write' || value === 'worktree_write') {
    return value;
  }

  return 'readonly';
}

function inferModuleFromRole(role: string): 'planner' | 'generator' | 'evaluator' | 'decision' | 'finalize' {
  if (role.startsWith('planner.')) {
    return 'planner';
  }

  if (role.startsWith('generator.')) {
    return 'generator';
  }

  if (role.startsWith('evaluator.')) {
    return 'evaluator';
  }

  return 'decision';
}

function routingRequestPath(index: number, role: string): ArtifactRef {
  const safeRole = role.replace(/[^A-Za-z0-9._-]+/g, '_');
  return artifactPath('routing', 'requests', `${index + 1}-${safeRole}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
