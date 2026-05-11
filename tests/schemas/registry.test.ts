import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PROJECT_INDEX_SCHEMA_IDS,
  SchemaRegistry,
  type LlmPayloadType,
  type ProjectIndexType,
} from '../../src/schemas/registry.js';
import { SchemaValidationError } from '../../src/schemas/validator.js';

const payloadFixtures: ReadonlyArray<{
  readonly type: LlmPayloadType;
  readonly file: string;
}> = [
  { type: 'router_dispatch', file: 'valid-router-dispatch.json' },
  { type: 'role_output', file: 'valid-role-output.json' },
  { type: 'planner_package', file: 'valid-planner-package.json' },
  { type: 'change_package', file: 'valid-change-package.json' },
  { type: 'evaluator_report', file: 'valid-evaluator-report.json' },
];

const projectIndexFixtures: ReadonlyArray<{
  readonly type: ProjectIndexType;
  readonly file: string;
}> = [
  { type: 'manifest', file: 'manifest.json' },
  { type: 'overview', file: 'overview.json' },
  { type: 'repo_tree', file: 'repo-tree.json' },
  { type: 'commands', file: 'commands.json' },
  { type: 'module', file: path.join('modules', 'auth.json') },
  { type: 'document_index', file: path.join('documents', 'index.json') },
  {
    type: 'document_summary',
    file: path.join('documents', 'summaries', 'readme.json'),
  },
  { type: 'build_report', file: 'build-report.json' },
];

describe('schema registry', () => {
  it('validates all Milestone 2 LLM payload fixture types', async () => {
    const registry = SchemaRegistry.load();

    for (const fixture of payloadFixtures) {
      await expect(
        readPayload(fixture.file).then((payload) => {
          registry.assertLlmPayload(fixture.type, payload);
        }),
      ).resolves.toBeUndefined();
    }
  });

  it('validates all Milestone 2 Project Index fixture types', async () => {
    const registry = SchemaRegistry.load();

    for (const fixture of projectIndexFixtures) {
      await expect(
        readProjectIndexFixture(fixture.file).then((projectIndexArtifact) => {
          registry.assertProjectIndex(fixture.type, projectIndexArtifact);
          registry.assertBySchemaId(
            PROJECT_INDEX_SCHEMA_IDS[fixture.type],
            projectIndexArtifact,
          );
        }),
      ).resolves.toBeUndefined();
    }
  });

  it('returns a stable classification for invalid payloads', async () => {
    const registry = SchemaRegistry.load();
    const payload = await readPayload('invalid-evaluator-report.json');

    expect(() =>
      registry.assertLlmPayload('evaluator_report', payload),
    ).toThrowError(SchemaValidationError);

    try {
      registry.assertLlmPayload('evaluator_report', payload);
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaValidationError);
      expect((error as SchemaValidationError).classification).toBe(
        'payload_schema_invalid',
      );
      expect((error as SchemaValidationError).code).toBe(
        'AGENTFLOW_PAYLOAD_SCHEMA_INVALID',
      );
      expect((error as SchemaValidationError).errors.length).toBeGreaterThan(0);
    }
  });

  it('rejects project context fields in Planner Package payloads', async () => {
    const registry = SchemaRegistry.load();
    const validPayload = (await readPayload(
      'valid-planner-package.json',
    )) as Record<string, unknown>;
    const payload = {
      ...validPayload,
      project_overview: 'Inline project overview is not allowed here.',
    };

    expect(() =>
      registry.assertLlmPayload('planner_package', payload),
    ).toThrowError(SchemaValidationError);
  });
});

async function readPayload(file: string): Promise<unknown> {
  return JSON.parse(
    await readFile(
      path.join(process.cwd(), 'fixtures', 'payloads', file),
      'utf8',
    ),
  ) as unknown;
}

async function readProjectIndexFixture(file: string): Promise<unknown> {
  return JSON.parse(
    await readFile(
      path.join(process.cwd(), 'fixtures', 'project-index', file),
      'utf8',
    ),
  ) as unknown;
}
