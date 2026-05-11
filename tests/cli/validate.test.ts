import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createProgram } from '../../src/cli/index.js';

describe('validate command', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('validates a fixture against an explicit schema id', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const fixturePath = path.join(
      process.cwd(),
      'fixtures',
      'payloads',
      'valid-evaluator-report.json',
    );

    await createProgram().parseAsync([
      'node',
      'agentflow',
      'validate',
      fixturePath,
      '--schema',
      'agentflow.schema.llm.evaluator_report.v1',
    ]);

    expect(process.exitCode).toBeUndefined();
    expect(JSON.parse(log.mock.calls[0]?.[0] ?? '{}')).toMatchObject({
      status: 'valid',
      schema_id: 'agentflow.schema.llm.evaluator_report.v1',
    });
  });

  it('uses payload classification for explicit LLM schema failures', async () => {
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const fixturePath = path.join(
      process.cwd(),
      'fixtures',
      'payloads',
      'invalid-evaluator-report.json',
    );

    await createProgram().parseAsync([
      'node',
      'agentflow',
      'validate',
      fixturePath,
      '--schema',
      'agentflow.schema.llm.evaluator_report.v1',
    ]);

    expect(process.exitCode).toBe(2);
    expect(JSON.parse(error.mock.calls[0]?.[0] ?? '{}')).toMatchObject({
      error: {
        classification: 'payload_schema_invalid',
        schema_id: 'agentflow.schema.llm.evaluator_report.v1',
      },
    });
  });
});
