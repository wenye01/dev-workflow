import { execFile } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { ArtifactStore } from '../artifacts/artifact-store.js';
import {
  artifactPath,
  inputPath,
  parseArtifactRef,
  resolveArtifactRef,
} from '../artifacts/paths.js';
import type { ArtifactRef, CommitRef } from '../core/types.js';
import { asGitSha } from '../core/types.js';
import { ProjectIndexBuilder } from '../project-index/project-index-builder.js';
import {
  PROJECT_INDEX_SCHEMA_IDS,
  SchemaRegistry,
} from '../schemas/registry.js';
import { isRecord } from '../schemas/validator.js';
import {
  type DocumentIndex,
  type DocumentIndexEntry,
  type ModuleIndex,
  type ProjectIndexArtifactKind,
  type ProjectIndexArtifactManifestEntry,
  type ProjectIndexBuildResult,
  type ProjectIndexManifest,
  type TreeEntry,
} from '../project-index/types.js';
import { sha256Buffer, writeJsonFile } from '../project-index/util.js';

const execFileAsync = promisify(execFile);

const CONTEXT_SCHEMA_IDS = {
  projectIndexRef: 'agentflow.schema.context.project_index_ref.v1',
  selectedProjectContext:
    'agentflow.schema.context.selected_project_context.v1',
  worktreeStatus: 'agentflow.schema.context.worktree_status.v1',
  sourceSlice: 'agentflow.schema.context.source_slice.v1',
  degradation: 'agentflow.schema.context.degradation.v1',
  buildReport: 'agentflow.schema.context.build_report.v1',
} as const;

const SOURCE_SLICE_MAX_FILES = 8;
const SOURCE_SLICE_MAX_FILE_BYTES = 12_000;
const SOURCE_SLICE_MAX_TOTAL_BYTES = 48_000;

type ContextStatus = 'pass' | 'degraded' | 'failed';
type ProjectIndexStatus = 'built' | 'reused';
type RoleKey = 'planner' | 'generator' | 'evaluator';

export interface ContextBuilderOptions {
  readonly repoPath: string;
  readonly taskPath: string;
  readonly configPath: string;
  readonly runId?: string;
  readonly projectIndexDir?: string;
  readonly forceProjectIndex?: boolean;
}

export interface ContextBuilderResult {
  readonly status: Exclude<ContextStatus, 'failed'>;
  readonly runId: string;
  readonly repoRoot: string;
  readonly projectIndexStatus: ProjectIndexStatus;
  readonly outputs: {
    readonly task: ArtifactRef;
    readonly projectIndexRef: ArtifactRef;
    readonly worktreeStatus: ArtifactRef;
    readonly selectedProjectContext: ArtifactRef;
    readonly sourceSlices: readonly ArtifactRef[];
    readonly roleInputs: readonly ArtifactRef[];
    readonly contextBuildReport: ArtifactRef;
    readonly degradations: readonly ArtifactRef[];
  };
}

export class ContextBuilderError extends Error {
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
    this.name = 'ContextBuilderError';
    this.code = options.code;
    this.classification = options.classification ?? 'context_build_failed';
    this.details = options.details;
    this.cause = options.cause;
  }
}

interface ProjectIndexRef {
  readonly kind: ProjectIndexArtifactKind;
  readonly ref: ArtifactRef;
  readonly schema_id: string;
  readonly content_sha256: string;
}

interface ProjectIndexRefSet {
  readonly manifest: ProjectIndexRef;
  readonly overview?: ProjectIndexRef;
  readonly repo_tree?: ProjectIndexRef;
  readonly commands?: readonly ProjectIndexRef[];
  readonly modules?: readonly ProjectIndexRef[];
  readonly documents?: readonly ProjectIndexRef[];
  readonly document_summaries?: readonly ProjectIndexRef[];
  readonly build_report?: ProjectIndexRef;
}

interface DegradationDraft {
  readonly reasonCode: string;
  readonly severity: 'warning' | 'error';
  readonly message: string;
  readonly impact: string;
  readonly affectedRoles: readonly string[];
  readonly allowContinue: boolean;
  readonly relatedRefs: readonly ArtifactRef[];
}

interface WrittenDegradation extends DegradationDraft {
  readonly degradationId: string;
  readonly ref: ArtifactRef;
}

interface LoadedProjectIndex {
  readonly manifestRef: ProjectIndexRef;
  readonly overviewRef: ProjectIndexRef;
  readonly repoTreeRef: ProjectIndexRef;
  readonly commandsRef: ProjectIndexRef;
  readonly buildReportRef: ProjectIndexRef;
  readonly documentIndexRef: ProjectIndexRef;
  readonly modules: readonly {
    readonly entry: ProjectIndexArtifactManifestEntry;
    readonly ref: ProjectIndexRef;
    readonly value: ModuleIndex;
  }[];
  readonly documentIndex: DocumentIndex;
  readonly selectedDocumentSummaries: readonly ProjectIndexRef[];
  readonly missingCommands: readonly string[];
  readonly repoTreeEntries: readonly TreeEntry[];
}

interface SourceSliceSummary {
  readonly refs: readonly ArtifactRef[];
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly estimatedTokens: number;
}

export class ContextBuilder {
  private readonly registry: SchemaRegistry;
  private readonly projectIndexBuilder: ProjectIndexBuilder;

  constructor(
    registry = SchemaRegistry.load(),
    projectIndexBuilder = new ProjectIndexBuilder(registry),
  ) {
    this.registry = registry;
    this.projectIndexBuilder = projectIndexBuilder;
  }

  async build(options: ContextBuilderOptions): Promise<ContextBuilderResult> {
    const runId = options.runId ?? makeRunId();
    const generatedAt = new Date().toISOString();
    const taskText = await readRequiredText(options.taskPath, 'task file');
    const projectIndex = await this.projectIndexBuilder.build({
      repoPath: options.repoPath,
      outDir: options.projectIndexDir ?? '.agentflow/project-index',
      configPath: options.configPath,
      force: options.forceProjectIndex ?? false,
    });
    const repoRoot = projectIndex.repoRoot;
    const taskRef = inputPath('task.md');

    await writeTextArtifact(repoRoot, taskRef, taskText);

    const loadedIndex = await this.loadProjectIndex(projectIndex);
    const selectedModules = selectRelevantModules(
      taskText,
      loadedIndex.modules,
    );
    const selectedDocuments = selectRelevantDocuments(
      taskText,
      loadedIndex.documentIndex.documents,
    );
    const selectedDocumentSummaryRefs = loadedIndex.selectedDocumentSummaries
      .filter((summaryRef) =>
        selectedDocuments.some(
          (document) => document.summary_ref === summaryRef.ref,
        ),
      )
      .slice(0, 4);
    const projectIndexRefs: ProjectIndexRefSet = compactRefSet({
      manifest: loadedIndex.manifestRef,
      overview: loadedIndex.overviewRef,
      repo_tree: loadedIndex.repoTreeRef,
      commands: [loadedIndex.commandsRef],
      modules: selectedModules.map((module) => module.ref),
      documents: [loadedIndex.documentIndexRef],
      document_summaries: selectedDocumentSummaryRefs,
      build_report: loadedIndex.buildReportRef,
    });

    const degradations: DegradationDraft[] = loadedIndex.missingCommands.map(
      (kind) => ({
        reasonCode: `missing_${kind}_command`,
        severity: 'warning',
        message: `Project Index did not discover a ${kind} command.`,
        impact:
          'Downstream roles must not assume this verification command exists.',
        affectedRoles: ['planner', 'generator', 'evaluator'],
        allowContinue: true,
        relatedRefs: [
          loadedIndex.commandsRef.ref,
          loadedIndex.buildReportRef.ref,
        ],
      }),
    );

    const worktreeStatusRef = inputPath('worktree-status.json');
    const worktreeStatus = await buildWorktreeStatus(repoRoot);
    await this.writeValidatedJson(
      repoRoot,
      worktreeStatusRef,
      worktreeStatus,
      CONTEXT_SCHEMA_IDS.worktreeStatus,
    );

    const sourceSelection = selectSourcePaths({
      taskText,
      modules: selectedModules.map((module) => module.value),
      repoTreeEntries: loadedIndex.repoTreeEntries,
    });
    if (sourceSelection.selected.length === 0) {
      degradations.push({
        reasonCode: 'context_no_source_slice_files',
        severity: 'warning',
        message:
          'Context Builder could not find indexed source files relevant to the task.',
        impact:
          'Planner can continue with Project Index refs, but Generator may need to request narrower file context later.',
        affectedRoles: ['planner', 'generator', 'evaluator'],
        allowContinue: true,
        relatedRefs: [loadedIndex.repoTreeRef.ref],
      });
    }

    const sliceResult = await this.writeSourceSlices({
      repoRoot,
      selectedPaths: sourceSelection.selected,
      excludedPaths: sourceSelection.excluded,
      repoTreeEntries: loadedIndex.repoTreeEntries,
      projectIndexRefs: selectedModules.map((module) => module.ref),
      degradations,
    });

    const writtenDegradations = await this.writeDegradations(
      repoRoot,
      generatedAt,
      degradations,
    );
    const degradationRefs = writtenDegradations.map((entry) => entry.ref);
    const selectedProjectContextRef = artifactPath(
      'context',
      'selected-project-context.json',
    );
    const selectedProjectContext = compactObject({
      project_index_refs: projectIndexRefs,
      source_slices: sliceResult.refs,
      run_artifacts: await readRunArtifactRefs(repoRoot),
      feedback: [],
      worktree_status: worktreeStatusRef,
      context_degradation:
        degradationRefs.length > 0 ? degradationRefs : undefined,
    });
    await this.writeValidatedJson(
      repoRoot,
      selectedProjectContextRef,
      selectedProjectContext,
      CONTEXT_SCHEMA_IDS.selectedProjectContext,
    );

    const projectIndexRefArtifactRef = inputPath('project-index-ref.json');
    await this.writeValidatedJson(
      repoRoot,
      projectIndexRefArtifactRef,
      {
        schema_version: 'agentflow.context.project_index_ref.v1',
        generated_at: generatedAt,
        project_index: {
          status: projectIndex.status,
          index_id: projectIndex.manifest.index_id,
          index_dir: projectIndex.outDir,
          repo: projectIndex.manifest.repo,
          head: projectIndex.manifest.head,
          config_hash: projectIndex.manifest.config_hash,
        },
        project_index_refs: projectIndexRefs,
      },
      CONTEXT_SCHEMA_IDS.projectIndexRef,
    );

    const roleInputRefs = await this.writeRoleInputs({
      repoRoot,
      runId,
      task: taskSpec(taskText, taskRef),
      selectedProjectContext,
      generatorAllowedPaths: selectedGeneratorAllowedPaths(
        selectedModules.map((module) => module.value),
      ),
      selectedProjectContextRef,
      taskRef,
      projectIndexRef: projectIndexRefArtifactRef,
      worktreeStatusRef,
    });

    const contextBuildReportRef = artifactPath('context-build-report.json');
    const status = writtenDegradations.some(
      (degradation) => degradation.severity === 'error',
    )
      ? 'failed'
      : writtenDegradations.length > 0
        ? 'degraded'
        : 'pass';
    await this.writeValidatedJson(
      repoRoot,
      contextBuildReportRef,
      {
        schema_version: 'agentflow.context_build_report.v1',
        run_id: runId,
        status,
        generated_at: generatedAt,
        project_index: {
          status: projectIndex.status,
          manifest_ref: projectIndex.manifestRef,
          head: projectIndex.manifest.head,
          config_hash: projectIndex.manifest.config_hash,
        },
        quality: {
          selected_project_index_refs: countProjectIndexRefs(projectIndexRefs),
          source_slice_files: sliceResult.fileCount,
          source_slice_bytes: sliceResult.totalBytes,
          estimated_tokens: sliceResult.estimatedTokens,
          missing_required_commands: loadedIndex.missingCommands,
          degradation_count: writtenDegradations.length,
        },
        degradations: degradationRefs,
        outputs: {
          task: taskRef,
          project_index_ref: projectIndexRefArtifactRef,
          worktree_status: worktreeStatusRef,
          selected_project_context: selectedProjectContextRef,
          source_slices: sliceResult.refs,
          role_inputs: roleInputRefs,
        },
      },
      CONTEXT_SCHEMA_IDS.buildReport,
    );

    if (status === 'failed') {
      throw new ContextBuilderError({
        code: 'AGENTFLOW_CONTEXT_BUILD_FAILED',
        message: 'Context Builder produced blocking degradations.',
        details: { degradations: degradationRefs },
      });
    }

    return {
      status,
      runId,
      repoRoot,
      projectIndexStatus: projectIndex.status,
      outputs: {
        task: taskRef,
        projectIndexRef: projectIndexRefArtifactRef,
        worktreeStatus: worktreeStatusRef,
        selectedProjectContext: selectedProjectContextRef,
        sourceSlices: sliceResult.refs,
        roleInputs: roleInputRefs,
        contextBuildReport: contextBuildReportRef,
        degradations: degradationRefs,
      },
    };
  }

  private async loadProjectIndex(
    projectIndex: ProjectIndexBuildResult,
  ): Promise<LoadedProjectIndex> {
    this.registry.assertProjectIndex('manifest', projectIndex.manifest);

    const manifestMetadata = await fileMetadata(projectIndex.manifestPath);
    const manifestRef: ProjectIndexRef = {
      kind: 'manifest',
      ref: projectIndex.manifestRef,
      schema_id: PROJECT_INDEX_SCHEMA_IDS.manifest,
      content_sha256: manifestMetadata.content_sha256,
    };
    const artifactEntries = groupManifestEntries(projectIndex.manifest);
    const overviewEntry = requireManifestEntry(artifactEntries, 'overview');
    const repoTreeEntry = requireManifestEntry(artifactEntries, 'repo_tree');
    const commandsEntry = requireManifestEntry(artifactEntries, 'commands');
    const buildReportEntry = requireManifestEntry(
      artifactEntries,
      'build_report',
    );
    const documentIndexEntry = requireManifestEntry(
      artifactEntries,
      'document_index',
    );

    const [repoTree, commandsArtifact, buildReport, documentIndex] =
      await Promise.all([
        this.readManifestEntry<Record<string, unknown>>(
          projectIndex.repoRoot,
          repoTreeEntry,
        ),
        this.readManifestEntry<Record<string, unknown>>(
          projectIndex.repoRoot,
          commandsEntry,
        ),
        this.readManifestEntry<Record<string, unknown>>(
          projectIndex.repoRoot,
          buildReportEntry,
        ),
        this.readManifestEntry<DocumentIndex>(
          projectIndex.repoRoot,
          documentIndexEntry,
        ),
        this.readManifestEntry<Record<string, unknown>>(
          projectIndex.repoRoot,
          overviewEntry,
        ),
      ]);

    const moduleEntries = artifactEntries.get('module') ?? [];
    const modules = await Promise.all(
      moduleEntries.map(async (entry) => ({
        entry,
        ref: projectIndexRefFromEntry(entry),
        value: await this.readManifestEntry<ModuleIndex>(
          projectIndex.repoRoot,
          entry,
        ),
      })),
    );

    const documentSummaryEntries =
      artifactEntries.get('document_summary') ?? [];
    const documentSummaryRefs = documentSummaryEntries.map(
      projectIndexRefFromEntry,
    );

    return {
      manifestRef,
      overviewRef: projectIndexRefFromEntry(overviewEntry),
      repoTreeRef: projectIndexRefFromEntry(repoTreeEntry),
      commandsRef: projectIndexRefFromEntry(commandsEntry),
      buildReportRef: projectIndexRefFromEntry(buildReportEntry),
      documentIndexRef: projectIndexRefFromEntry(documentIndexEntry),
      modules,
      documentIndex,
      selectedDocumentSummaries: documentSummaryRefs,
      missingCommands: readMissingCommands(buildReport, commandsArtifact),
      repoTreeEntries: Array.isArray(repoTree.entries)
        ? (repoTree.entries as readonly TreeEntry[])
        : [],
    };
  }

  private async readManifestEntry<T>(
    repoRoot: string,
    entry: ProjectIndexArtifactManifestEntry,
  ): Promise<T> {
    const filePath = path.join(repoRoot, entry.ref);
    const content = await readFile(filePath);
    const actualHash = sha256Buffer(content);
    if (actualHash !== entry.content_sha256) {
      throw new ContextBuilderError({
        code: 'AGENTFLOW_PROJECT_INDEX_HASH_MISMATCH',
        message: `Project Index artifact content hash does not match manifest: ${entry.ref}`,
        details: {
          ref: entry.ref,
          expected: entry.content_sha256,
          actual: actualHash,
        },
      });
    }

    if (entry.kind === 'manifest') {
      throw new ContextBuilderError({
        code: 'AGENTFLOW_PROJECT_INDEX_INVALID_MANIFEST_ENTRY',
        message:
          'Nested manifest entries are not supported in Project Index manifests.',
      });
    }

    const parsed = JSON.parse(content.toString('utf8')) as unknown;
    this.registry.assertProjectIndex(
      projectIndexTypeForKind(entry.kind),
      parsed,
    );
    return parsed as T;
  }

  private async writeSourceSlices(options: {
    readonly repoRoot: string;
    readonly selectedPaths: readonly string[];
    readonly excludedPaths: readonly {
      readonly path: string;
      readonly reason: string;
    }[];
    readonly repoTreeEntries: readonly TreeEntry[];
    readonly projectIndexRefs: readonly ProjectIndexRef[];
    readonly degradations: DegradationDraft[];
  }): Promise<SourceSliceSummary> {
    const entryByPath = new Map(
      options.repoTreeEntries
        .filter((entry) => entry.kind === 'file')
        .map((entry) => [entry.path, entry]),
    );
    const roles: readonly RoleKey[] = ['planner', 'generator', 'evaluator'];
    const refs: ArtifactRef[] = [];
    let fileCount = 0;
    let totalBytes = 0;
    let estimatedTokens = 0;

    for (const role of roles) {
      const rolePaths = sourcePathsForRole(role, options.selectedPaths);
      const files = [];
      const excluded = [...options.excludedPaths];
      let roleBytes = 0;
      let roleTokens = 0;

      for (const selectedPath of rolePaths) {
        const entry = entryByPath.get(selectedPath);
        if (!entry?.content_sha256 || entry.size_bytes === undefined) {
          excluded.push({
            path: selectedPath,
            reason: 'Path is not present in the Project Index repo tree.',
          });
          continue;
        }

        if (files.length >= SOURCE_SLICE_MAX_FILES) {
          excluded.push({
            path: selectedPath,
            reason: `Source slice file limit ${SOURCE_SLICE_MAX_FILES} reached.`,
          });
          continue;
        }

        if (roleBytes >= SOURCE_SLICE_MAX_TOTAL_BYTES) {
          excluded.push({
            path: selectedPath,
            reason: `Source slice byte limit ${SOURCE_SLICE_MAX_TOTAL_BYTES} reached.`,
          });
          continue;
        }

        try {
          const content = await readFile(
            path.join(options.repoRoot, selectedPath),
          );
          const remainingBytes = SOURCE_SLICE_MAX_TOTAL_BYTES - roleBytes;
          const includedBytes = Math.min(
            content.byteLength,
            SOURCE_SLICE_MAX_FILE_BYTES,
            remainingBytes,
          );
          const excerpt = content.subarray(0, includedBytes).toString('utf8');
          const truncated = includedBytes < content.byteLength;
          const tokens = estimateTokens(excerpt);
          files.push(
            compactObject({
              path: selectedPath,
              language: entry.language,
              content_sha256: sha256Buffer(content),
              size_bytes: content.byteLength,
              included_bytes: Buffer.byteLength(excerpt),
              estimated_tokens: tokens,
              truncated,
              excerpt,
            }),
          );
          roleBytes += Buffer.byteLength(excerpt);
          roleTokens += tokens;

          if (truncated) {
            options.degradations.push({
              reasonCode: `source_slice_truncated_${role}`,
              severity: 'warning',
              message: `Source slice for ${role} was truncated because context limits were reached.`,
              impact:
                'Downstream roles receive a partial source excerpt and must use tool access for missing details.',
              affectedRoles: [role],
              allowContinue: true,
              relatedRefs: [],
            });
          }
        } catch (error) {
          excluded.push({
            path: selectedPath,
            reason: error instanceof Error ? error.message : String(error),
          });
          options.degradations.push({
            reasonCode: `source_slice_unreadable_${role}`,
            severity: 'warning',
            message: `Context Builder could not read source file ${selectedPath}.`,
            impact:
              'The affected role may lack relevant source context and should use artifact/tool reads before changing code.',
            affectedRoles: [role],
            allowContinue: true,
            relatedRefs: [],
          });
        }
      }

      const ref = artifactPath('index', 'source-slices', `${role}.json`);
      await this.writeValidatedJson(
        options.repoRoot,
        ref,
        {
          schema_version: 'agentflow.context.source_slice.v1',
          slice_id: `${role}-source-slice`,
          role,
          selection_basis: [
            'Task text path hints',
            'Selected module entrypoints',
            'Selected module test files',
            'Fallback indexed source files',
          ],
          project_index_refs: options.projectIndexRefs,
          files,
          excluded_files: excluded,
          total_bytes: roleBytes,
          estimated_tokens: roleTokens,
        },
        CONTEXT_SCHEMA_IDS.sourceSlice,
      );

      refs.push(ref);
      fileCount += files.length;
      totalBytes += roleBytes;
      estimatedTokens += roleTokens;
    }

    return {
      refs,
      fileCount,
      totalBytes,
      estimatedTokens,
    };
  }

  private async writeDegradations(
    repoRoot: string,
    generatedAt: string,
    degradations: readonly DegradationDraft[],
  ): Promise<readonly WrittenDegradation[]> {
    const written: WrittenDegradation[] = [];

    for (const [index, degradation] of degradations.entries()) {
      const degradationId = safeRefId(
        `${String(index + 1).padStart(3, '0')}-${degradation.reasonCode}`,
      );
      const ref = artifactPath('context-degradation', `${degradationId}.json`);
      await this.writeValidatedJson(
        repoRoot,
        ref,
        {
          schema_version: 'agentflow.context.degradation.v1',
          degradation_id: degradationId,
          generated_at: generatedAt,
          reason_code: degradation.reasonCode,
          severity: degradation.severity,
          message: degradation.message,
          impact: degradation.impact,
          affected_roles: degradation.affectedRoles,
          allow_continue: degradation.allowContinue,
          related_refs: degradation.relatedRefs,
        },
        CONTEXT_SCHEMA_IDS.degradation,
      );
      written.push({ ...degradation, degradationId, ref });
    }

    return written;
  }

  private async writeRoleInputs(options: {
    readonly repoRoot: string;
    readonly runId: string;
    readonly task: Record<string, unknown>;
    readonly selectedProjectContext: Record<string, unknown>;
    readonly generatorAllowedPaths: readonly string[];
    readonly selectedProjectContextRef: ArtifactRef;
    readonly taskRef: ArtifactRef;
    readonly projectIndexRef: ArtifactRef;
    readonly worktreeStatusRef: ArtifactRef;
  }): Promise<readonly ArtifactRef[]> {
    const store = new ArtifactStore(options.repoRoot, this.registry);
    const commonInputArtifacts = [
      options.taskRef,
      options.projectIndexRef,
      options.worktreeStatusRef,
      options.selectedProjectContextRef,
    ];
    const roleSpecs: readonly {
      readonly role: string;
      readonly module: 'planner' | 'generator' | 'evaluator';
      readonly ref: ArtifactRef;
      readonly writePermission:
        | 'readonly'
        | 'artifact_write'
        | 'worktree_write';
      readonly requiredOutputSchema: string;
    }[] = [
      {
        role: 'planner.initial',
        module: 'planner',
        ref: artifactPath('context', 'role-inputs', 'planner.json'),
        writePermission: 'artifact_write',
        requiredOutputSchema: 'agentflow.schema.llm.planner_package.v1',
      },
      {
        role: 'generator.implementer',
        module: 'generator',
        ref: artifactPath('context', 'role-inputs', 'generator.json'),
        writePermission: 'worktree_write',
        requiredOutputSchema: 'agentflow.schema.llm.role_output.v1',
      },
      {
        role: 'evaluator.reviewer',
        module: 'evaluator',
        ref: artifactPath('context', 'role-inputs', 'evaluator.json'),
        writePermission: 'artifact_write',
        requiredOutputSchema: 'agentflow.schema.llm.role_output.v1',
      },
    ];

    const refs: ArtifactRef[] = [];
    for (const spec of roleSpecs) {
      await store.writeProgramArtifact({
        artifactType: 'role_input',
        ref: spec.ref,
        payload: {
          role: spec.role,
          task: {
            ...options.task,
            phase:
              spec.module === 'planner'
                ? 'plan_single_unit'
                : spec.module === 'generator'
                  ? 'prepare_implementation'
                  : 'prepare_evaluation',
          },
          acceptance_contract: {
            objective: options.task.goal,
            criteria: [],
            source:
              'Context Builder placeholder until Planner materializes the canonical acceptance contract.',
          },
          context: options.selectedProjectContext,
          constraints: {
            write_permission: spec.writePermission,
            allowed_paths:
              spec.module === 'generator'
                ? options.generatorAllowedPaths
                : ['.agentflow/**'],
            forbidden_paths: [
              '.git/**',
              '.agentflow-worktrees/**',
              '.env',
              '.env.*',
              'node_modules/**',
            ],
            forbidden_actions: ['push', 'merge', 'deploy', 'reset-hard'],
          },
          required_output_schema: spec.requiredOutputSchema,
        },
        metadata: {
          runId: options.runId,
          producer: {
            kind: 'orchestrator',
            module: spec.module,
          },
          inputArtifacts: commonInputArtifacts,
        },
        renderMarkdown: true,
      });
      refs.push(spec.ref);
    }

    return refs;
  }

  private async writeValidatedJson(
    repoRoot: string,
    ref: ArtifactRef,
    value: unknown,
    schemaId: string,
  ): Promise<void> {
    this.registry.assertBySchemaId(schemaId, value);
    await writeJsonFile(resolveArtifactRef(repoRoot, ref), value);
  }
}

async function buildWorktreeStatus(
  repoRoot: string,
): Promise<Record<string, unknown>> {
  const [head, branch, statusRaw, diffSummary, commitRefs] = await Promise.all([
    git(repoRoot, ['rev-parse', 'HEAD']),
    git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all']),
    git(repoRoot, ['diff', '--stat']),
    gitCommitRefs(repoRoot),
  ]);
  const changedFiles = [];
  const untrackedFiles = [];

  for (const line of statusRaw.split('\n').filter(Boolean)) {
    const status = line.slice(0, 2);
    const rawPath = normalizeStatusPath(line.slice(3));
    if (isAgentflowInternalPath(rawPath)) {
      continue;
    }

    if (status === '??') {
      untrackedFiles.push(rawPath);
    } else {
      changedFiles.push({ path: rawPath, status: status.trim() || status });
    }
  }

  return {
    schema_version: 'agentflow.context.worktree_status.v1',
    repo: repoRoot,
    branch: branch.trim() === 'HEAD' ? null : branch.trim(),
    head: {
      sha: asGitSha(head.trim()),
      ...(branch.trim() !== 'HEAD' ? { ref: branch.trim() } : {}),
    },
    clean: changedFiles.length === 0 && untrackedFiles.length === 0,
    changed_files: changedFiles,
    untracked_files: untrackedFiles,
    diff_summary: diffSummary,
    commit_refs: commitRefs,
  };
}

async function gitCommitRefs(repoRoot: string): Promise<readonly CommitRef[]> {
  const raw = await git(repoRoot, [
    'log',
    '--max-count=5',
    '--format=%H%x1f%D%x1f%s%x1f%cI',
  ]);

  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, refs, subject, committedAt] = line.split('\x1f');
      return compactObject({
        sha: asGitSha(sha ?? ''),
        ref: refs || undefined,
        subject: subject || undefined,
        committedAt: committedAt || undefined,
      }) as unknown as CommitRef;
    });
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  return result.stdout;
}

async function readRequiredText(
  filePath: string,
  label: string,
): Promise<string> {
  try {
    const content = await readFile(path.resolve(filePath), 'utf8');
    if (content.trim().length === 0) {
      throw new ContextBuilderError({
        code: 'AGENTFLOW_CONTEXT_EMPTY_INPUT',
        message: `Context Builder requires a non-empty ${label}: ${filePath}`,
      });
    }
    return content;
  } catch (error) {
    if (error instanceof ContextBuilderError) {
      throw error;
    }

    throw new ContextBuilderError({
      code: 'AGENTFLOW_CONTEXT_INPUT_READ_FAILED',
      message: `Could not read ${label}: ${filePath}`,
      cause: error,
    });
  }
}

async function writeTextArtifact(
  repoRoot: string,
  ref: ArtifactRef,
  content: string,
): Promise<void> {
  const filePath = resolveArtifactRef(repoRoot, ref);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

async function fileMetadata(filePath: string): Promise<{
  readonly content_sha256: string;
  readonly size_bytes: number;
}> {
  const [content, stats] = await Promise.all([
    readFile(filePath),
    stat(filePath),
  ]);
  return {
    content_sha256: sha256Buffer(content),
    size_bytes: stats.size,
  };
}

function groupManifestEntries(
  manifest: ProjectIndexManifest,
): Map<ProjectIndexArtifactKind, ProjectIndexArtifactManifestEntry[]> {
  const entries = new Map<
    ProjectIndexArtifactKind,
    ProjectIndexArtifactManifestEntry[]
  >();
  for (const artifact of manifest.artifacts) {
    const list = entries.get(artifact.kind) ?? [];
    list.push(artifact);
    entries.set(artifact.kind, list);
  }
  return entries;
}

function requireManifestEntry(
  entries: Map<ProjectIndexArtifactKind, ProjectIndexArtifactManifestEntry[]>,
  kind: ProjectIndexArtifactKind,
): ProjectIndexArtifactManifestEntry {
  const entry = entries.get(kind)?.[0];
  if (!entry) {
    throw new ContextBuilderError({
      code: 'AGENTFLOW_PROJECT_INDEX_MISSING_ARTIFACT',
      message: `Project Index manifest is missing required ${kind} artifact.`,
    });
  }
  return entry;
}

function projectIndexRefFromEntry(
  entry: ProjectIndexArtifactManifestEntry,
): ProjectIndexRef {
  return {
    kind: entry.kind,
    ref: entry.ref,
    schema_id: entry.schema_id,
    content_sha256: entry.content_sha256,
  };
}

function projectIndexTypeForKind(
  kind: Exclude<ProjectIndexArtifactKind, 'manifest'>,
):
  | 'overview'
  | 'repo_tree'
  | 'commands'
  | 'module'
  | 'document_index'
  | 'document_summary'
  | 'build_report' {
  const mapping = {
    overview: 'overview',
    repo_tree: 'repo_tree',
    commands: 'commands',
    module: 'module',
    document_index: 'document_index',
    document_summary: 'document_summary',
    build_report: 'build_report',
  } as const;
  return mapping[kind];
}

function selectRelevantModules(
  taskText: string,
  modules: readonly {
    readonly entry: ProjectIndexArtifactManifestEntry;
    readonly ref: ProjectIndexRef;
    readonly value: ModuleIndex;
  }[],
): readonly {
  readonly entry: ProjectIndexArtifactManifestEntry;
  readonly ref: ProjectIndexRef;
  readonly value: ModuleIndex;
}[] {
  const scored = modules.map((module) => ({
    module,
    score: scoreModule(taskText, module.value),
  }));
  const positive = scored.filter((item) => item.score > 0);
  const selected = positive.length > 0 ? positive : scored;

  return selected
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map((item) => item.module);
}

function scoreModule(taskText: string, module: ModuleIndex): number {
  const normalizedTask = normalizeForSearch(taskText);
  let score = 0;
  const moduleTerms = [
    module.module_id,
    module.name,
    ...module.boundaries.paths,
    ...module.entrypoints,
    ...module.test_files,
  ];

  for (const term of moduleTerms) {
    if (term && normalizedTask.includes(normalizeForSearch(term))) {
      score += term.includes('/') ? 4 : 6;
    }
  }

  for (const token of tokenize(module.module_id)) {
    if (normalizedTask.includes(token)) {
      score += 2;
    }
  }

  return score;
}

function selectRelevantDocuments(
  taskText: string,
  documents: readonly DocumentIndexEntry[],
): readonly DocumentIndexEntry[] {
  if (documents.length === 0) {
    return [];
  }

  const scored = documents.map((document) => ({
    document,
    score: scoreDocument(taskText, document),
  }));
  const positive = scored.filter((item) => item.score > 0);
  const selected = positive.length > 0 ? positive : scored;

  return selected
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return (
        documentPriority(right.document.kind) -
        documentPriority(left.document.kind)
      );
    })
    .slice(0, 4)
    .map((item) => item.document);
}

function scoreDocument(taskText: string, document: DocumentIndexEntry): number {
  const normalizedTask = normalizeForSearch(taskText);
  let score = 0;
  for (const term of [document.path, document.title, document.kind]) {
    if (term && normalizedTask.includes(normalizeForSearch(term))) {
      score += 3;
    }
  }
  if (document.kind === 'readme' || document.kind === 'design') {
    score += 1;
  }
  return score;
}

function documentPriority(kind: string): number {
  const priorities: Readonly<Record<string, number>> = {
    readme: 4,
    design: 3,
    api: 2,
    config: 1,
  };
  return priorities[kind] ?? 0;
}

function selectSourcePaths(options: {
  readonly taskText: string;
  readonly modules: readonly ModuleIndex[];
  readonly repoTreeEntries: readonly TreeEntry[];
}): {
  readonly selected: readonly string[];
  readonly excluded: readonly {
    readonly path: string;
    readonly reason: string;
  }[];
} {
  const fileEntries = options.repoTreeEntries.filter(
    (entry) => entry.kind === 'file',
  );
  const indexedPaths = new Set(fileEntries.map((entry) => entry.path));
  const explicitPaths = extractPathHints(options.taskText);
  const candidates: string[] = [];
  const excluded: { path: string; reason: string }[] = [];

  for (const explicitPath of explicitPaths) {
    if (indexedPaths.has(explicitPath)) {
      candidates.push(explicitPath);
    } else {
      excluded.push({
        path: explicitPath,
        reason: 'Task path hint is not present in the Project Index repo tree.',
      });
    }
  }

  for (const module of options.modules) {
    candidates.push(...module.entrypoints, ...module.test_files);
    for (const boundary of module.boundaries.paths) {
      candidates.push(
        ...fileEntries
          .filter((entry) => pathMatchesBoundary(entry.path, boundary))
          .filter((entry) => isSourceLikePath(entry.path))
          .map((entry) => entry.path)
          .slice(0, 4),
      );
    }
  }

  if (candidates.length === 0) {
    candidates.push(
      ...fileEntries
        .filter((entry) => isSourceLikePath(entry.path))
        .map((entry) => entry.path)
        .slice(0, SOURCE_SLICE_MAX_FILES),
    );
  }

  return {
    selected: unique(candidates).slice(0, SOURCE_SLICE_MAX_FILES * 2),
    excluded,
  };
}

function sourcePathsForRole(
  role: RoleKey,
  selectedPaths: readonly string[],
): readonly string[] {
  if (role === 'planner') {
    return selectedPaths.slice(0, 4);
  }

  if (role === 'evaluator') {
    return [
      ...selectedPaths.filter((filePath) => isTestPath(filePath)),
      ...selectedPaths.filter((filePath) => !isTestPath(filePath)),
    ].slice(0, SOURCE_SLICE_MAX_FILES);
  }

  return selectedPaths.slice(0, SOURCE_SLICE_MAX_FILES);
}

function readMissingCommands(
  buildReport: Record<string, unknown>,
  commandsArtifact: Record<string, unknown>,
): readonly string[] {
  const reportMissing = Array.isArray(buildReport.missing_commands)
    ? buildReport.missing_commands
    : [];
  const commandsMissing = Array.isArray(commandsArtifact.missing)
    ? commandsArtifact.missing
    : [];

  return unique(
    [...reportMissing, ...commandsMissing]
      .filter(isRecord)
      .map((entry) => entry.kind)
      .filter((kind): kind is string => typeof kind === 'string'),
  ).filter((kind) => ['test', 'lint', 'typecheck', 'build'].includes(kind));
}

async function readRunArtifactRefs(
  repoRoot: string,
): Promise<readonly ArtifactRef[]> {
  const indexPath = path.join(repoRoot, '.agentflow', 'artifact-index.json');
  try {
    const parsed = JSON.parse(await readFile(indexPath, 'utf8')) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.artifacts)) {
      return [];
    }

    return parsed.artifacts
      .filter(isRecord)
      .map((entry) => entry.ref)
      .filter((ref): ref is string => typeof ref === 'string')
      .map((ref) => parseArtifactRef(ref));
  } catch {
    return [];
  }
}

function selectedGeneratorAllowedPaths(
  modules: readonly ModuleIndex[],
): readonly string[] {
  const paths = unique(
    modules.flatMap((module) => module.boundaries.paths),
  ).filter((item) => item.length > 0);

  return paths.length > 0 ? paths : ['**'];
}

function taskSpec(
  taskText: string,
  taskRef: ArtifactRef,
): Record<string, unknown> {
  return {
    goal: firstMeaningfulTaskLine(taskText),
    source_ref: taskRef,
    raw_sha256: sha256Buffer(taskText),
  };
}

function firstMeaningfulTaskLine(taskText: string): string {
  const line = taskText
    .split('\n')
    .map((item) => item.trim())
    .find((item) => item.length > 0);

  if (!line) {
    return 'Complete the requested task.';
  }

  return line.replace(/^#+\s*/, '');
}

function countProjectIndexRefs(refs: ProjectIndexRefSet): number {
  let count = 1;
  if (refs.overview) count += 1;
  if (refs.repo_tree) count += 1;
  if (refs.build_report) count += 1;
  count += refs.commands?.length ?? 0;
  count += refs.modules?.length ?? 0;
  count += refs.documents?.length ?? 0;
  count += refs.document_summaries?.length ?? 0;
  return count;
}

function compactRefSet(value: ProjectIndexRefSet): ProjectIndexRefSet {
  return compactObject(value) as unknown as ProjectIndexRefSet;
}

function compactObject<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function normalizeStatusPath(value: string): string {
  const renameMarker = ' -> ';
  const normalized = value.includes(renameMarker)
    ? value.slice(value.indexOf(renameMarker) + renameMarker.length)
    : value;

  return normalized.replace(/^"|"$/g, '');
}

function isAgentflowInternalPath(value: string): boolean {
  return (
    value === '.agentflow' ||
    value.startsWith('.agentflow/') ||
    value === '.agentflow-worktrees' ||
    value.startsWith('.agentflow-worktrees/')
  );
}

function extractPathHints(taskText: string): readonly string[] {
  const matches = taskText.matchAll(
    /(?:^|[\s`("'[])([A-Za-z0-9._/-]+\.(?:cjs|css|go|html|js|jsx|json|md|mjs|py|rs|sh|ts|tsx|yaml|yml))/g,
  );

  return unique(
    [...matches]
      .map((match) => match[1])
      .filter((value): value is string => Boolean(value))
      .map((value) => value.replace(/[),.;:'"`\]]+$/g, ''))
      .filter((value) => !value.startsWith('/'))
      .filter((value) => !value.includes('..'))
      .filter((value) => !value.includes('\\')),
  );
}

function pathMatchesBoundary(filePath: string, boundary: string): boolean {
  if (boundary === '**') {
    return true;
  }

  if (boundary.endsWith('/**')) {
    return filePath.startsWith(boundary.slice(0, -2));
  }

  return filePath === boundary;
}

function isSourceLikePath(filePath: string): boolean {
  return /\.(?:cjs|go|js|jsx|mjs|py|rs|ts|tsx)$/.test(filePath);
}

function isTestPath(filePath: string): boolean {
  return (
    filePath.startsWith('test/') ||
    filePath.startsWith('tests/') ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(filePath)
  );
}

function unique<T>(items: readonly T[]): readonly T[] {
  return [...new Set(items)];
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

function normalizeForSearch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, ' ')
    .trim();
}

function tokenize(value: string): readonly string[] {
  return normalizeForSearch(value)
    .split(/[\s/_-]+/)
    .filter(Boolean);
}

function safeRefId(value: string): string {
  const normalized = value
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/[^A-Za-z0-9]+$/, '');

  return normalized || 'context-degradation';
}

function makeRunId(): string {
  return `run-context-${new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 14)}`;
}
