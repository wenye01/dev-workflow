import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  SchemaRegistry,
  type LlmPayloadType,
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
});

async function readPayload(file: string): Promise<unknown> {
  return JSON.parse(
    await readFile(
      path.join(process.cwd(), 'fixtures', 'payloads', file),
      'utf8',
    ),
  ) as unknown;
}
