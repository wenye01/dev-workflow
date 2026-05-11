import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createProgram } from '../../src/cli/index.js';

describe('provider and role catalog tools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('lists role catalog provider candidates as JSON', async () => {
    const configPath = await writeConfig();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram().parseAsync([
      'node',
      'agentflow',
      'tool',
      'role-catalog',
      'list',
      '--config',
      configPath,
    ]);

    expect(process.exitCode).toBeUndefined();
    expect(JSON.parse(log.mock.calls[0]?.[0] ?? '{}')).toMatchObject({
      roles: [
        {
          name: 'planner.router',
          provider_candidates: [
            { provider: 'mock-primary', model: 'mock-plan' },
            { provider: 'mock-fallback', model: 'mock-fallback' },
          ],
        },
      ],
    });
  });

  it('lists provider capabilities derived from config', async () => {
    const configPath = await writeConfig();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram().parseAsync([
      'node',
      'agentflow',
      'tool',
      'provider',
      'capabilities',
      '--config',
      configPath,
    ]);

    expect(process.exitCode).toBeUndefined();
    expect(JSON.parse(log.mock.calls[0]?.[0] ?? '{}')).toMatchObject({
      providers: expect.arrayContaining([
        expect.objectContaining({
          provider: 'mock-primary',
          type: 'mock',
          capabilities: expect.objectContaining({
            nonInteractive: true,
            schemaOutput: true,
            cwd: true,
          }),
        }),
      ]),
    });
  });
});

async function writeConfig(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'agentflow-config-'));
  const configPath = path.join(dir, 'agentflow.config.yaml');
  await writeFile(
    configPath,
    [
      'providers:',
      '  mock-primary:',
      '    type: mock',
      '    model: mock-plan',
      '  mock-fallback:',
      '    type: mock',
      '    model: mock-fallback',
      'roles:',
      '  planner.router:',
      '    module: planner',
      '    provider_candidates:',
      '      - provider: mock-primary',
      '        model: mock-plan',
      '      - provider: mock-fallback',
      '        model: mock-fallback',
      '',
    ].join('\n'),
    'utf8',
  );
  return configPath;
}
