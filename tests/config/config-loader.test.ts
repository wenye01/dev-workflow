import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadAgentflowConfig } from '../../src/config/config-loader.js';

describe('loadAgentflowConfig', () => {
  it('uses built-in defaults when no settings file exists', async () => {
    const repo = await mkdtemp(
      path.join(tmpdir(), 'agentflow-config-default-'),
    );

    const config = await loadAgentflowConfig({
      repoPath: repo,
      globalConfigPath: false,
    });

    expect(config.sources).toEqual([]);
    expect(config.providers.codex).toMatchObject({
      type: 'codex',
      command: 'codex',
    });
    expect(config.roles['planner.router']?.providerCandidates).toEqual([
      { provider: 'codex' },
    ]);
  });

  it('merges global settings with project settings and lets project win', async () => {
    const repo = await mkdtemp(
      path.join(tmpdir(), 'agentflow-config-project-'),
    );
    const globalConfig = path.join(repo, 'global-settings.json');
    const projectConfig = path.join(repo, '.agentflow', 'settings.json');
    await writeJson(globalConfig, {
      providers: {
        codex: {
          model: 'global-model',
          sandbox: 'read-only',
        },
        claude: {
          type: 'claude',
          model: 'global-claude',
        },
      },
      roles: {
        'planner.router': {
          provider_candidates: [{ provider: 'claude' }],
        },
      },
    });
    await writeJson(projectConfig, {
      providers: {
        codex: {
          model: 'project-model',
        },
      },
      roles: {
        'planner.router': {
          provider_candidates: [{ provider: 'codex' }],
        },
      },
    });

    const config = await loadAgentflowConfig({
      repoPath: repo,
      globalConfigPath: globalConfig,
    });

    expect(config.sources).toEqual([globalConfig, projectConfig]);
    expect(config.providers.codex).toMatchObject({
      type: 'codex',
      model: 'project-model',
      sandbox: 'read-only',
    });
    expect(config.providers.claude).toMatchObject({
      type: 'claude',
      model: 'global-claude',
    });
    expect(config.roles['planner.router']?.providerCandidates).toEqual([
      { provider: 'codex' },
    ]);
  });
});

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
