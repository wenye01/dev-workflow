import type { ArtifactRef, CommitRef } from '../core/types.js';
import type { ArtifactType } from '../schemas/registry.js';

export interface ArtifactProducer {
  readonly kind: 'orchestrator' | 'router' | 'role' | 'adapter' | 'system';
  readonly module?:
    | 'planner'
    | 'generator'
    | 'evaluator'
    | 'decision'
    | 'finalize';
  readonly role?: string;
  readonly provider?: string;
  readonly model?: string;
}

export interface ArtifactIndexEntry {
  readonly ref: ArtifactRef;
  readonly artifact_type: ArtifactType;
  readonly schema_version: string;
  readonly artifact_id: string;
  readonly run_id: string;
  readonly batch_id?: string;
  readonly unit_id?: string;
  readonly attempt?: number;
  readonly fix_round?: number;
  readonly producer: ArtifactProducer;
  readonly created_at: string;
  readonly content_sha256: string;
  readonly size_bytes: number;
  readonly markdown_ref?: ArtifactRef;
  readonly commit_refs: readonly CommitRef[];
}

export interface ArtifactIndex {
  readonly schema_version: 'agentflow.artifact_index.v1';
  readonly updated_at: string;
  readonly artifacts: readonly ArtifactIndexEntry[];
}

export function emptyArtifactIndex(updatedAt: string): ArtifactIndex {
  return {
    schema_version: 'agentflow.artifact_index.v1',
    updated_at: updatedAt,
    artifacts: [],
  };
}
