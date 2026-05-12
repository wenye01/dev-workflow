import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ArtifactRef, CommitRef } from '../core/types.js';
import {
  artifactIndexPath,
  artifactPath,
  parseArtifactRef,
  resolveArtifactRef,
} from './paths.js';
import {
  emptyArtifactIndex,
  type ArtifactIndex,
  type ArtifactIndexEntry,
  type ArtifactProducer,
} from './artifact-index.js';
import { renderMarkdownView } from './markdown-renderer.js';
import {
  SchemaRegistry,
  canonicalSchemaVersion,
  type ArtifactType,
  type LlmPayloadType,
} from '../schemas/registry.js';
import { SchemaValidationError, isRecord } from '../schemas/validator.js';

export interface CanonicalArtifact {
  readonly schema_version: string;
  readonly artifact_type: ArtifactType;
  readonly artifact_id: string;
  readonly run_id: string;
  readonly batch_id?: string;
  readonly unit_id?: string;
  readonly attempt?: number;
  readonly fix_round?: number;
  readonly producer: ArtifactProducer;
  readonly input_artifacts: readonly ArtifactRef[];
  readonly created_at: string;
  readonly payload: unknown;
  readonly commit_refs: readonly CommitRef[];
}

export interface ArtifactMetadataInput {
  readonly runId: string;
  readonly artifactId?: string;
  readonly batchId?: string;
  readonly unitId?: string;
  readonly attempt?: number;
  readonly fixRound?: number;
  readonly producer: ArtifactProducer;
  readonly inputArtifacts?: readonly ArtifactRef[];
  readonly commitRefs?: readonly CommitRef[];
  readonly createdAt?: string;
}

export interface WritePayloadArtifactOptions {
  readonly payloadType: LlmPayloadType;
  readonly artifactType: ArtifactType;
  readonly ref: ArtifactRef;
  readonly payload: unknown;
  readonly metadata: ArtifactMetadataInput;
  readonly renderMarkdown?: boolean;
}

export interface WriteProgramArtifactOptions {
  readonly artifactType: ArtifactType;
  readonly ref: ArtifactRef;
  readonly payload: unknown;
  readonly metadata: ArtifactMetadataInput;
  readonly renderMarkdown?: boolean;
}

export interface WriteStateArtifactOptions {
  readonly artifactType: 'run_state' | 'unit_state';
  readonly ref: ArtifactRef;
  readonly state: Record<string, unknown>;
  readonly metadata: ArtifactMetadataInput;
}

export interface ArtifactWriteResult {
  readonly artifact: CanonicalArtifact;
  readonly ref: ArtifactRef;
  readonly markdownRef?: ArtifactRef;
  readonly index: ArtifactIndex;
}

export interface WriteStopReportForSchemaFailureOptions {
  readonly metadata: ArtifactMetadataInput;
  readonly ref?: ArtifactRef;
  readonly failedArtifactRef?: ArtifactRef;
  readonly resumeFrom?: string | null;
}

export class ArtifactStore {
  private readonly registry: SchemaRegistry;

  constructor(
    private readonly runRoot: string,
    registry = SchemaRegistry.load(),
  ) {
    this.registry = registry;
  }

  async writeFromPayload(
    options: WritePayloadArtifactOptions,
  ): Promise<ArtifactWriteResult> {
    this.registry.assertLlmPayload(options.payloadType, options.payload);

    const artifact = this.buildCanonicalArtifact(
      options.artifactType,
      options.ref,
      options.payload,
      options.metadata,
    );

    this.registry.assertCanonicalArtifact(options.artifactType, artifact);

    return await this.writeCanonicalArtifact(
      artifact,
      options.ref,
      options.renderMarkdown ?? false,
    );
  }

  async writeProgramArtifact(
    options: WriteProgramArtifactOptions,
  ): Promise<ArtifactWriteResult> {
    const artifact = this.buildCanonicalArtifact(
      options.artifactType,
      options.ref,
      options.payload,
      options.metadata,
    );

    this.registry.assertCanonicalArtifact(options.artifactType, artifact);

    return await this.writeCanonicalArtifact(
      artifact,
      options.ref,
      options.renderMarkdown ?? false,
    );
  }

  async writeStateArtifact(
    options: WriteStateArtifactOptions,
  ): Promise<{
    readonly ref: ArtifactRef;
    readonly state: Record<string, unknown>;
    readonly index: ArtifactIndex;
  }> {
    this.registry.assertCanonicalArtifact(options.artifactType, options.state);

    const json = `${JSON.stringify(options.state, null, 2)}\n`;
    const artifactPathOnDisk = resolveArtifactRef(this.runRoot, options.ref);
    await mkdir(path.dirname(artifactPathOnDisk), { recursive: true });
    await writeFile(artifactPathOnDisk, json, 'utf8');

    const entry = await this.buildIndexEntryFromFields({
      ref: options.ref,
      artifactType: options.artifactType,
      schemaVersion: schemaVersionFromState(options.state),
      artifactId:
        options.metadata.artifactId ??
        defaultArtifactId(options.artifactType, options.ref),
      runId: options.metadata.runId,
      batchId: options.metadata.batchId,
      unitId: options.metadata.unitId,
      attempt: options.metadata.attempt,
      fixRound: options.metadata.fixRound,
      producer: options.metadata.producer,
      createdAt: options.metadata.createdAt ?? new Date().toISOString(),
      commitRefs: options.metadata.commitRefs ?? [],
    });
    const index = await this.upsertIndex(entry);

    return {
      ref: options.ref,
      state: options.state,
      index,
    };
  }

  async writeStopReportForSchemaFailure(
    error: unknown,
    options: WriteStopReportForSchemaFailureOptions,
  ): Promise<ArtifactWriteResult> {
    const schemaError = normalizeSchemaFailure(error);
    const payload = {
      status: 'stopped',
      reason_code: 'schema_validation_failed',
      classification: schemaError.classification,
      message: schemaError.message,
      failed_schema_id: schemaError.schemaId ?? null,
      failed_artifact_ref: options.failedArtifactRef ?? null,
      errors: schemaError.errors,
      resume_from: options.resumeFrom ?? null,
      cannot_resume_reason:
        'MVP-0 does not retry or auto-repair schema validation failures.',
      suggested_actions: [
        'Inspect the structured schema errors.',
        'Fix the producing router, role, or program artifact writer.',
        'Start a new run after correcting the invalid payload.',
      ],
    };

    return await this.writeProgramArtifact({
      artifactType: 'stop_report',
      ref: options.ref ?? artifactPath('stop-report.json'),
      payload,
      metadata: options.metadata,
      renderMarkdown: true,
    });
  }

  private buildCanonicalArtifact(
    artifactType: ArtifactType,
    ref: ArtifactRef,
    payload: unknown,
    metadata: ArtifactMetadataInput,
  ): CanonicalArtifact {
    const createdAt = metadata.createdAt ?? new Date().toISOString();

    return pruneUndefined({
      schema_version: canonicalSchemaVersion(artifactType),
      artifact_type: artifactType,
      artifact_id: metadata.artifactId ?? defaultArtifactId(artifactType, ref),
      run_id: metadata.runId,
      batch_id: metadata.batchId,
      unit_id: metadata.unitId,
      attempt: metadata.attempt,
      fix_round: metadata.fixRound,
      producer: metadata.producer,
      input_artifacts: metadata.inputArtifacts ?? [],
      created_at: createdAt,
      payload,
      commit_refs: metadata.commitRefs ?? [],
    }) as unknown as CanonicalArtifact;
  }

  private async writeCanonicalArtifact(
    artifact: CanonicalArtifact,
    ref: ArtifactRef,
    renderMarkdown: boolean,
  ): Promise<ArtifactWriteResult> {
    const json = `${JSON.stringify(artifact, null, 2)}\n`;
    const artifactPathOnDisk = resolveArtifactRef(this.runRoot, ref);
    await mkdir(path.dirname(artifactPathOnDisk), { recursive: true });
    await writeFile(artifactPathOnDisk, json, 'utf8');

    let markdownRef: ArtifactRef | undefined;
    if (renderMarkdown) {
      markdownRef = markdownRefForJsonRef(ref);
      const markdownPath = resolveArtifactRef(this.runRoot, markdownRef);
      await mkdir(path.dirname(markdownPath), { recursive: true });
      await writeFile(markdownPath, renderMarkdownView(artifact), 'utf8');
    }

    const entry = await this.buildIndexEntry(artifact, ref, markdownRef);
    const index = await this.upsertIndex(entry);

    return {
      artifact,
      ref,
      markdownRef,
      index,
    };
  }

  private async buildIndexEntry(
    artifact: CanonicalArtifact,
    ref: ArtifactRef,
    markdownRef?: ArtifactRef,
  ): Promise<ArtifactIndexEntry> {
    return await this.buildIndexEntryFromFields({
      ref,
      artifactType: artifact.artifact_type,
      schemaVersion: artifact.schema_version,
      artifactId: artifact.artifact_id,
      runId: artifact.run_id,
      batchId: artifact.batch_id,
      unitId: artifact.unit_id,
      attempt: artifact.attempt,
      fixRound: artifact.fix_round,
      producer: artifact.producer,
      createdAt: artifact.created_at,
      markdownRef,
      commitRefs: artifact.commit_refs,
    });
  }

  private async buildIndexEntryFromFields(options: {
    readonly ref: ArtifactRef;
    readonly artifactType: ArtifactType;
    readonly schemaVersion: string;
    readonly artifactId: string;
    readonly runId: string;
    readonly batchId?: string;
    readonly unitId?: string;
    readonly attempt?: number;
    readonly fixRound?: number;
    readonly producer: ArtifactProducer;
    readonly createdAt: string;
    readonly markdownRef?: ArtifactRef;
    readonly commitRefs: readonly CommitRef[];
  }): Promise<ArtifactIndexEntry> {
    const artifactPathOnDisk = resolveArtifactRef(this.runRoot, options.ref);
    const [content, stats] = await Promise.all([
      readFile(artifactPathOnDisk),
      stat(artifactPathOnDisk),
    ]);

    return pruneUndefined({
      ref: options.ref,
      artifact_type: options.artifactType,
      schema_version: options.schemaVersion,
      artifact_id: options.artifactId,
      run_id: options.runId,
      batch_id: options.batchId,
      unit_id: options.unitId,
      attempt: options.attempt,
      fix_round: options.fixRound,
      producer: options.producer,
      created_at: options.createdAt,
      content_sha256: createHash('sha256').update(content).digest('hex'),
      size_bytes: stats.size,
      markdown_ref: options.markdownRef,
      commit_refs: options.commitRefs,
    }) as unknown as ArtifactIndexEntry;
  }

  private async upsertIndex(entry: ArtifactIndexEntry): Promise<ArtifactIndex> {
    const now = new Date().toISOString();
    const existing = await this.readIndex(now);
    const artifacts = [
      ...existing.artifacts.filter((item) => item.ref !== entry.ref),
      entry,
    ].sort((left, right) => left.ref.localeCompare(right.ref));

    const index: ArtifactIndex = {
      schema_version: 'agentflow.artifact_index.v1',
      updated_at: now,
      artifacts,
    };

    this.registry.assertCanonicalArtifact('artifact_index', index);

    const indexPathOnDisk = resolveArtifactRef(
      this.runRoot,
      artifactIndexPath(),
    );
    await mkdir(path.dirname(indexPathOnDisk), { recursive: true });
    await writeFile(
      indexPathOnDisk,
      `${JSON.stringify(index, null, 2)}\n`,
      'utf8',
    );

    return index;
  }

  private async readIndex(updatedAt: string): Promise<ArtifactIndex> {
    const indexPathOnDisk = resolveArtifactRef(
      this.runRoot,
      artifactIndexPath(),
    );

    try {
      const raw = await readFile(indexPathOnDisk, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      this.registry.assertCanonicalArtifact('artifact_index', parsed);
      return parsed as ArtifactIndex;
    } catch (error) {
      if (isMissingFileError(error)) {
        return emptyArtifactIndex(updatedAt);
      }

      if (error instanceof SyntaxError) {
        throw new SchemaValidationError({
          classification: 'invalid_json',
          message: `Invalid artifact index JSON: ${error.message}`,
        });
      }

      throw error;
    }
  }
}

function markdownRefForJsonRef(ref: ArtifactRef): ArtifactRef {
  if (ref.endsWith('.json')) {
    return parseArtifactRef(`${ref.slice(0, -'.json'.length)}.md`);
  }

  return parseArtifactRef(`${ref}.md`);
}

function defaultArtifactId(
  artifactType: ArtifactType,
  ref: ArtifactRef,
): string {
  const slug =
    ref
      .replace(/^\.agentflow\//, '')
      .replace(/\.[^.]+$/, '')
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'artifact';

  return `${artifactType}-${slug}`;
}

function normalizeSchemaFailure(error: unknown): SchemaValidationError {
  if (error instanceof SchemaValidationError) {
    return error;
  }

  return new SchemaValidationError({
    classification: 'canonical_schema_invalid',
    message: error instanceof Error ? error.message : String(error),
  });
}

function schemaVersionFromState(state: Record<string, unknown>): string {
  const schemaVersion = state.schema_version;
  if (typeof schemaVersion === 'string' && schemaVersion.length > 0) {
    return schemaVersion;
  }

  throw new SchemaValidationError({
    classification: 'canonical_schema_invalid',
    message: 'State artifact is missing schema_version.',
  });
}

function isMissingFileError(error: unknown): boolean {
  return (
    isRecord(error) &&
    error.code === 'ENOENT' &&
    typeof error.message === 'string'
  );
}

function pruneUndefined(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
}
