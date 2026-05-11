import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ArtifactStore } from '../../src/artifacts/artifact-store.js';
import {
  artifactIndexPath,
  parseArtifactRef,
  plannerPath,
  resolveArtifactRef,
  unitPath,
} from '../../src/artifacts/paths.js';
import { asUnitId } from '../../src/core/types.js';
import { SchemaValidationError } from '../../src/schemas/validator.js';

describe('ArtifactStore', () => {
  it('enriches a valid LLM payload into a canonical artifact and index entry', async () => {
    const runRoot = await makeRunRoot();
    const store = new ArtifactStore(runRoot);
    const payload = await readPayload('valid-planner-package.json');

    const result = await store.writeFromPayload({
      payloadType: 'planner_package',
      artifactType: 'planner_package',
      ref: plannerPath('package.json'),
      payload,
      metadata: {
        runId: 'run-fixture',
        artifactId: 'planner-package-run-fixture',
        producer: {
          kind: 'router',
          module: 'planner',
          role: 'planner.router',
        },
        createdAt: '2026-05-11T00:00:00.000Z',
      },
      renderMarkdown: true,
    });

    expect(result.artifact.schema_version).toBe('agentflow.planner_package.v1');
    expect(result.artifact.payload).toEqual(payload);
    expect(result.markdownRef).toBe('.agentflow/planner/package.md');

    const canonical = JSON.parse(
      await readFile(
        resolveArtifactRef(runRoot, plannerPath('package.json')),
        'utf8',
      ),
    ) as Record<string, unknown>;
    expect(canonical.artifact_type).toBe('planner_package');

    const markdown = await readFile(
      resolveArtifactRef(
        runRoot,
        parseArtifactRef('.agentflow/planner/package.md'),
      ),
      'utf8',
    );
    expect(markdown).toContain('This Markdown view is not authoritative state');

    const index = JSON.parse(
      await readFile(resolveArtifactRef(runRoot, artifactIndexPath()), 'utf8'),
    ) as {
      readonly artifacts: ReadonlyArray<{ readonly ref: string }>;
    };
    expect(index.artifacts.map((entry) => entry.ref)).toEqual([
      '.agentflow/planner/package.json',
    ]);
  });

  it('can write a stop report from any schema failure', async () => {
    const runRoot = await makeRunRoot();
    const store = new ArtifactStore(runRoot);
    const invalidPayload = await readPayload('invalid-evaluator-report.json');
    let schemaFailure: unknown;

    try {
      await store.writeFromPayload({
        payloadType: 'evaluator_report',
        artifactType: 'evaluator_report',
        ref: unitPath(asUnitId('unit-auth-001'), 'evaluator-report.json'),
        payload: invalidPayload,
        metadata: {
          runId: 'run-fixture',
          unitId: 'unit-auth-001',
          attempt: 1,
          producer: {
            kind: 'router',
            module: 'evaluator',
            role: 'evaluator.router',
          },
          createdAt: '2026-05-11T00:00:00.000Z',
        },
      });
    } catch (error) {
      schemaFailure = error;
    }

    expect(schemaFailure).toBeInstanceOf(SchemaValidationError);

    const stop = await store.writeStopReportForSchemaFailure(schemaFailure, {
      failedArtifactRef: unitPath(
        asUnitId('unit-auth-001'),
        'evaluator-report.json',
      ),
      metadata: {
        runId: 'run-fixture',
        producer: {
          kind: 'orchestrator',
          module: 'decision',
        },
        createdAt: '2026-05-11T00:00:01.000Z',
      },
    });

    expect(stop.artifact.artifact_type).toBe('stop_report');
    expect(stop.artifact.payload).toMatchObject({
      status: 'stopped',
      reason_code: 'schema_validation_failed',
      classification: 'payload_schema_invalid',
    });
    expect(stop.index.artifacts.map((entry) => entry.ref)).toEqual([
      '.agentflow/stop-report.json',
    ]);
  });
});

async function makeRunRoot(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), 'agentflow-artifacts-'));
}

async function readPayload(file: string): Promise<unknown> {
  return JSON.parse(
    await readFile(
      path.join(process.cwd(), 'fixtures', 'payloads', file),
      'utf8',
    ),
  ) as unknown;
}
