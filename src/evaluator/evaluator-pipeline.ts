import { createHash } from 'node:crypto';
import { exec, execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  AdapterManager,
  AdapterSelectionError,
} from '../adapters/adapter-manager.js';
import { ArtifactStore } from '../artifacts/artifact-store.js';
import {
  artifactPath,
  resolveArtifactRef,
  unitDecisionPath,
  unitEvaluationInputPath,
  unitEvaluatorReportPath,
  unitRolePath,
  unitStatePath,
} from '../artifacts/paths.js';
import { loadAgentflowConfig } from '../config/config-loader.js';
import {
  DecisionEngine,
  type DecisionEngineResult,
} from '../core/decision-engine.js';
import type { ArtifactRef, CommitRef } from '../core/types.js';
import type { ContextBuilderResult } from '../context/context-builder.js';
import type { GeneratorPipelineResult } from '../generator/generator-pipeline.js';
import type { PlannerPipelineResult } from '../planner/planner-pipeline.js';
import {
  DEFAULT_MAX_EVALUATOR_RETRIES,
  DEFAULT_MAX_FIX_ROUNDS,
  normalizeBudget,
} from '../core/budgets.js';
import { SchemaRegistry } from '../schemas/registry.js';
import {
  isRecord,
  parseJsonObject,
  SchemaValidationError,
} from '../schemas/validator.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export interface EvaluatorPipelineOptions {
  readonly repoRoot: string;
  readonly runId: string;
  readonly configPath?: string;
  readonly context: ContextBuilderResult;
  readonly planner: PlannerPipelineResult;
  readonly generator: GeneratorPipelineResult;
  readonly attempt?: number;
  readonly maxEvaluatorRetries?: number;
  readonly fixRound?: number;
  readonly maxFixRounds?: number;
  readonly onCliProcessStarted?: () => void;
  readonly onSchemaFailure?: () => void;
}

export interface EvaluatorPipelineResult {
  readonly evaluationInputRef: ArtifactRef;
  readonly routingDecisionRef: ArtifactRef;
  readonly roleRunRequestRef: ArtifactRef;
  readonly roleInputRef: ArtifactRef;
  readonly roleOutputRef: ArtifactRef;
  readonly evaluatorReportRef: ArtifactRef;
  readonly unitDecisionRef: ArtifactRef;
  readonly unitStateRef: ArtifactRef;
  readonly unitDecision: DecisionEngineResult;
  readonly decision: 'pass' | 'fix' | 're_evaluate' | 'stop';
  readonly verificationResults: readonly Record<string, unknown>[];
  readonly failures: readonly Record<string, unknown>[];
}

export class EvaluatorPipelineError extends Error {
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
    this.name = 'EvaluatorPipelineError';
    this.code = options.code;
    this.classification = options.classification ?? 'evaluator_pipeline_failed';
    this.details = options.details;
    this.cause = options.cause;
  }
}

export class EvaluatorPipeline {
  constructor(
    private readonly registry = SchemaRegistry.load(),
    private readonly decisionEngine = new DecisionEngine(),
  ) {}

  async build(
    options: EvaluatorPipelineOptions,
  ): Promise<EvaluatorPipelineResult> {
    const unitId = options.planner.unitId;
    const attempt = options.attempt ?? 0;
    const maxEvaluatorRetries = normalizeBudget(
      options.maxEvaluatorRetries,
      DEFAULT_MAX_EVALUATOR_RETRIES,
    );
    const fixRound =
      options.fixRound ?? (options.generator.mode === 'fix' ? 1 : 0);
    const maxFixRounds = normalizeBudget(
      options.maxFixRounds,
      DEFAULT_MAX_FIX_ROUNDS,
    );
    const selectedProjectContext = await readContextPayload(
      options.repoRoot,
      options.context.outputs.selectedProjectContext,
    );
    const acceptanceContract = extractArtifactPayload(
      await readJsonArtifact(
        options.repoRoot,
        options.planner.acceptanceContractRef,
      ),
    );
    const changePackage = extractArtifactPayload(
      await readJsonArtifact(
        options.repoRoot,
        options.generator.changePackageRef,
      ),
    );
    const verificationResults = await runVerificationCommands(
      options.repoRoot,
      acceptanceContract,
    );
    const diffSummary = await gitDiffSummary(
      options.repoRoot,
      options.generator.commitRef,
    );
    const changedFiles = arrayOrDefault(changePackage.changed_files, []);
    const fileSnapshots = await readFileSnapshots(
      options.repoRoot,
      changedFilePaths(changePackage),
    );

    const evaluationInputRef = unitEvaluationInputPath(unitId, attempt);
    const routingDecisionRef = artifactPath(
      'units',
      unitId,
      `evaluator-routing.${attempt}.json`,
    );
    const roleRunRequestRef = artifactPath(
      'units',
      unitId,
      `evaluator-request.${attempt}.json`,
    );
    const roleInputRef = unitRolePath(
      unitId,
      `evaluator-input.${attempt}.json`,
    );
    const rawRoleOutputRef = unitRolePath(
      unitId,
      `evaluator-output.raw.${attempt}.json`,
    );
    const roleOutputRef = unitRolePath(
      unitId,
      `evaluator-output.${attempt}.json`,
    );
    const evaluatorReportRef = unitEvaluatorReportPath(unitId, attempt);
    const unitDecisionRef = unitDecisionPath(unitId, attempt);
    const unitStateRef = unitStatePath(unitId);
    const store = new ArtifactStore(options.repoRoot, this.registry);

    await store.writeProgramArtifact({
      artifactType: 'evaluation_input',
      ref: evaluationInputRef,
      payload: {
        acceptance_contract: acceptanceContract,
        change_package: changePackage,
        context: selectedProjectContext,
        changed_files: changedFiles,
        file_snapshots: fileSnapshots,
        diff_summary: diffSummary,
        commit_refs: options.generator.commitRef
          ? [options.generator.commitRef]
          : [],
        verification_results: verificationResults,
        risk_focus: arrayOrDefault(changePackage.recommended_evaluator_focus, [
          'acceptance contract',
          'diff correctness',
        ]),
      },
      metadata: evaluatorMetadata(options, unitId, attempt, {
        artifactId: `evaluation-input-${unitId}-${attempt}`,
        role: 'evaluator.router',
        inputArtifacts: [
          options.generator.changePackageRef,
          options.planner.acceptanceContractRef,
          options.context.outputs.selectedProjectContext,
        ],
        commitRefs: options.generator.commitRef
          ? [options.generator.commitRef]
          : [],
      }),
      renderMarkdown: true,
    });

    await store.writeFromPayload({
      payloadType: 'router_dispatch',
      artifactType: 'routing_decision',
      ref: routingDecisionRef,
      payload: buildEvaluatorRoutePayload(changePackage),
      metadata: evaluatorMetadata(options, unitId, attempt, {
        artifactId: `evaluator-routing-${unitId}-${attempt}`,
        role: 'evaluator.router',
        inputArtifacts: [evaluationInputRef],
      }),
      renderMarkdown: true,
    });

    const roleRunRequestPayload = {
      request_id: `${options.runId}-${unitId}-evaluator-${attempt}`,
      role: 'evaluator.contract_checker',
      task: {
        goal:
          stringField(acceptanceContract, 'objective') ??
          'Evaluate unit changes.',
        scope: changedFilePaths(changePackage),
        non_goals: ['Do not modify repository files.'],
      },
      context: selectedProjectContext,
      write_permission: 'artifact_write',
      input_artifacts: [evaluationInputRef, roleInputRef],
      output_artifact: rawRoleOutputRef,
      required_output_schema: 'agentflow.schema.llm.role_output.v1',
      provider_hint: 'local',
    };
    await store.writeProgramArtifact({
      artifactType: 'role_run_request',
      ref: roleRunRequestRef,
      payload: roleRunRequestPayload,
      metadata: evaluatorMetadata(options, unitId, attempt, {
        artifactId: `evaluator-role-request-${unitId}-${attempt}`,
        role: 'evaluator.router',
        inputArtifacts: [evaluationInputRef],
      }),
      renderMarkdown: true,
    });

    await store.writeProgramArtifact({
      artifactType: 'role_input',
      ref: roleInputRef,
      payload: {
        role: 'evaluator.contract_checker',
        task: roleRunRequestPayload.task,
        acceptance_contract: acceptanceContract,
        context: selectedProjectContext,
        constraints: {
          write_permission: 'artifact_write',
          allowed_paths: ['.agentflow/**'],
          forbidden_paths: ['.git/**', 'node_modules/**', '.env', '.env.*'],
          forbidden_actions: ['push', 'merge', 'deploy', 'reset-hard'],
        },
        required_output_schema: 'agentflow.schema.llm.role_output.v1',
      },
      metadata: evaluatorMetadata(options, unitId, attempt, {
        artifactId: `evaluator-role-input-${unitId}-${attempt}`,
        role: 'evaluator.router',
        inputArtifacts: [evaluationInputRef, roleRunRequestRef],
      }),
      renderMarkdown: true,
    });

    const agentResult = await this.runEvaluatorRole({
      ...options,
      attempt,
      outputArtifact: rawRoleOutputRef,
      inputArtifacts: [evaluationInputRef, roleInputRef],
    });
    if (agentResult.status !== 'completed' || !agentResult.outputArtifact) {
      throw new EvaluatorPipelineError({
        code: 'AGENTFLOW_EVALUATOR_ROLE_FAILED',
        message:
          agentResult.error?.message ?? 'Evaluator role did not complete.',
        classification: 'evaluator_role_failed',
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
      metadata: evaluatorMetadata(options, unitId, attempt, {
        artifactId: `evaluator-role-output-${unitId}-${attempt}`,
        role: 'evaluator.contract_checker',
        provider: agentResult.provider,
        model: agentResult.model,
        inputArtifacts: [evaluationInputRef, roleInputRef, roleRunRequestRef],
      }),
      renderMarkdown: true,
    });

    const evaluatorReportPayload = buildEvaluatorReportPayload({
      acceptanceContract,
      changePackage,
      verificationResults,
      roleOutputPayload,
      commitRefs: options.generator.commitRef
        ? [options.generator.commitRef]
        : [],
    });
    await store.writeFromPayload({
      payloadType: 'evaluator_report',
      artifactType: 'evaluator_report',
      ref: evaluatorReportRef,
      payload: evaluatorReportPayload,
      metadata: evaluatorMetadata(options, unitId, attempt, {
        artifactId: `evaluator-report-${unitId}-${attempt}`,
        role: 'evaluator.router',
        inputArtifacts: [evaluationInputRef, roleOutputRef],
        commitRefs: options.generator.commitRef
          ? [options.generator.commitRef]
          : [],
      }),
      renderMarkdown: true,
    });

    const decision = this.decisionEngine.decide({
      evaluatorReportRef,
      evaluatorReport: evaluatorReportPayload,
      fixRound,
      maxFixRounds,
      evaluatorAttempt: attempt,
      maxEvaluatorRetries,
    });
    await store.writeProgramArtifact({
      artifactType: 'unit_decision',
      ref: unitDecisionRef,
      payload: decision,
      metadata: evaluatorMetadata(options, unitId, attempt, {
        artifactId: `unit-decision-${unitId}-${attempt}`,
        role: 'decision.engine',
        inputArtifacts: [evaluatorReportRef],
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
        status: unitStatusForDecision(decision.decision),
        attempt,
        fix_round: fixRound,
        dependencies: [],
        artifacts: {
          evaluation_input: evaluationInputRef,
          evaluator_routing_decision: routingDecisionRef,
          evaluator_role_run_request: roleRunRequestRef,
          evaluator_role_input: roleInputRef,
          evaluator_role_output: roleOutputRef,
          evaluator_report: evaluatorReportRef,
          unit_decision: unitDecisionRef,
          change_package: options.generator.changePackageRef,
          acceptance_contract: options.planner.acceptanceContractRef,
        },
        commits: options.generator.commitRef
          ? [options.generator.commitRef]
          : [],
        pending_transition: null,
        locks: {
          file_scope: changedFilePaths(changePackage),
        },
        updated_at: new Date().toISOString(),
      },
      metadata: evaluatorMetadata(options, unitId, attempt, {
        artifactId: `unit-state-${unitId}`,
        role: 'decision.engine',
        inputArtifacts: [unitDecisionRef],
      }),
    });

    return {
      evaluationInputRef,
      routingDecisionRef,
      roleRunRequestRef,
      roleInputRef,
      roleOutputRef,
      evaluatorReportRef,
      unitDecisionRef,
      unitStateRef,
      unitDecision: decision,
      decision: decision.decision,
      verificationResults,
      failures: Array.isArray(evaluatorReportPayload.failures)
        ? evaluatorReportPayload.failures.filter(isRecord)
        : [],
    };
  }

  private async runEvaluatorRole(options: {
    readonly repoRoot: string;
    readonly runId: string;
    readonly configPath?: string;
    readonly attempt: number;
    readonly outputArtifact: ArtifactRef;
    readonly inputArtifacts: readonly ArtifactRef[];
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
        requestId: `${options.runId}-evaluator-${options.attempt}`,
        role: 'evaluator.contract_checker',
        cwd: options.repoRoot,
        prompt: evaluatorPrompt(options.attempt),
        outputArtifact: options.outputArtifact,
        inputArtifacts: options.inputArtifacts,
        requireSchemaOutput: true,
      });
    } catch (error) {
      if (error instanceof AdapterSelectionError) {
        throw new EvaluatorPipelineError({
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

function buildEvaluatorRoutePayload(
  changePackage: Record<string, unknown>,
): Record<string, unknown> {
  return {
    mode: 'initial',
    selected_roles: [
      {
        role: 'evaluator.contract_checker',
        task: {
          goal: 'Evaluate the Change Package against the Acceptance Contract.',
          scope: changedFilePaths(changePackage),
          non_goals: ['Do not modify repository files.'],
        },
        context: {
          modules: ['evaluator'],
          source_paths: changedFilePaths(changePackage),
          include_artifacts: ['evaluation-input', 'change-package'],
          include_feedback: [],
        },
        write_permission: 'artifact_write',
      },
    ],
    execution_plan: [['evaluator.contract_checker']],
    aggregation: {
      strategy: 'evaluator_report_from_contract_verification_and_role_output',
      required_checks: ['schema', 'must_criteria', 'evidence_sufficiency'],
    },
    rationale:
      'MVP-0 evaluates one unit through one readonly evaluator role and structured aggregation.',
  };
}

function buildEvaluatorReportPayload(options: {
  readonly acceptanceContract: Record<string, unknown>;
  readonly changePackage: Record<string, unknown>;
  readonly verificationResults: readonly Record<string, unknown>[];
  readonly roleOutputPayload: Record<string, unknown>;
  readonly commitRefs: readonly CommitRef[];
}): Record<string, unknown> {
  const criteria = Array.isArray(options.acceptanceContract.criteria)
    ? options.acceptanceContract.criteria.filter(isRecord)
    : [];
  const unsafe = options.roleOutputPayload.status === 'unsafe';
  const contractGap = criteria.length === 0;
  const commandFailed = options.verificationResults.some(
    (result) => result.status === 'failed',
  );
  const commandBlocked = options.verificationResults.some((result) =>
    ['blocked', 'timed_out'].includes(String(result.status)),
  );
  const evidence = buildEvidence(
    options.verificationResults,
    options.commitRefs,
  );
  const evidenceRefs = evidence
    .map((item) => item.ref)
    .filter((ref): ref is string => typeof ref === 'string');

  if (unsafe) {
    return reportPayload({
      overall: 'unsafe',
      summary: 'Evaluator found unsafe role output.',
      criteria,
      criterionStatus: 'fail',
      evidenceRefs,
      evidence,
      failures: [
        failure('failure-unsafe', firstCriterionRef(criteria), 'unsafe', false),
      ],
      unsafeFindings: ['Evaluator role reported unsafe output.'],
    });
  }

  if (contractGap) {
    return reportPayload({
      overall: 'fail',
      summary: 'Acceptance Contract has no criteria to evaluate.',
      criteria,
      criterionStatus: 'not_evaluable',
      evidenceRefs,
      evidence,
      planGaps: ['Acceptance Contract has no criteria.'],
      failures: [
        failure(
          'failure-contract-gap',
          'criterion-missing',
          'contract_gap',
          false,
        ),
      ],
    });
  }

  if (commandBlocked) {
    return reportPayload({
      overall: 'fail',
      summary: 'Verification command could not run to completion.',
      criteria,
      criterionStatus: 'not_evaluable',
      evidenceRefs,
      evidence,
      environmentIssues: ['Verification command was blocked or timed out.'],
      failures: [
        failure(
          'failure-environment',
          firstCriterionRef(criteria),
          'environment_failure',
          false,
        ),
      ],
    });
  }

  if (commandFailed) {
    return reportPayload({
      overall: 'fail',
      summary: 'One or more Acceptance Contract verification commands failed.',
      criteria,
      criterionStatus: 'fail',
      evidenceRefs,
      evidence,
      failures: [
        failure(
          'failure-tests',
          firstCriterionRef(criteria),
          'test_failure',
          true,
        ),
      ],
    });
  }

  return reportPayload({
    overall: 'pass',
    summary: 'Acceptance Contract verification passed for all must criteria.',
    criteria,
    criterionStatus: 'pass',
    evidenceRefs,
    evidence,
    failures: [],
  });
}

function reportPayload(options: {
  readonly overall: 'pass' | 'pass_with_risk' | 'fail' | 'unsafe';
  readonly summary: string;
  readonly criteria: readonly Record<string, unknown>[];
  readonly criterionStatus: 'pass' | 'fail' | 'not_evaluable' | 'not_checked';
  readonly evidenceRefs: readonly string[];
  readonly evidence: readonly Record<string, unknown>[];
  readonly failures: readonly Record<string, unknown>[];
  readonly planGaps?: readonly unknown[];
  readonly environmentIssues?: readonly unknown[];
  readonly unsafeFindings?: readonly unknown[];
}): Record<string, unknown> {
  const pass =
    options.overall === 'pass' || options.overall === 'pass_with_risk';
  return {
    overall: options.overall,
    summary: options.summary,
    contract_completeness: {
      status:
        options.planGaps && options.planGaps.length > 0
          ? 'incomplete'
          : 'complete',
      missing:
        options.planGaps && options.planGaps.length > 0 ? ['criteria'] : [],
    },
    evidence_sufficiency: pass ? 'sufficient_for_pass' : 'sufficient_for_fail',
    criteria_results: options.criteria.map((criterion) => ({
      criterion: String(criterion.ref ?? 'criterion-generated'),
      status: options.criterionStatus,
      severity: criterion.severity === 'must' ? 'must' : 'should',
      evidence: options.evidenceRefs,
      reason: options.summary,
    })),
    evidence: options.evidence,
    failures: options.failures,
    plan_gaps: options.planGaps ?? [],
    environment_issues: options.environmentIssues ?? [],
    unsafe_findings: options.unsafeFindings ?? [],
    allow_unit_complete: pass,
    allow_batch_continue: pass,
    eligible_next_actions: pass ? ['pass'] : ['fix', 'stop'],
    blocked_next_actions: pass
      ? []
      : [
          {
            action: 'pass',
            reason: 'Evaluator report did not pass all must criteria.',
          },
        ],
    residual_risks: [],
  };
}

function failure(
  ref: string,
  criterion: string,
  classification:
    | 'implementation_failure'
    | 'test_failure'
    | 'environment_failure'
    | 'contract_gap'
    | 'unsafe'
    | 'insufficient_evidence',
  autoFixable: boolean,
): Record<string, unknown> {
  return {
    ref,
    criterion,
    description: `Evaluator classified this failure as ${classification}.`,
    classification,
    severity: 'must',
    auto_fixable: autoFixable,
    evidence: [],
  };
}

function buildEvidence(
  verificationResults: readonly Record<string, unknown>[],
  commitRefs: readonly CommitRef[] = [],
): readonly Record<string, unknown>[] {
  const results = verificationResults.map((result, index) => ({
    ref: `ev-verification-${index + 1}`,
    type:
      result.kind === 'lint'
        ? 'lint_result'
        : result.kind === 'typecheck'
          ? 'typecheck_result'
          : result.kind === 'build'
            ? 'build_result'
            : 'test_result',
    summary: String(result.summary ?? result.command ?? 'Verification result.'),
    supports: ['criterion-single-unit'],
    confidence: result.status === 'passed' ? 'high' : 'medium',
  }));
  const commits = commitRefs.map((commit, index) => ({
    ref: `ev-commit-${index + 1}`,
    type: 'commit_reference',
    summary: commit.subject ?? commit.sha,
    supports: ['criterion-single-unit'],
    confidence: 'high',
  }));
  return [...results, ...commits];
}

async function runVerificationCommands(
  repoRoot: string,
  acceptanceContract: Record<string, unknown>,
): Promise<readonly Record<string, unknown>[]> {
  const commands = verificationCommands(acceptanceContract);
  if (commands.length === 0) {
    return [
      {
        command: 'not run',
        kind: 'custom',
        status: 'not_run',
        summary: 'Acceptance Contract did not define verification commands.',
      },
    ];
  }

  const results: Record<string, unknown>[] = [];
  for (const command of commands) {
    results.push(await runCommand(repoRoot, command));
  }
  return results;
}

async function runCommand(
  repoRoot: string,
  command: { readonly command: string; readonly kind: string },
): Promise<Record<string, unknown>> {
  try {
    const { stdout, stderr } = await execAsync(command.command, {
      cwd: repoRoot,
      timeout: 60_000,
      maxBuffer: 1_000_000,
    });
    return {
      command: command.command,
      kind: normalizeVerificationKind(command.kind, command.command),
      status: 'passed',
      summary: `Command passed: ${command.command}`,
      relevant_output: truncateOutput(`${stdout}\n${stderr}`),
    };
  } catch (error) {
    const failed = error as {
      readonly code?: number | string;
      readonly signal?: string;
      readonly stdout?: string;
      readonly stderr?: string;
      readonly killed?: boolean;
    };
    return {
      command: command.command,
      kind: normalizeVerificationKind(command.kind, command.command),
      status:
        failed.killed || failed.signal === 'SIGTERM' ? 'timed_out' : 'failed',
      summary: `Command failed: ${command.command}`,
      relevant_output: truncateOutput(
        `${failed.stdout ?? ''}\n${failed.stderr ?? ''}`,
      ),
    };
  }
}

function verificationCommands(
  acceptanceContract: Record<string, unknown>,
): readonly { readonly command: string; readonly kind: string }[] {
  const criteria = Array.isArray(acceptanceContract.criteria)
    ? acceptanceContract.criteria.filter(isRecord)
    : [];
  const commands: { command: string; kind: string }[] = [];
  for (const criterion of criteria) {
    const verification = Array.isArray(criterion.verification)
      ? criterion.verification.filter(isRecord)
      : [];
    for (const item of verification) {
      if (item.type === 'command' && typeof item.command === 'string') {
        commands.push({
          command: item.command,
          kind: normalizeVerificationKind(String(item.type), item.command),
        });
      }
    }
  }
  return commands;
}

function normalizeVerificationKind(kind: string, command: string): string {
  if (
    ['test', 'lint', 'typecheck', 'build', 'e2e', 'security_scan'].includes(
      kind,
    )
  ) {
    return kind;
  }
  if (/\btest\b|vitest|jest|mocha/.test(command)) {
    return 'test';
  }
  if (/lint|eslint/.test(command)) {
    return 'lint';
  }
  if (/tsc|typecheck|type-check/.test(command)) {
    return 'typecheck';
  }
  if (/\bbuild\b/.test(command)) {
    return 'build';
  }
  return 'custom';
}

function evaluatorPrompt(attempt: number): string {
  return [
    `Run the evaluator role for attempt ${attempt}.`,
    'Read the evaluation input and role input artifacts.',
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
  const payload =
    isRecord(raw) && raw.artifact_type === 'role_output' ? raw.payload : raw;
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

async function readJsonArtifact(
  repoRoot: string,
  ref: ArtifactRef,
): Promise<Record<string, unknown>> {
  return parseJsonObject(
    await readFile(resolveArtifactRef(repoRoot, ref), 'utf8'),
  );
}

async function readContextPayload(
  repoRoot: string,
  ref: ArtifactRef,
): Promise<Record<string, unknown>> {
  const value = parseJsonObject(
    await readFile(resolveArtifactRef(repoRoot, ref), 'utf8'),
  );
  return extractArtifactPayload(value);
}

function extractArtifactPayload(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return isRecord(value.payload) ? value.payload : value;
}

async function gitDiffSummary(
  repoRoot: string,
  commitRef?: CommitRef,
): Promise<string> {
  if (!commitRef) {
    return 'No generator commit was recorded.';
  }
  const { stdout } = await execFileAsync(
    'git',
    ['show', '--stat', '--oneline', '--no-renames', commitRef.sha],
    { cwd: repoRoot },
  );
  return stdout.trim() || 'Generator commit has no diff summary.';
}

async function readFileSnapshots(
  repoRoot: string,
  relativePaths: readonly string[],
): Promise<readonly Record<string, unknown>[]> {
  const snapshots: Record<string, unknown>[] = [];
  for (const relativePath of relativePaths.slice(0, 12)) {
    const resolved = path.resolve(repoRoot, relativePath);
    const relative = path.relative(repoRoot, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      snapshots.push({
        path: relativePath,
        status: 'skipped',
        reason: 'Path escapes repository root.',
      });
      continue;
    }

    try {
      const content = await readFile(resolved, 'utf8');
      snapshots.push({
        path: relativePath,
        status: content.length > 24_000 ? 'skipped' : 'read',
        content_sha256: createHash('sha256').update(content).digest('hex'),
        content_excerpt:
          content.length > 24_000 ? undefined : content.slice(0, 12_000),
        reason:
          content.length > 24_000
            ? 'File exceeds evaluator snapshot excerpt budget.'
            : undefined,
      });
    } catch {
      snapshots.push({
        path: relativePath,
        status: 'missing',
        reason: 'File could not be read after generator changes.',
      });
    }
  }
  return snapshots.map((snapshot) => pruneUndefined(snapshot));
}

function evaluatorMetadata(
  options: EvaluatorPipelineOptions,
  unitId: string,
  attempt: number,
  extra: {
    readonly artifactId: string;
    readonly role: string;
    readonly provider?: string;
    readonly model?: string;
    readonly inputArtifacts?: readonly ArtifactRef[];
    readonly commitRefs?: readonly CommitRef[];
  },
) {
  return {
    runId: options.runId,
    unitId,
    batchId: options.planner.batchId,
    attempt,
    producer: {
      kind: extra.role === 'decision.engine' ? 'system' : 'router',
      module: extra.role === 'decision.engine' ? 'decision' : 'evaluator',
      role: extra.role,
      provider: extra.provider,
      model: extra.model,
    },
    artifactId: extra.artifactId,
    inputArtifacts: extra.inputArtifacts ?? [],
    commitRefs: extra.commitRefs ?? [],
  } as const;
}

function changedFilePaths(
  changePackage: Record<string, unknown>,
): readonly string[] {
  const changedFiles = Array.isArray(changePackage.changed_files)
    ? changePackage.changed_files
    : [];
  return changedFiles
    .map((file) =>
      isRecord(file) && typeof file.path === 'string' ? file.path : null,
    )
    .filter((value): value is string => Boolean(value));
}

function arrayOrDefault<T>(
  value: unknown,
  fallback: readonly T[],
): readonly T[] {
  return Array.isArray(value) ? (value as readonly T[]) : fallback;
}

function firstCriterionRef(
  criteria: readonly Record<string, unknown>[],
): string {
  const first = criteria[0]?.ref;
  return typeof first === 'string' ? first : 'criterion-single-unit';
}

function stringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const field = value[key];
  return typeof field === 'string' ? field : undefined;
}

function unitStatusForDecision(decision: string): string {
  if (decision === 'pass') {
    return 'passed';
  }
  if (decision === 'fix') {
    return 'routing_generator_fix';
  }
  if (decision === 're_evaluate') {
    return 'routing_evaluator';
  }
  return 'stopped';
}

function truncateOutput(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 4000
    ? `${trimmed.slice(0, 4000)}\n[truncated]`
    : trimmed;
}

function pruneUndefined(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  );
}
