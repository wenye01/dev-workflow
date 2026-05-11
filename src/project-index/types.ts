import type { ArtifactRef, GitSha } from '../core/types.js';

export const PROJECT_INDEX_BUILDER_NAME = 'agentflow';
export const PROJECT_INDEX_BUILDER_VERSION = '0.0.0';

export const PROJECT_INDEX_SCHEMA_VERSIONS = {
  manifest: 'agentflow.project_index.manifest.v1',
  overview: 'agentflow.project_index.overview.v1',
  repo_tree: 'agentflow.project_index.repo_tree.v1',
  commands: 'agentflow.project_index.commands.v1',
  module: 'agentflow.project_index.module.v1',
  document_index: 'agentflow.project_index.document_index.v1',
  document_summary: 'agentflow.project_index.document_summary.v1',
  build_report: 'agentflow.project_index.build_report.v1',
} as const;

export type ProjectIndexArtifactKind =
  | 'manifest'
  | 'overview'
  | 'repo_tree'
  | 'commands'
  | 'module'
  | 'document_index'
  | 'document_summary'
  | 'build_report';

export type CommandKind =
  | 'test'
  | 'lint'
  | 'typecheck'
  | 'build'
  | 'e2e'
  | 'custom';

export type RequiredCommandKind = 'test' | 'lint' | 'typecheck' | 'build';

export type SkipReason =
  | 'gitignored'
  | 'dependency'
  | 'binary'
  | 'large_file'
  | 'log_file'
  | 'sensitive_path'
  | 'unreadable'
  | 'unsupported';

export interface SkipEntry {
  readonly path: string;
  readonly reason: SkipReason;
  readonly detail?: string;
}

export interface FileFingerprint {
  readonly path: string;
  readonly mtime: string;
  readonly size_bytes: number;
  readonly content_sha256: string;
}

export interface TreeEntry {
  readonly path: string;
  readonly kind: 'file' | 'directory' | 'symlink' | 'unknown';
  readonly size_bytes: number;
  readonly mtime?: string;
  readonly content_sha256?: string;
  readonly language?: string;
}

export interface ScannedFile extends FileFingerprint {
  readonly absolute_path: string;
  readonly language?: string;
}

export interface RepositoryScan {
  readonly entries: readonly TreeEntry[];
  readonly files: readonly ScannedFile[];
  readonly skipped: readonly SkipEntry[];
}

export interface CommandEntry {
  readonly id: string;
  readonly kind: CommandKind;
  readonly command: string;
  readonly source: string;
  readonly confidence: 'high' | 'medium' | 'low';
  readonly scope?: readonly string[];
}

export interface MissingCommand {
  readonly kind: RequiredCommandKind;
  readonly reason: string;
}

export interface ModuleIndex {
  readonly schema_version: typeof PROJECT_INDEX_SCHEMA_VERSIONS.module;
  readonly module_id: string;
  readonly name: string;
  readonly summary: string;
  readonly boundaries: {
    readonly paths: readonly string[];
  };
  readonly entrypoints: readonly string[];
  readonly test_files: readonly string[];
  readonly dependencies: readonly ModuleDependency[];
  readonly related_commands: readonly string[];
}

export interface ModuleDependency {
  readonly kind: 'module' | 'package' | 'runtime' | 'unknown';
  readonly target: string;
  readonly summary: string;
}

export interface DocumentSection {
  readonly title: string;
  readonly anchor?: string;
  readonly line_start?: number;
  readonly line_end?: number;
}

export type DocumentKind =
  | 'readme'
  | 'design'
  | 'api'
  | 'config'
  | 'runbook'
  | 'changelog'
  | 'other';

export interface DocumentSummary {
  readonly schema_version: typeof PROJECT_INDEX_SCHEMA_VERSIONS.document_summary;
  readonly doc_id: string;
  readonly path: string;
  readonly title: string;
  readonly kind: DocumentKind;
  readonly content_sha256: string;
  readonly mtime: string;
  readonly summary: string;
  readonly sections: readonly DocumentSection[];
  readonly anchors: readonly string[];
  readonly source: {
    readonly path: string;
    readonly content_sha256: string;
  };
}

export interface DocumentIndexEntry {
  readonly doc_id: string;
  readonly path: string;
  readonly title: string;
  readonly kind: DocumentKind;
  readonly content_sha256: string;
  readonly mtime: string;
  readonly sections: readonly DocumentSection[];
  readonly summary_ref: ArtifactRef;
  readonly related_modules: readonly string[];
}

export interface DocumentIndex {
  readonly schema_version: typeof PROJECT_INDEX_SCHEMA_VERSIONS.document_index;
  readonly repo: string;
  readonly generated_at: string;
  readonly documents: readonly DocumentIndexEntry[];
}

export interface ProjectIndexArtifactManifestEntry {
  readonly name: string;
  readonly kind: ProjectIndexArtifactKind;
  readonly ref: ArtifactRef;
  readonly schema_id: string;
  readonly content_sha256: string;
  readonly size_bytes: number;
}

export interface ProjectIndexManifest {
  readonly schema_version: typeof PROJECT_INDEX_SCHEMA_VERSIONS.manifest;
  readonly index_id: string;
  readonly repo: {
    readonly root: string;
    readonly remote?: string;
    readonly base_ref?: string;
  };
  readonly head: {
    readonly sha: GitSha;
    readonly ref?: string;
  };
  readonly config_hash: string | null;
  readonly generated_at: string;
  readonly builder: {
    readonly name: typeof PROJECT_INDEX_BUILDER_NAME;
    readonly version: typeof PROJECT_INDEX_BUILDER_VERSION;
  };
  readonly schema_versions: Readonly<Record<ProjectIndexArtifactKind, string>>;
  readonly artifacts: readonly ProjectIndexArtifactManifestEntry[];
}

export interface ProjectIndexBuildResult {
  readonly status: 'built' | 'reused';
  readonly repoRoot: string;
  readonly outDir: string;
  readonly manifestPath: string;
  readonly manifestRef: ArtifactRef;
  readonly manifest: ProjectIndexManifest;
}
