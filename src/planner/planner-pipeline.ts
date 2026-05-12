import { readFile } from 'node:fs/promises';

import { ArtifactStore } from '../artifacts/artifact-store.js';
import {
  artifactPath,
  plannerBatchSchedulePath,
  plannerPath,
  resolveArtifactRef,
  runStatePath,
  unitContractPath,
  unitStatePath,
  worktreePath,
} from '../artifacts/paths.js';
import type { ArtifactRef, UnitId } from '../core/types.js';
import { asRunId, asUnitId } from '../core/types.js';
import type { ContextBuilderResult } from '../context/context-builder.js';
import { SchemaRegistry } from '../schemas/registry.js';
import { parseJsonObject } from '../schemas/validator.js';

export interface PlannerPipelineOptions {
  readonly repoRoot: string;
  readonly runId: string;
  readonly taskPath: string;
  readonly context: ContextBuilderResult;
}

export interface PlannerPipelineResult {
  readonly runStateRef: ArtifactRef;
  readonly unitStateRef: ArtifactRef;
  readonly routingDecisionRef: ArtifactRef;
  readonly roleRunRequestRefs: readonly ArtifactRef[];
  readonly plannerPackageRef: ArtifactRef;
  readonly batchScheduleRef: ArtifactRef;
  readonly acceptanceContractRef: ArtifactRef;
  readonly unitId: UnitId;
  readonly batchId: string;
}

export class PlannerPipelineError extends Error {
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
    this.name = 'PlannerPipelineError';
    this.code = options.code;
    this.classification = options.classification ?? 'planner_pipeline_failed';
    this.details = options.details;
    this.cause = options.cause;
  }
}

export class PlannerPipeline {
  constructor(private readonly registry = SchemaRegistry.load()) {}

  async build(options: PlannerPipelineOptions): Promise<PlannerPipelineResult> {
    const taskText = await readFile(options.taskPath, 'utf8');
    const selectedProjectContextArtifact = await readJsonArtifact(
      options.repoRoot,
      options.context.outputs.selectedProjectContext,
    );
    const selectedProjectContext = extractArtifactPayload(
      selectedProjectContextArtifact,
    );
    const plannerSourceSliceArtifact = options.context.outputs.sourceSlices[0]
      ? await readJsonArtifact(
          options.repoRoot,
          options.context.outputs.sourceSlices[0],
        )
      : {};
    const plannerSourceSlice = extractArtifactPayload(plannerSourceSliceArtifact);

    const unitId = asUnitId('auth-refresh');
    const batchId = 'batch-001';
    const routingDecisionRef = artifactPath('routing', 'decision.json');
    const roleRunRequestRef = artifactPath(
      'routing',
      'requests',
      '1-planner.initial.json',
    );
    const plannerPackageRef = plannerPath('package.json');
    const batchScheduleRef = plannerBatchSchedulePath();
    const acceptanceContractRef = unitContractPath(unitId);
    const runStateRef = runStatePath();
    const unitStateRef = unitStatePath(unitId);

    const verificationCommand = await this.selectVerificationCommand(
      options.repoRoot,
      selectedProjectContext,
    );

    const routePayload = buildRouterDispatchPayload({
      taskText,
      allowedPaths: selectedAllowedPaths(plannerSourceSlice),
    });

    const store = new ArtifactStore(options.repoRoot, this.registry);

    await store.writeFromPayload({
      payloadType: 'router_dispatch',
      artifactType: 'routing_decision',
      ref: routingDecisionRef,
      payload: routePayload,
      metadata: {
        runId: options.runId,
        artifactId: `planner-routing-${options.runId}`,
        producer: {
          kind: 'orchestrator',
          module: 'planner',
          role: 'planner.router',
        },
        inputArtifacts: [
          options.context.outputs.task,
          options.context.outputs.projectIndexRef,
          options.context.outputs.worktreeStatus,
          options.context.outputs.selectedProjectContext,
        ],
      },
      renderMarkdown: true,
    });

    const roleRunRequestPayload = buildRoleRunRequestPayload({
      requestId: `${options.runId}-planner-1`,
      taskText,
      selectedProjectContext,
      outputArtifact: plannerPackageRef,
      inputArtifacts: [
        options.context.outputs.task,
        options.context.outputs.projectIndexRef,
        options.context.outputs.worktreeStatus,
        options.context.outputs.selectedProjectContext,
        options.context.outputs.roleInputs[0] ?? plannerPath('package.json'),
      ],
      allowedPaths: selectedAllowedPaths(plannerSourceSlice),
    });

    await store.writeProgramArtifact({
      artifactType: 'role_run_request',
      ref: roleRunRequestRef,
      payload: roleRunRequestPayload,
      metadata: {
        runId: options.runId,
        artifactId: `planner-role-run-request-${options.runId}`,
        producer: {
          kind: 'router',
          module: 'planner',
          role: 'planner.router',
        },
        inputArtifacts: [
          options.context.outputs.task,
          options.context.outputs.projectIndexRef,
          options.context.outputs.worktreeStatus,
          options.context.outputs.selectedProjectContext,
        ],
      },
      renderMarkdown: true,
    });

    const plannerPackagePayload = buildPlannerPackagePayload({
      taskText,
      allowedPaths: selectedAllowedPaths(plannerSourceSlice),
      verificationCommand,
    });

    this.registry.assertLlmPayload('planner_package', plannerPackagePayload);

    await store.writeFromPayload({
      payloadType: 'planner_package',
      artifactType: 'planner_package',
      ref: plannerPackageRef,
      payload: plannerPackagePayload,
      metadata: {
        runId: options.runId,
        artifactId: `planner-package-${options.runId}`,
        producer: {
          kind: 'router',
          module: 'planner',
          role: 'planner.initial',
        },
        inputArtifacts: [
          options.context.outputs.task,
          options.context.outputs.projectIndexRef,
          options.context.outputs.worktreeStatus,
          options.context.outputs.selectedProjectContext,
          options.context.outputs.roleInputs[0] ?? plannerPath('package.json'),
        ],
      },
      renderMarkdown: true,
    });

    const plannerPackage = plannerPackagePayload as {
      readonly contracts?: readonly Record<string, unknown>[];
    };
    const acceptanceContractSource = plannerPackage.contracts?.[0] ?? null;
    if (!acceptanceContractSource) {
      throw new PlannerPipelineError({
        code: 'AGENTFLOW_PLANNER_ACCEPTANCE_CONTRACT_MISSING',
        message: 'Planner Package did not produce an acceptance contract.',
      });
    }
    const acceptanceContractPayload = Object.fromEntries(
      Object.entries(acceptanceContractSource).filter(
        ([key]) => key !== 'unit_ref',
      ),
    );

    await store.writeProgramArtifact({
      artifactType: 'acceptance_contract',
      ref: acceptanceContractRef,
      payload: acceptanceContractPayload,
      metadata: {
        runId: options.runId,
        unitId,
        artifactId: `acceptance-contract-${unitId}`,
        producer: {
          kind: 'router',
          module: 'planner',
          role: 'planner.acceptance_designer',
        },
        inputArtifacts: [plannerPackageRef],
      },
      renderMarkdown: true,
    });

    const batchSchedulePayload = {
      current_batch_id: batchId,
      batches: [
        {
          batch_id: batchId,
          unit_ids: [unitId],
          parallel: false,
        },
      ],
    };
    await store.writeProgramArtifact({
      artifactType: 'batch_schedule',
      ref: batchScheduleRef,
      payload: batchSchedulePayload,
      metadata: {
        runId: options.runId,
        artifactId: `batch-schedule-${options.runId}`,
        producer: {
          kind: 'router',
          module: 'planner',
          role: 'planner.batch_builder',
        },
        inputArtifacts: [plannerPackageRef, acceptanceContractRef],
      },
      renderMarkdown: true,
    });

    const createdAt = new Date().toISOString();
    await store.writeStateArtifact({
      artifactType: 'run_state',
      ref: runStateRef,
      state: {
        schema_version: 'agentflow.run_state.v1',
        run_id: options.runId,
        status: 'running',
        worktree_path: worktreePath(asRunId(options.runId)),
        workspace_mode: 'git_worktree',
        current_batch_id: batchId,
        started_at: createdAt,
        updated_at: createdAt,
        last_stable_state: 'planner_ready',
        resume_from: null,
        config_snapshot_ref: null,
        budgets: {
          max_batches: 1,
          max_units: 1,
          max_fix_rounds: 1,
          max_evaluator_retries: 1,
        },
        counters: {
          cli_processes_started: 0,
          commits_created: 0,
          schema_failures: 0,
          fix_loops: 0,
        },
        stop_reason: null,
      },
      metadata: {
        runId: options.runId,
        artifactId: `run-state-${options.runId}`,
        producer: {
          kind: 'system',
        },
        createdAt,
      },
    });

    await store.writeStateArtifact({
      artifactType: 'unit_state',
      ref: unitStateRef,
      state: {
        schema_version: 'agentflow.unit_state.v1',
        unit_id: unitId,
        batch_id: batchId,
        status: 'ready',
        attempt: 0,
        fix_round: 0,
        dependencies: [],
        artifacts: {
          routing_decision: routingDecisionRef,
          role_run_request: roleRunRequestRef,
          planner_package: plannerPackageRef,
          batch_schedule: batchScheduleRef,
          acceptance_contract: acceptanceContractRef,
        },
        commits: [],
        pending_transition: null,
        locks: {
          file_scope: selectedAllowedPaths(plannerSourceSlice).slice(0, 8),
        },
        updated_at: createdAt,
      },
      metadata: {
        runId: options.runId,
        unitId,
        batchId,
        artifactId: `unit-state-${unitId}`,
        producer: {
          kind: 'system',
        },
        createdAt,
      },
    });

    return {
      runStateRef,
      unitStateRef,
      routingDecisionRef,
      roleRunRequestRefs: [roleRunRequestRef],
      plannerPackageRef,
      batchScheduleRef,
      acceptanceContractRef,
      unitId,
      batchId,
    };
  }

  private async selectVerificationCommand(
    repoRoot: string,
    selectedProjectContext: Record<string, unknown>,
  ): Promise<string> {
    const commandsRef = extractCommandsRef(selectedProjectContext);
    if (!commandsRef) {
      return 'npm test';
    }

    try {
      const commandIndex = extractArtifactPayload(
        await readJsonArtifact(repoRoot, commandsRef),
      );
      const commands = Array.isArray(commandIndex.commands)
        ? (commandIndex.commands as readonly Record<string, unknown>[])
        : [];
      const testCommand = commands.find(
        (
          command,
        ): command is Record<string, unknown> & {
          readonly kind: 'test';
          readonly command: string;
        } =>
          command.kind === 'test' && typeof command.command === 'string',
      );
      if (testCommand?.command) {
        return testCommand.command;
      }
    } catch {
      return 'npm test';
    }

    return 'npm test';
  }
}

function buildRouterDispatchPayload(options: {
  readonly taskText: string;
  readonly allowedPaths: readonly string[];
}): Record<string, unknown> {
  return {
    mode: 'initial',
    selected_roles: [
      {
        role: 'planner.initial',
        task: {
          goal: summarizeGoal(options.taskText),
          scope: options.allowedPaths,
          non_goals: extractListFromTask(options.taskText, [
            'non-goals',
            'non goals',
            'non goals and exclusions',
          ]),
        },
        context: {
          modules: ['planner'],
          source_paths: options.allowedPaths,
          include_artifacts: ['selected-project-context', 'task'],
          include_feedback: [],
        },
        write_permission: 'artifact_write',
      },
    ],
    execution_plan: [['planner.initial']],
    aggregation: {
      strategy: 'validate_and_merge',
      required_checks: ['schema', 'single_unit', 'acceptance_contract_completeness'],
    },
    rationale:
      'Planner can be reduced to a single planning role for MVP-0 and must emit one unit, one batch, and one contract.',
  };
}

function buildRoleRunRequestPayload(options: {
  readonly requestId: string;
  readonly taskText: string;
  readonly selectedProjectContext: Record<string, unknown>;
  readonly outputArtifact: ArtifactRef;
  readonly inputArtifacts: readonly ArtifactRef[];
  readonly allowedPaths: readonly string[];
}): Record<string, unknown> {
  return {
    request_id: options.requestId,
    role: 'planner.initial',
    task: {
      goal: summarizeGoal(options.taskText),
      scope: options.allowedPaths,
      non_goals: [],
    },
    context: options.selectedProjectContext,
    write_permission: 'artifact_write',
    input_artifacts: options.inputArtifacts,
    output_artifact: options.outputArtifact,
    required_output_schema: 'agentflow.schema.llm.planner_package.v1',
    provider_hint: 'local',
  };
}

function buildPlannerPackagePayload(options: {
  readonly taskText: string;
  readonly allowedPaths: readonly string[];
  readonly verificationCommand: string;
}): Record<string, unknown> {
  const goal = summarizeGoal(options.taskText);
  const unitId = 'auth-refresh';
  return {
    goal,
    success_definition:
      'The must criterion passes and the planner output can be handed off to generator and evaluator stages.',
    non_goals: extractListFromTask(options.taskText, [
      'non-goals',
      'non goals',
      'non goals and exclusions',
    ]),
    technical_constraints: extractListFromTask(options.taskText, [
      'constraints',
      'technical constraints',
    ]),
    units: [
      {
        ref: unitId,
        title: goal,
        goal,
        scope: {
          allowed_paths:
            options.allowedPaths.length > 0
              ? options.allowedPaths
              : ['src/**', 'tests/**'],
          forbidden_paths: ['.env', '.env.*', '.git/**', 'node_modules/**'],
        },
        dependencies: [],
        recommended_generators: ['generator.implementer'],
        recommended_evaluators: ['evaluator.contract_checker'],
        risk_level: 'medium',
        max_fix_rounds: 1,
      },
    ],
    batches: [
      {
        unit_refs: [unitId],
        parallel: false,
      },
    ],
    contracts: [
      {
        unit_ref: unitId,
        objective: goal,
        criteria: [
          {
            ref: 'criterion-single-unit',
            description:
              'The task is represented as a single execution unit with a verifiable completion command.',
            severity: 'must',
            evidence_required: ['test_result', 'diff_reference'],
            verification: [
              {
                type: 'command',
                command: options.verificationCommand,
                expected: 'passed',
              },
            ],
          },
        ],
        forbidden_changes: ['production deployment config'],
        evaluator_focus: ['backwards compatibility'],
        auto_fix_hints: [
          {
            failure_type: 'test_failure',
            role_hint: 'generator.implementer',
          },
        ],
      },
    ],
    routing_hints: {
      generator: ['generator.implementer'],
      evaluator: ['evaluator.contract_checker'],
    },
    risks: [],
  };
}

function selectedAllowedPaths(sourceSlice: Record<string, unknown>): readonly string[] {
  const files = Array.isArray(sourceSlice.files)
    ? (sourceSlice.files as readonly Record<string, unknown>[])
    : [];
  const paths = files
    .map((file) => file.path)
    .filter((pathValue): pathValue is string => typeof pathValue === 'string');
  return uniqueStrings(paths);
}

function extractCommandsRef(
  selectedProjectContext: Record<string, unknown>,
): ArtifactRef | undefined {
  const projectIndexRefs = selectedProjectContext.project_index_refs;
  if (!projectIndexRefs || typeof projectIndexRefs !== 'object') {
    return undefined;
  }

  const commands = (projectIndexRefs as Record<string, unknown>).commands;
  if (!Array.isArray(commands) || commands.length === 0) {
    return undefined;
  }

  const first = commands[0];
  if (!first || typeof first !== 'object') {
    return undefined;
  }

  const ref = (first as Record<string, unknown>).ref;
  return typeof ref === 'string' ? (ref as ArtifactRef) : undefined;
}

function summarizeGoal(taskText: string): string {
  const lines = taskText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const firstContentLine =
    lines.find((line) => !/^#{1,6}\s+/.test(line)) ?? 'Implement the requested change.';
  return stripMarkdownPrefix(firstContentLine);
}

function extractListFromTask(
  taskText: string,
  sectionNames: readonly string[],
): string[] {
  const normalizedTargets = new Set(sectionNames.map(normalizeSectionName));
  const lines = taskText.split('\n');
  const results: string[] = [];
  let active = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const heading = headingName(line);
    if (heading) {
      active = normalizedTargets.has(normalizeSectionName(heading));
      continue;
    }

    if (!active || line.length === 0) {
      continue;
    }

    const item = stripBullet(line);
    if (item.length > 0) {
      results.push(item);
    }
  }

  return uniqueStrings(results);
}

function headingName(line: string): string | null {
  const headingMatch = /^#{1,6}\s*(.+)$/.exec(line);
  if (headingMatch?.[1]) {
    return headingMatch[1];
  }

  const colonMatch = /^(.+?):\s*$/.exec(line);
  if (colonMatch?.[1]) {
    return colonMatch[1];
  }

  return null;
}

function normalizeSectionName(value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, ' ').trim();
}

function stripMarkdownPrefix(value: string): string {
  return value.replace(/^#+\s*/, '').replace(/^[*-]\s*/, '').trim();
}

function stripBullet(value: string): string {
  return value.replace(/^[*-]\s*/, '').trim();
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

async function readJsonArtifact(
  repoRoot: string,
  ref: ArtifactRef,
): Promise<Record<string, unknown>> {
  return parseJsonObject(await readFile(resolveArtifactRef(repoRoot, ref), 'utf8'));
}

function extractArtifactPayload(
  artifact: Record<string, unknown>,
): Record<string, unknown> {
  const payload = artifact.payload;
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : artifact;
}
