import { readFile } from 'node:fs/promises';

import { artifactIndexPath, parseArtifactRef, resolveArtifactRef, unitStatePath } from '../artifacts/paths.js';
import type { ArtifactRef } from '../core/types.js';
import { asUnitId } from '../core/types.js';
import { SchemaRegistry } from '../schemas/registry.js';
import { parseJsonObject } from '../schemas/validator.js';

export type RouterContextName =
  | 'project-index-ref'
  | 'selected-project-context'
  | 'worktree-status';

export class RouterToolbox {
  constructor(
    private readonly runRoot: string,
    private readonly registry = SchemaRegistry.load(),
  ) {}

  async readRunState(): Promise<Record<string, unknown>> {
    return await this.readValidatedCanonical(
      'run_state',
      parseArtifactRef('.agentflow/run.json'),
    );
  }

  async readUnitState(unitId: string): Promise<Record<string, unknown>> {
    return await this.readValidatedCanonical(
      'unit_state',
      unitStatePath(asUnitId(unitId)),
    );
  }

  async readArtifactIndex(): Promise<Record<string, unknown>> {
    return await this.readValidatedCanonical(
      'artifact_index',
      artifactIndexPath(),
    );
  }

  async readArtifact(ref: string): Promise<Record<string, unknown>> {
    const artifactRef = parseArtifactRef(ref);
    return await readJsonFile(resolveArtifactRef(this.runRoot, artifactRef));
  }

  async readContext(name: RouterContextName): Promise<{
    readonly name: RouterContextName;
    readonly ref: ArtifactRef;
    readonly value: Record<string, unknown>;
  }> {
    const ref = contextArtifactRef(name);
    return {
      name,
      ref,
      value: await readJsonFile(resolveArtifactRef(this.runRoot, ref)),
    };
  }

  async readWorktreeStatus(): Promise<Record<string, unknown>> {
    return (await this.readContext('worktree-status')).value;
  }

  async readWorktreeDiffSummary(): Promise<{
    readonly ref: ArtifactRef;
    readonly diff_summary: string;
  }> {
    const worktreeStatus = await this.readContext('worktree-status');
    const diffSummary =
      typeof worktreeStatus.value.diff_summary === 'string'
        ? worktreeStatus.value.diff_summary
        : '';

    return {
      ref: worktreeStatus.ref,
      diff_summary: diffSummary,
    };
  }

  private async readValidatedCanonical(
    artifactType: 'run_state' | 'unit_state' | 'artifact_index',
    ref: ArtifactRef,
  ): Promise<Record<string, unknown>> {
    const value = await readJsonFile(resolveArtifactRef(this.runRoot, ref));
    this.registry.assertCanonicalArtifact(artifactType, value);
    return value;
  }
}

export function contextArtifactRef(name: RouterContextName): ArtifactRef {
  if (name === 'project-index-ref') {
    return parseArtifactRef('.agentflow/inputs/project-index-ref.json');
  }

  if (name === 'selected-project-context') {
    return parseArtifactRef('.agentflow/context/selected-project-context.json');
  }

  return parseArtifactRef('.agentflow/inputs/worktree-status.json');
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown>> {
  const raw = await readFile(filePath, 'utf8');
  return parseJsonObject(raw);
}
