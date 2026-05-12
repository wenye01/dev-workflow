import path from 'node:path';

import type { ArtifactRef, RunId, UnitId } from '../core/types.js';

export const AGENTFLOW_DIR = '.agentflow';
export const AGENTFLOW_WORKTREES_DIR = '.agentflow-worktrees';

export type ArtifactPathSegment = string | number;

export function artifactPath(
  ...segments: readonly ArtifactPathSegment[]
): ArtifactRef {
  const safeSegments = segments.map((segment) =>
    assertSafeSegment(String(segment)),
  );
  const ref = path.posix.join(AGENTFLOW_DIR, ...safeSegments);
  return parseArtifactRef(ref);
}

export function parseArtifactRef(value: string): ArtifactRef {
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new Error(`Artifact ref must be relative: ${value}`);
  }

  if (value.includes('\\')) {
    throw new Error(`Artifact ref must use POSIX separators: ${value}`);
  }

  if (value !== AGENTFLOW_DIR && !value.startsWith(`${AGENTFLOW_DIR}/`)) {
    throw new Error(`Artifact ref must be under ${AGENTFLOW_DIR}: ${value}`);
  }

  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized.split('/').includes('..')) {
    throw new Error(
      `Artifact ref must be normalized and stay under ${AGENTFLOW_DIR}: ${value}`,
    );
  }

  return value as ArtifactRef;
}

export function resolveArtifactRef(runRoot: string, ref: ArtifactRef): string {
  const resolvedRoot = path.resolve(runRoot);
  const resolvedRef = path.resolve(resolvedRoot, ref);
  const relative = path.relative(resolvedRoot, resolvedRef);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Artifact ref escapes run root: ${ref}`);
  }

  return resolvedRef;
}

export function runStatePath(): ArtifactRef {
  return artifactPath('run.json');
}

export function configSnapshotPath(): ArtifactRef {
  return artifactPath('config.snapshot.yaml');
}

export function artifactIndexPath(): ArtifactRef {
  return artifactPath('artifact-index.json');
}

export function inputPath(name: string): ArtifactRef {
  return artifactPath('inputs', name);
}

export function indexPath(
  ...segments: readonly ArtifactPathSegment[]
): ArtifactRef {
  return artifactPath('index', ...segments);
}

export function plannerPath(name: string): ArtifactRef {
  return artifactPath('planner', name);
}

export function plannerBatchSchedulePath(): ArtifactRef {
  return plannerPath('batch-schedule.json');
}

export function unitPath(
  unitId: UnitId,
  ...segments: readonly ArtifactPathSegment[]
): ArtifactRef {
  return artifactPath('units', unitId, ...segments);
}

export function unitContractPath(unitId: UnitId): ArtifactRef {
  return unitPath(unitId, 'contract.json');
}

export function unitStatePath(unitId: UnitId): ArtifactRef {
  return unitPath(unitId, 'state.json');
}

export function unitGenerationInputPath(
  unitId: UnitId,
  mode: 'initial' | 'fix' = 'initial',
): ArtifactRef {
  return unitPath(unitId, `generation-input.${mode}.json`);
}

export function unitChangePackagePath(
  unitId: UnitId,
  mode: 'initial' | 'fix' = 'initial',
): ArtifactRef {
  return unitPath(unitId, `change-package.${mode}.json`);
}

export function unitEvaluationInputPath(
  unitId: UnitId,
  attempt = 0,
): ArtifactRef {
  return unitPath(unitId, `evaluation-input.${attempt}.json`);
}

export function unitEvaluatorReportPath(
  unitId: UnitId,
  attempt = 0,
): ArtifactRef {
  return unitPath(unitId, `evaluator-report.${attempt}.json`);
}

export function unitDecisionPath(unitId: UnitId, attempt = 0): ArtifactRef {
  return unitPath(unitId, `decision.${attempt}.json`);
}

export function unitRolePath(
  unitId: UnitId,
  roleOutputName: ArtifactPathSegment,
): ArtifactRef {
  return unitPath(unitId, 'roles', roleOutputName);
}

export function routingPath(name: string): ArtifactRef {
  return artifactPath('routing', name);
}

export function decisionPath(name: string): ArtifactRef {
  return artifactPath('decisions', name);
}

export function eventLogPath(): ArtifactRef {
  return artifactPath('events', 'events.jsonl');
}

export function metricsPath(name = 'run-metrics.json'): ArtifactRef {
  return artifactPath('metrics', name);
}

export function finalSummaryPath(format: 'json' | 'md'): ArtifactRef {
  return artifactPath(`final-summary.${format}`);
}

export function worktreePath(runId: RunId): string {
  return path.posix.join(AGENTFLOW_WORKTREES_DIR, runId);
}

function assertSafeSegment(segment: string): string {
  if (!segment || segment === '.' || segment === '..') {
    throw new Error(
      `Invalid empty or relative artifact path segment: ${segment}`,
    );
  }

  if (segment.includes('/') || segment.includes('\\')) {
    throw new Error(
      `Artifact path segments must not contain separators: ${segment}`,
    );
  }

  return segment;
}
