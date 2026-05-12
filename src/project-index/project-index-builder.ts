import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ArtifactRef } from '../core/types.js';
import { loadAgentflowConfig } from '../config/config-loader.js';
import {
  PROJECT_INDEX_SCHEMA_IDS,
  SchemaRegistry,
} from '../schemas/registry.js';
import { discoverCommands } from './command-discovery.js';
import { buildDocumentIndex } from './document-indexer.js';
import { readFreshManifest } from './freshness.js';
import { resolveGitRepository } from './git.js';
import { buildModuleIndexes } from './module-indexer.js';
import { buildOverview, renderOverviewMarkdown } from './overview-builder.js';
import { scanRepository } from './repo-scanner.js';
import {
  PROJECT_INDEX_BUILDER_NAME,
  PROJECT_INDEX_BUILDER_VERSION,
  PROJECT_INDEX_SCHEMA_VERSIONS,
  type CommandEntry,
  type ProjectIndexArtifactKind,
  type ProjectIndexArtifactManifestEntry,
  type ProjectIndexBuildResult,
  type ProjectIndexManifest,
  type RepositoryScan,
} from './types.js';
import {
  fileMetadata,
  hashOptionalFile,
  joinArtifactRef,
  resolveProjectIndexOut,
  sanitizeRefId,
  sha256Buffer,
  writeJsonFile,
} from './util.js';

export interface ProjectIndexBuildOptions {
  readonly repoPath: string;
  readonly outDir?: string;
  readonly configPath?: string;
  readonly force?: boolean;
}

interface PendingArtifact {
  readonly name: string;
  readonly kind: Exclude<ProjectIndexArtifactKind, 'manifest'>;
  readonly ref: ArtifactRef;
  readonly schemaId: string;
  readonly path: string;
  readonly value: unknown;
}

export class ProjectIndexBuilder {
  private readonly registry: SchemaRegistry;

  constructor(registry = SchemaRegistry.load()) {
    this.registry = registry;
  }

  async build(
    options: ProjectIndexBuildOptions,
  ): Promise<ProjectIndexBuildResult> {
    const repoInfo = await resolveGitRepository(options.repoPath);
    const out = resolveProjectIndexOut(
      repoInfo.repoRoot,
      options.outDir ?? '.agentflow/project-index',
    );
    const configHash =
      options.configPath !== undefined
        ? await hashOptionalFile(options.configPath)
        : sha256Buffer(
            JSON.stringify(
              (await loadAgentflowConfig({ repoPath: repoInfo.repoRoot })).raw,
            ),
          );
    const scan = await scanRepository(repoInfo.repoRoot);

    if (!options.force) {
      const freshManifest = await readFreshManifest({
        outDir: out.outDir,
        headSha: repoInfo.head,
        configHash,
        scan,
        registry: this.registry,
      });

      if (freshManifest) {
        return {
          status: 'reused',
          repoRoot: repoInfo.repoRoot,
          outDir: out.outDir,
          manifestPath: path.join(out.outDir, 'manifest.json'),
          manifestRef: joinArtifactRef(out.outRef, 'manifest.json'),
          manifest: freshManifest,
        };
      }
    }

    const generatedAt = new Date().toISOString();
    const commandsResult = await discoverCommands(repoInfo.repoRoot, scan);
    const modules = await buildModuleIndexes(
      repoInfo.repoRoot,
      scan,
      commandsResult.commands,
    );
    const documentIndex = await buildDocumentIndex({
      repo: repoInfo.repoRoot,
      generatedAt,
      scan,
      modules,
      outRef: out.outRef,
    });
    const overview = await buildOverview({
      repoRoot: repoInfo.repoRoot,
      repo: repoInfo.repoRoot,
      generatedAt,
      scan,
      commands: commandsResult.commands,
      modules,
      outRef: out.outRef,
    });
    const repoTree = {
      schema_version: PROJECT_INDEX_SCHEMA_VERSIONS.repo_tree,
      repo: repoInfo.repoRoot,
      generated_at: generatedAt,
      entries: scan.entries,
      skipped: scan.skipped,
    };
    const commands = {
      schema_version: PROJECT_INDEX_SCHEMA_VERSIONS.commands,
      repo: repoInfo.repoRoot,
      generated_at: generatedAt,
      commands: commandsResult.commands,
      missing: commandsResult.missing,
    };
    const buildReport = buildBuildReport({
      repoRoot: repoInfo.repoRoot,
      generatedAt,
      head: {
        sha: repoInfo.head,
        ...(repoInfo.currentBranch ? { ref: repoInfo.currentBranch } : {}),
      },
      configHash,
      scan,
      commands: commandsResult.commands,
      missingCommands: commandsResult.missing,
      moduleCount: modules.length,
      documentCount: documentIndex.index.documents.length,
    });

    const artifacts: PendingArtifact[] = [
      {
        name: 'overview',
        kind: 'overview',
        ref: joinArtifactRef(out.outRef, 'overview.json'),
        schemaId: PROJECT_INDEX_SCHEMA_IDS.overview,
        path: path.join(out.outDir, 'overview.json'),
        value: overview,
      },
      {
        name: 'repo-tree',
        kind: 'repo_tree',
        ref: joinArtifactRef(out.outRef, 'repo-tree.json'),
        schemaId: PROJECT_INDEX_SCHEMA_IDS.repo_tree,
        path: path.join(out.outDir, 'repo-tree.json'),
        value: repoTree,
      },
      {
        name: 'commands',
        kind: 'commands',
        ref: joinArtifactRef(out.outRef, 'commands.json'),
        schemaId: PROJECT_INDEX_SCHEMA_IDS.commands,
        path: path.join(out.outDir, 'commands.json'),
        value: commands,
      },
      ...modules.map((module) => ({
        name: `module-${module.module_id}`,
        kind: 'module' as const,
        ref: joinArtifactRef(out.outRef, 'modules', `${module.module_id}.json`),
        schemaId: PROJECT_INDEX_SCHEMA_IDS.module,
        path: path.join(out.outDir, 'modules', `${module.module_id}.json`),
        value: module,
      })),
      {
        name: 'documents',
        kind: 'document_index',
        ref: joinArtifactRef(out.outRef, 'documents', 'index.json'),
        schemaId: PROJECT_INDEX_SCHEMA_IDS.document_index,
        path: path.join(out.outDir, 'documents', 'index.json'),
        value: documentIndex.index,
      },
      ...documentIndex.summaries.map((summary) => ({
        name: `document-${summary.doc_id}`,
        kind: 'document_summary' as const,
        ref: joinArtifactRef(
          out.outRef,
          'documents',
          'summaries',
          `${summary.doc_id}.json`,
        ),
        schemaId: PROJECT_INDEX_SCHEMA_IDS.document_summary,
        path: path.join(
          out.outDir,
          'documents',
          'summaries',
          `${summary.doc_id}.json`,
        ),
        value: summary,
      })),
      {
        name: 'build-report',
        kind: 'build_report',
        ref: joinArtifactRef(out.outRef, 'build-report.json'),
        schemaId: PROJECT_INDEX_SCHEMA_IDS.build_report,
        path: path.join(out.outDir, 'build-report.json'),
        value: buildReport,
      },
    ];

    for (const artifact of artifacts) {
      this.registry.assertBySchemaId(artifact.schemaId, artifact.value);
      await writeJsonFile(artifact.path, artifact.value);
    }

    await mkdir(out.outDir, { recursive: true });
    await writeFile(
      path.join(out.outDir, 'overview.md'),
      renderOverviewMarkdown(overview),
      'utf8',
    );

    const manifestEntries = await Promise.all(
      artifacts.map(async (artifact) => {
        const metadata = await fileMetadata(artifact.path);
        return {
          name: artifact.name,
          kind: artifact.kind,
          ref: artifact.ref,
          schema_id: artifact.schemaId,
          content_sha256: metadata.content_sha256,
          size_bytes: metadata.size_bytes,
        } satisfies ProjectIndexArtifactManifestEntry;
      }),
    );

    const manifest: ProjectIndexManifest = {
      schema_version: PROJECT_INDEX_SCHEMA_VERSIONS.manifest,
      index_id: sanitizeRefId(
        `project-index-${sha256Buffer(`${repoInfo.repoRoot}:${repoInfo.head}:${configHash ?? ''}`).slice(0, 16)}`,
        'project-index',
      ),
      repo: {
        root: repoInfo.repoRoot,
        ...(repoInfo.currentBranch ? { base_ref: repoInfo.currentBranch } : {}),
      },
      head: {
        sha: repoInfo.head,
        ...(repoInfo.currentBranch ? { ref: repoInfo.currentBranch } : {}),
      },
      config_hash: configHash,
      generated_at: generatedAt,
      builder: {
        name: PROJECT_INDEX_BUILDER_NAME,
        version: PROJECT_INDEX_BUILDER_VERSION,
      },
      schema_versions: PROJECT_INDEX_SCHEMA_VERSIONS,
      artifacts: manifestEntries,
    };

    this.registry.assertProjectIndex('manifest', manifest);
    const manifestPath = path.join(out.outDir, 'manifest.json');
    await writeJsonFile(manifestPath, manifest);

    return {
      status: 'built',
      repoRoot: repoInfo.repoRoot,
      outDir: out.outDir,
      manifestPath,
      manifestRef: joinArtifactRef(out.outRef, 'manifest.json'),
      manifest,
    };
  }
}

function buildBuildReport(options: {
  readonly repoRoot: string;
  readonly generatedAt: string;
  readonly head: { readonly sha: string; readonly ref?: string };
  readonly configHash: string | null;
  readonly scan: RepositoryScan;
  readonly commands: readonly CommandEntry[];
  readonly missingCommands: readonly {
    readonly kind: string;
    readonly reason: string;
  }[];
  readonly moduleCount: number;
  readonly documentCount: number;
}): Record<string, unknown> {
  const degradations = options.missingCommands.map((missing) => ({
    reason: `Missing ${missing.kind} command.`,
    impact: `${missing.kind} cannot be recommended automatically.`,
  }));
  const status =
    options.missingCommands.length > 0 || options.scan.skipped.length > 0
      ? 'degraded'
      : 'pass';

  return {
    schema_version: PROJECT_INDEX_SCHEMA_VERSIONS.build_report,
    repo: options.repoRoot,
    generated_at: options.generatedAt,
    status,
    quality: {
      indexed_files: options.scan.files.length,
      indexed_documents: options.documentCount,
      indexed_modules: options.moduleCount,
    },
    skipped_files: options.scan.skipped,
    missing_commands: options.missingCommands,
    freshness: {
      head: options.head,
      config_hash: options.configHash,
      schema_version: PROJECT_INDEX_SCHEMA_VERSIONS.manifest,
      builder_version: PROJECT_INDEX_BUILDER_VERSION,
      indexed_files: options.scan.files.map((file) => ({
        path: file.path,
        mtime: file.mtime,
        size_bytes: file.size_bytes,
        content_sha256: file.content_sha256,
      })),
    },
    degradations,
  };
}
