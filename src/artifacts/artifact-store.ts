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
    const artifactPathOnDisk = resolveArtifactRef(this.runRoot, ref);
    const [content, stats] = await Promise.all([
      readFile(artifactPathOnDisk),
      stat(artifactPathOnDisk),
    ]);

    return pruneUndefined({
      ref,
      artifact_type: artifact.artifact_type,
      schema_version: artifact.schema_version,
      artifact_id: artifact.artifact_id,
      run_id: artifact.run_id,
      batch_id: artifact.batch_id,
      unit_id: artifact.unit_id,
      attempt: artifact.attempt,
      fix_round: artifact.fix_round,
      producer: artifact.producer,
      created_at: artifact.created_at,
      content_sha256: createHash('sha256').update(content).digest('hex'),
      size_bytes: stats.size,
      markdown_ref: markdownRef,
      commit_refs: artifact.commit_refs,
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
