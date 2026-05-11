import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  artifactIndexPath,
  artifactPath,
  eventLogPath,
  parseArtifactRef,
  resolveArtifactRef,
  runStatePath,
  unitRolePath,
  unitStatePath,
  worktreePath,
} from '../../src/artifacts/paths.js';
import { asRunId, asUnitId } from '../../src/core/types.js';

describe('artifact path helpers', () => {
  it('builds canonical .agentflow artifact refs', () => {
    const unitId = asUnitId('unit-auth-001');

    expect(runStatePath()).toBe('.agentflow/run.json');
    expect(artifactIndexPath()).toBe('.agentflow/artifact-index.json');
    expect(eventLogPath()).toBe('.agentflow/events/events.jsonl');
    expect(unitStatePath(unitId)).toBe(
      '.agentflow/units/unit-auth-001/state.json',
    );
    expect(unitRolePath(unitId, 'implementer-output.json')).toBe(
      '.agentflow/units/unit-auth-001/roles/implementer-output.json',
    );
  });

  it('rejects unsafe path segments and non-agentflow refs', () => {
    expect(() => artifactPath('..', 'run.json')).toThrow(/relative/);
    expect(() => artifactPath('inputs/task.md')).toThrow(/separators/);
    expect(() => parseArtifactRef('run.json')).toThrow(/under \.agentflow/);
    expect(() => parseArtifactRef('.agentflow/../run.json')).toThrow(
      /normalized/,
    );
    expect(() => parseArtifactRef('/tmp/.agentflow/run.json')).toThrow(
      /relative/,
    );
  });

  it('resolves artifact refs inside a run root', () => {
    const runRoot = path.resolve('/tmp/project');
    const resolved = resolveArtifactRef(
      runRoot,
      parseArtifactRef('.agentflow/run.json'),
    );

    expect(resolved).toBe(path.join(runRoot, '.agentflow', 'run.json'));
  });

  it('builds run worktree paths outside the artifact tree', () => {
    expect(worktreePath(asRunId('run-20260508-001'))).toBe(
      '.agentflow-worktrees/run-20260508-001',
    );
  });
});
