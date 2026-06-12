import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import {
  AdapterManager,
  AdapterSelectionError,
} from '../adapters/adapter-manager.js';
import { ArtifactStore } from '../artifacts/artifact-store.js';
import {
  artifactPath,
  resolveArtifactRef,
  unitChangePackagePath,
  unitGenerationInputPath,
  unitRolePath,
  unitStatePath,
} from '../artifacts/paths.js';
import { loadAgentflowConfig } from '../config/config-loader.js';
import type { ArtifactRef, CommitRef, UnitId } from '../core/types.js';
import { asGitSha } from '../core/types.js';
import type { ContextBuilderResult } from '../context/context-builder.js';
import type { PlannerPipelineResult } from '../planner/planner-pipeline.js';
import { SchemaRegistry } from '../schemas/registry.js';
import {
  isRecord,
  parseJsonObject,
  SchemaValidationError,
} from '../schemas/validator.js';

const execFileAsync = promisify(execFile);

type GeneratorMode = 'initial' | 'fix';

export interface GeneratorPipelineOptions {
  readonly repoRoot: string;
  readonly runId: string;
  readonly configPath?: string;
  readonly context: ContextBuilderResult;
  readonly planner: PlannerPipelineResult;
  readonly mode?: GeneratorMode;
  readonly previousFailures?: readonly Record<string, unknown>[];
  readonly onCliProcessStarted?: () => void;
  readonly onSchemaFailure?: () => void;
}

export interface GeneratorPipelineResult {
  readonly generationInputRef: ArtifactRef;
  readonly routingDecisionRef: ArtifactRef;
  readonly roleRunRequestRef: ArtifactRef;
  readonly roleInputRef: ArtifactRef;
  readonly roleOutputRef: ArtifactRef;
  readonly changePackageRef: ArtifactRef;
  readonly unitStateRef: ArtifactRef;
  readonly commitRef?: CommitRef;
  readonly mode: GeneratorMode;
  readonly changedFiles: readonly string[];
}

export class GeneratorPipelineError extends Error {
  readonly code: string;
  readonly classification: string;
  readonly details?: unknown;

  constructor(options: {
    readonly code: string;
    readonly message: string;
    readonly classification?: string;
    readonly details?: unknown;
    readonly cause?: unknown;
  }) {
    super(options.message);
    this.name = 'GeneratorPipelineError';
    this.code = options.code;
    this.classification = options.classification ?? 'generator_pipeline_failed';
    this.details = options.details;
    this.cause = options.cause;
  }
}

export class GeneratorPipeline {
  constructor(private readonly registry = SchemaRegistry.load()) {}

  async build(
    options: GeneratorPipelineOptions,
  ): Promise<GeneratorPipelineResult> {
    const mode = options.mode ?? 'initial';
    const unitId = options.planner.unitId;
    const unit = await this.readPlannerUnit(
      options.repoRoot,
      options.planner,
      unitId,
    );
    const acceptanceContract = extractArtifactPayload(
      await readJsonArtifact(
        options.repoRoot,
        options.planner.acceptanceContractRef,
      ),
    );
    const selectedProjectContext = await readContextPayload(
      options.repoRoot,
      options.context.outputs.selectedProjectContext,
    );
    const generationInputRef = unitGenerationInputPath(unitId, mode);
    const routingDecisionRef = artifactPath(
      'units',
      unitId,
      `generator-routing.${mode}.json`,
    );
    const roleRunRequestRef = artifactPath(
      'units',
      unitId,
      `generator-request.${mode}.json`,
    );
    const roleInputRef = unitRolePath(unitId, `generator-input.${mode}.json`);
    const rawRoleOutputRef = unitRolePath(
      unitId,
      `generator-output.raw.${mode}.json`,
    );
    const roleOutputRef = unitRolePath(unitId, `generator-output.${mode}.json`);
    const changePackageRef = unitChangePackagePath(unitId, mode);
    const unitStateRef = unitStatePath(unitId);
    const store = new ArtifactStore(options.repoRoot, this.registry);
    const constraints = generatorConstraints(unit);
    const previousFailures = options.previousFailures ?? [];

    await store.writeProgramArtifact({
      artifactType: 'generation_input',
      ref: generationInputRef,
      payload: {
        mode,
        unit,
        acceptance_contract: acceptanceContract,
        context: selectedProjectContext,
        constraints,
        previous_failures: previousFailures,
      },
      metadata: generatorMetadata(options, unitId, {
        artifactId: `generation-input-${unitId}-${mode}`,
        role: 'generator.router',
        inputArtifacts: [
          options.planner.plannerPackageRef,
          options.planner.acceptanceContractRef,
          options.context.outputs.selectedProjectContext,
        ],
      }),
      renderMarkdown: true,
    });

    await store.writeFromPayload({
      payloadType: 'router_dispatch',
      artifactType: 'routing_decision',
      ref: routingDecisionRef,
      payload: buildGeneratorRoutePayload(
        mode,
        unit,
        constraints,
        previousFailures,
      ),
      metadata: generatorMetadata(options, unitId, {
        artifactId: `generator-routing-${unitId}-${mode}`,
        role: 'generator.router',
        inputArtifacts: [generationInputRef],
      }),
      renderMarkdown: true,
    });

    const roleRunRequestPayload = {
      request_id: `${options.runId}-${unitId}-generator-${mode}`,
      role: 'generator.implementer',
      task: {
        goal:
          stringField(unit, 'goal') ??
          stringField(unit, 'title') ??
          'Implement unit changes.',
        scope: constraints.allowed_paths,
        non_goals: [],
      },
      context: selectedProjectContext,
      write_permission: 'worktree_write',
      input_artifacts: [generationInputRef, roleInputRef],
      output_artifact: rawRoleOutputRef,
      required_output_schema: 'agentflow.schema.llm.role_output.v1',
      provider_hint: 'local',
    };
    await store.writeProgramArtifact({
      artifactType: 'role_run_request',
      ref: roleRunRequestRef,
      payload: roleRunRequestPayload,
      metadata: generatorMetadata(options, unitId, {
        artifactId: `generator-role-request-${unitId}-${mode}`,
        role: 'generator.router',
        inputArtifacts: [generationInputRef],
      }),
      renderMarkdown: true,
    });

    await store.writeProgramArtifact({
      artifactType: 'role_input',
      ref: roleInputRef,
      payload: {
        role: 'generator.implementer',
        task: roleRunRequestPayload.task,
        acceptance_contract: acceptanceContract,
        context: selectedProjectContext,
        constraints,
        required_output_schema: 'agentflow.schema.llm.role_output.v1',
      },
      metadata: generatorMetadata(options, unitId, {
        artifactId: `generator-role-input-${unitId}-${mode}`,
        role: 'generator.router',
        inputArtifacts: [generationInputRef, roleRunRequestRef],
      }),
      renderMarkdown: true,
    });

    const beforeStatus = await gitStatus(options.repoRoot);
    const agentResult = await this.runGeneratorRole({
      ...options,
      mode,
      outputArtifact: rawRoleOutputRef,
      inputArtifacts: [generationInputRef, roleInputRef],
      allowedPaths: constraints.allowed_paths,
    });
    if (agentResult.status !== 'completed' || !agentResult.outputArtifact) {
      throw new GeneratorPipelineError({
        code: 'AGENTFLOW_GENERATOR_ROLE_FAILED',
        message:
          agentResult.error?.message ?? 'Generator role did not complete.',
        classification: 'generator_role_failed',
        details: agentResult,
      });
    }

    const roleOutputPayload = await readRoleOutputPayload(
      options.repoRoot,
      agentResult.outputArtifact,
      this.registry,
      options.onSchemaFailure,
    );
    await store.writeFromPayload({
      payloadType: 'role_output',
      artifactType: 'role_output',
      ref: roleOutputRef,
      payload: roleOutputPayload,
      metadata: generatorMetadata(options, unitId, {
        artifactId: `generator-role-output-${unitId}-${mode}`,
        role: 'generator.implementer',
        provider: agentResult.provider,
        model: agentResult.model,
        inputArtifacts: [generationInputRef, roleInputRef, roleRunRequestRef],
      }),
      renderMarkdown: true,
    });

    const afterStatus = await gitStatus(options.repoRoot);
    const audit = auditGeneratorChanges({
      beforeStatus,
      afterStatus,
      allowedPaths: constraints.allowed_paths,
      forbiddenPaths: constraints.forbidden_paths,
      roleOutputPayload,
    });
    if (audit.violations.length > 0) {
      throw new GeneratorPipelineError({
        code: 'AGENTFLOW_GENERATOR_SCOPE_AUDIT_FAILED',
        message: 'Generator produced changes outside its allowed scope.',
        classification: 'scope_violation',
        details: audit,
      });
    }
    if (audit.changedFiles.length === 0) {
      throw new GeneratorPipelineError({
        code: 'AGENTFLOW_GENERATOR_NO_EFFECTIVE_CHANGE',
        message: 'Generator produced no effective changed files.',
        classification: 'no_effective_change',
        details: audit,
      });
    }

    const commitRef = await commitGeneratorChanges(
      options.repoRoot,
      unitId,
      mode,
      audit.changedFiles,
    );
    const changePackagePayload = buildChangePackagePayload({
      mode,
      roleOutputPayload,
      changedFiles: audit.changedFiles,
      audit,
      acceptanceContract,
    });
    await store.writeFromPayload({
      payloadType: 'change_package',
      artifactType: 'change_package',
      ref: changePackageRef,
      payload: changePackagePayload,
      metadata: generatorMetadata(options, unitId, {
        artifactId: `change-package-${unitId}-${mode}`,
        role: 'generator.router',
        inputArtifacts: [roleOutputRef, generationInputRef, roleRunRequestRef],
        commitRefs: commitRef ? [commitRef] : [],
      }),
      renderMarkdown: true,
    });

    await store.writeStateArtifact({
      artifactType: 'unit_state',
      ref: unitStateRef,
      state: {
        schema_version: 'agentflow.unit_state.v1',
        unit_id: unitId,
        batch_id: options.planner.batchId,
        status: 'evaluator_aggregate',
        attempt: mode === 'fix' ? 1 : 0,
        fix_round: mode === 'fix' ? 1 : 0,
        dependencies: [],
        artifacts: {
          generation_input: generationInputRef,
          generator_routing_decision: routingDecisionRef,
          generator_role_run_request: roleRunRequestRef,
          generator_role_input: roleInputRef,
          generator_role_output: roleOutputRef,
          change_package: changePackageRef,
          acceptance_contract: options.planner.acceptanceContractRef,
          planner_package: options.planner.plannerPackageRef,
        },
        commits: commitRef ? [commitRef] : [],
        pending_transition: null,
        locks: {
          file_scope: constraints.allowed_paths,
        },
        updated_at: new Date().toISOString(),
      },
      metadata: generatorMetadata(options, unitId, {
        artifactId: `unit-state-${unitId}`,
        role: 'generator.router',
        inputArtifacts: [changePackageRef],
        commitRefs: commitRef ? [commitRef] : [],
      }),
    });

    return {
      generationInputRef,
      routingDecisionRef,
      roleRunRequestRef,
      roleInputRef,
      roleOutputRef,
      changePackageRef,
      unitStateRef,
      commitRef,
      mode,
      changedFiles: audit.changedFiles,
    };
  }

  private async readPlannerUnit(
    repoRoot: string,
    planner: PlannerPipelineResult,
    unitId: UnitId,
  ): Promise<Record<string, unknown>> {
    const plannerPackage = extractArtifactPayload(
      await readJsonArtifact(repoRoot, planner.plannerPackageRef),
    );
    const units = Array.isArray(plannerPackage.units)
      ? plannerPackage.units.filter(isRecord)
      : [];
    const unit = units.find((candidate) => candidate.ref === unitId);
    if (!unit) {
      throw new GeneratorPipelineError({
        code: 'AGENTFLOW_GENERATOR_UNIT_NOT_FOUND',
        message: `Planner Package does not contain unit: ${unitId}`,
      });
    }
    return unit;
  }

  private async runGeneratorRole(options: {
    readonly repoRoot: string;
    readonly runId: string;
    readonly configPath?: string;
    readonly mode: GeneratorMode;
    readonly outputArtifact: ArtifactRef;
    readonly inputArtifacts: readonly ArtifactRef[];
    readonly allowedPaths: readonly string[];
    readonly onCliProcessStarted?: () => void;
  }) {
    const config = await loadAgentflowConfig({
      configPath: options.configPath,
      repoPath: options.repoRoot,
    });
    const manager = new AdapterManager(config, {
      checkCommandAvailability: false,
      onCliProcessStarted: options.onCliProcessStarted,
    });
    try {
      return await manager.runRole({
        requestId: `${options.runId}-generator-${options.mode}`,
        role: 'generator.implementer',
        cwd: options.repoRoot,
        prompt: generatorPrompt(options.mode),
        outputArtifact: options.outputArtifact,
        inputArtifacts: options.inputArtifacts,
        requireSchemaOutput: true,
        metadata: {
          allowedPaths: options.allowedPaths,
        },
      });
    } catch (error) {
      if (error instanceof AdapterSelectionError) {
        throw new GeneratorPipelineError({
          code: error.code,
          message: error.message,
          classification: 'provider_unavailable',
          details: error.toStopReportPayload(),
          cause: error,
        });
      }
      throw error;
    }
  }
}

function buildGeneratorRoutePayload(
  mode: GeneratorMode,
  unit: Record<string, unknown>,
  constraints: GeneratorConstraints,
  previousFailures: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return {
    mode,
    selected_roles: [
      {
        role: 'generator.implementer',
        task: {
          goal:
            stringField(unit, 'goal') ??
            stringField(unit, 'title') ??
            'Implement unit changes.',
          scope: constraints.allowed_paths,
          non_goals: [],
        },
        context: {
          modules: ['generator'],
          source_paths: constraints.allowed_paths,
          include_artifacts: [
            'generation-input',
            'acceptance-contract',
            ...(previousFailures.length > 0 ? ['previous-failures'] : []),
          ],
          include_feedback: previousFailures.map(
            (_, index) => `previous-failure-${index + 1}`,
          ),
        },
        write_permission: 'worktree_write',
      },
    ],
    execution_plan: [['generator.implementer']],
    aggregation: {
      strategy: 'change_package_from_role_output_and_diff_audit',
      required_checks: ['schema', 'scope_audit', 'effective_change'],
    },
    rationale:
      'MVP-0 fixes generator writer concurrency at one role and aggregates its output into one Change Package.',
  };
}

interface GeneratorConstraints {
  readonly write_permission: 'worktree_write';
  readonly allowed_paths: readonly string[];
  readonly forbidden_paths: readonly string[];
  readonly forbidden_actions: readonly string[];
  readonly max_writer_concurrency: 1;
}

function generatorConstraints(
  unit: Record<string, unknown>,
): GeneratorConstraints {
  const scope = isRecord(unit.scope) ? unit.scope : {};
  return {
    write_permission: 'worktree_write',
    allowed_paths: stringArray(scope.allowed_paths, ['src/**', 'tests/**']),
    forbidden_paths: stringArray(scope.forbidden_paths, [
      '.env',
      '.env.*',
      '.git/**',
      '.agentflow-worktrees/**',
      'node_modules/**',
    ]),
    forbidden_actions: ['push', 'merge', 'deploy', 'reset-hard'],
    max_writer_concurrency: 1,
  };
}

function generatorPrompt(mode: GeneratorMode): string {
  return [
    `Run the generator role in ${mode} mode.`,
    'Read the generation input and role input artifacts.',
    'Write only valid JSON matching agentflow.schema.llm.role_output.v1 to the requested output artifact.',
  ].join('\n');
}

async function readRoleOutputPayload(
  repoRoot: string,
  ref: ArtifactRef,
  registry: SchemaRegistry,
  onSchemaFailure?: () => void,
): Promise<Record<string, unknown>> {
  let raw: Record<string, unknown>;
  try {
    raw = parseJsonObject(await readFile(resolveArtifactRef(repoRoot, ref), 'utf8'));
  } catch (error) {
    if (error instanceof SchemaValidationError) {
      onSchemaFailure?.();
    }
    throw error;
  }
  const payload = isCanonicalRoleOutput(raw) ? raw.payload : raw;
  try {
    registry.assertLlmPayload('role_output', payload);
  } catch (error) {
    if (error instanceof SchemaValidationError) {
      onSchemaFailure?.();
    }
    throw error;
  }
  return payload as Record<string, unknown>;
}

function isCanonicalRoleOutput(
  value: unknown,
): value is { readonly payload: unknown } {
  return (
    isRecord(value) &&
    value.artifact_type === 'role_output' &&
    'payload' in value
  );
}

function buildChangePackagePayload(options: {
  readonly mode: GeneratorMode;
  readonly roleOutputPayload: Record<string, unknown>;
  readonly changedFiles: readonly string[];
  readonly audit: GeneratorAudit;
  readonly acceptanceContract: Record<string, unknown>;
}): Record<string, unknown> {
  const roleChangedFiles = readChangedFiles(options.roleOutputPayload);
  const changedFiles =
    roleChangedFiles.length > 0
      ? roleChangedFiles
      : options.changedFiles.map((filePath) => ({
          path: filePath,
          change_type: 'modified',
          reason: 'Changed by generator role.',
        }));
  const criteria = Array.isArray(options.acceptanceContract.criteria)
    ? options.acceptanceContract.criteria.filter(isRecord)
    : [];

  return {
    mode: options.mode,
    summary:
      typeof options.roleOutputPayload.summary === 'string'
        ? options.roleOutputPayload.summary
        : 'Generator produced changes for the execution unit.',
    changed_files: changedFiles,
    verification: arrayOrDefault(options.roleOutputPayload.verification, [
      {
        command: 'not run',
        kind: 'custom',
        status: 'not_run',
        summary: 'Verification is deferred to the Evaluator pipeline.',
      },
    ]),
    criteria_mapping: arrayOrDefault(
      options.roleOutputPayload.criteria_mapping,
      criteria.map((criterion) => ({
        criterion: String(criterion.ref ?? 'criterion-generated'),
        status: 'not_checked',
        evidence: [],
        notes:
          'Generator defers authoritative acceptance judgment to Evaluator.',
      })),
    ),
    scope_notes: {
      status: 'within_scope',
      out_of_scope_paths: [],
      explanation: `Scope audit passed for ${options.audit.changedFiles.length} changed file(s).`,
    },
    unresolved_issues: arrayOrDefault(options.roleOutputPayload.issues, []),
    residual_risks: arrayOrDefault(options.roleOutputPayload.risks, []),
    recommended_evaluator_focus: ['acceptance contract', 'diff correctness'],
  };
}

interface GeneratorAudit {
  readonly changedFiles: readonly string[];
  readonly forbiddenFiles: readonly string[];
  readonly outOfScopeFiles: readonly string[];
  readonly sensitiveFiles: readonly string[];
  readonly violations: readonly string[];
}

function auditGeneratorChanges(options: {
  readonly beforeStatus: ReadonlyMap<string, string>;
  readonly afterStatus: ReadonlyMap<string, string>;
  readonly allowedPaths: readonly string[];
  readonly forbiddenPaths: readonly string[];
  readonly roleOutputPayload: Record<string, unknown>;
}): GeneratorAudit {
  const before = options.beforeStatus;
  const statusChanged = [...options.afterStatus.keys()].filter(
    (filePath) =>
      !isAgentflowInternalPath(filePath) &&
      before.get(filePath) !== options.afterStatus.get(filePath),
  );
  const roleChanged = readChangedFiles(options.roleOutputPayload).map(
    (file) => file.path,
  );
  const changedFiles = uniqueStrings([...statusChanged, ...roleChanged]).filter(
    (filePath) => !isAgentflowInternalPath(filePath),
  );
  const forbiddenFiles = changedFiles.filter((filePath) =>
    options.forbiddenPaths.some((pattern) =>
      pathMatchesPattern(filePath, pattern),
    ),
  );
  const outOfScopeFiles = changedFiles.filter(
    (filePath) =>
      !options.allowedPaths.some((pattern) =>
        pathMatchesPattern(filePath, pattern),
      ),
  );
  const sensitiveFiles = changedFiles.filter(looksSensitivePath);
  const violations = [
    ...forbiddenFiles.map((filePath) => `forbidden_path:${filePath}`),
    ...outOfScopeFiles.map((filePath) => `out_of_scope:${filePath}`),
    ...sensitiveFiles.map((filePath) => `sensitive_path:${filePath}`),
  ];

  return {
    changedFiles,
    forbiddenFiles,
    outOfScopeFiles,
    sensitiveFiles,
    violations,
  };
}

async function commitGeneratorChanges(
  repoRoot: string,
  unitId: UnitId,
  mode: GeneratorMode,
  changedFiles: readonly string[],
): Promise<CommitRef | undefined> {
  const paths = uniqueStrings(['.agentflow', ...changedFiles]);
  if (paths.length === 0) {
    return undefined;
  }

  await git(repoRoot, ['add', '--', ...paths]);
  const staged = await git(repoRoot, ['diff', '--cached', '--name-only']);
  if (!staged.trim()) {
    return undefined;
  }

  await git(repoRoot, [
    'commit',
    '-m',
    `agentflow generator ${mode}: ${unitId}`,
  ]);
  const [sha, subject, committedAt] = await Promise.all([
    git(repoRoot, ['rev-parse', 'HEAD']),
    git(repoRoot, ['log', '-1', '--pretty=%s']),
    git(repoRoot, ['log', '-1', '--pretty=%cI']),
  ]);
  return {
    sha: asGitSha(sha.trim()),
    subject: subject.trim(),
    committedAt: committedAt.trim(),
  };
}

async function gitStatus(
  repoRoot: string,
): Promise<ReadonlyMap<string, string>> {
  const raw = await git(repoRoot, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ]);
  const entries = new Map<string, string>();
  for (const line of raw.split('\n').filter(Boolean)) {
    entries.set(normalizeStatusPath(line.slice(3)), line.slice(0, 2));
  }
  return entries;
}

async function git(repoRoot: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], { cwd: repoRoot });
  return stdout;
}

async function readContextPayload(
  repoRoot: string,
  ref: ArtifactRef,
): Promise<Record<string, unknown>> {
  return parseJsonObject(
    await readFile(resolveArtifactRef(repoRoot, ref), 'utf8'),
  );
}

async function readJsonArtifact(
  repoRoot: string,
  ref: ArtifactRef,
): Promise<Record<string, unknown>> {
  return parseJsonObject(
    await readFile(resolveArtifactRef(repoRoot, ref), 'utf8'),
  );
}

function extractArtifactPayload(
  artifact: Record<string, unknown>,
): Record<string, unknown> {
  const payload = artifact.payload;
  return isRecord(payload) ? payload : artifact;
}

function generatorMetadata(
  options: GeneratorPipelineOptions,
  unitId: UnitId,
  input: {
    readonly artifactId: string;
    readonly role: string;
    readonly provider?: string;
    readonly model?: string;
    readonly inputArtifacts: readonly ArtifactRef[];
    readonly commitRefs?: readonly CommitRef[];
  },
) {
  return {
    runId: options.runId,
    batchId: options.planner.batchId,
    unitId,
    artifactId: input.artifactId,
    attempt: options.mode === 'fix' ? 1 : 0,
    fixRound: options.mode === 'fix' ? 1 : 0,
    producer: {
      kind: input.role === 'generator.implementer' ? 'role' : 'router',
      module: 'generator',
      role: input.role,
      provider: input.provider,
      model: input.model,
    } as const,
    inputArtifacts: input.inputArtifacts,
    commitRefs: input.commitRefs,
  };
}

function readChangedFiles(payload: Record<string, unknown>): {
  readonly path: string;
  readonly change_type: string;
  readonly reason: string;
}[] {
  if (!Array.isArray(payload.changed_files)) {
    return [];
  }
  return payload.changed_files
    .filter(isRecord)
    .map((file) => ({
      path: String(file.path ?? ''),
      change_type: String(file.change_type ?? 'unknown'),
      reason: String(file.reason ?? 'Changed by generator role.'),
    }))
    .filter((file) => file.path.length > 0);
}

function arrayOrDefault<T>(value: unknown, fallback: readonly T[]): unknown {
  return Array.isArray(value) ? value : fallback;
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringArray(
  value: unknown,
  fallback: readonly string[],
): readonly string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string => typeof item === 'string' && item.length > 0,
      )
    : fallback;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function isAgentflowInternalPath(filePath: string): boolean {
  return filePath === '.agentflow' || filePath.startsWith('.agentflow/');
}

function normalizeStatusPath(value: string): string {
  const renamed = value.split(' -> ').at(-1) ?? value;
  return renamed.trim().replace(/^"|"$/g, '');
}

function pathMatchesPattern(filePath: string, pattern: string): boolean {
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    return filePath === prefix.slice(0, -1) || filePath.startsWith(prefix);
  }
  if (pattern.endsWith('*')) {
    return filePath.startsWith(pattern.slice(0, -1));
  }
  return filePath === pattern;
}

function looksSensitivePath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    lower.includes('secret') ||
    lower.includes('credential') ||
    lower.endsWith('.pem') ||
    lower === '.env' ||
    lower.startsWith('.env.')
  );
}
