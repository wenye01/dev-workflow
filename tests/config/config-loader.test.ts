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
      agent: 'codex',
      command: 'codeagent-wrapper',
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
          agent: 'claude',
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
      agent: 'codex',
      model: 'project-model',
      sandbox: 'read-only',
    });
    expect(config.providers.claude).toMatchObject({
      agent: 'claude',
      model: 'global-claude',
    });
    expect(config.roles['planner.router']?.providerCandidates).toEqual([
      { provider: 'codex' },
    ]);
  });

  it('parses budget values from camelCase and snake_case config', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'agentflow-config-budgets-'));
    const configPath = path.join(repo, 'agentflow.config.json');
    await writeJson(configPath, {
      budgets: {
        max_fix_rounds: 2,
        maxEvaluatorRetries: 3,
      },
    });

    const config = await loadAgentflowConfig({
      configPath,
      globalConfigPath: false,
    });

    expect(config.budgets.maxFixRounds).toBe(2);
    expect(config.budgets.maxEvaluatorRetries).toBe(3);
  });

  it('throws when budgets contain invalid values', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'agentflow-config-invalid-budgets-'));
    const configPath = path.join(repo, 'agentflow.config.yaml');
    await writeText(
      configPath,
      [
        'budgets:',
        '  max_fix_rounds: not-a-number',
        '  max_evaluator_retries: 2',
      ].join('\n'),
    );

    await expect(
      loadAgentflowConfig({
        configPath,
        globalConfigPath: false,
      }),
    ).rejects.toMatchObject({
      code: 'AGENTFLOW_CONFIG_INVALID_BUDGET',
    });
  });
});

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeText(filePath: string, value: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${value}\n`, 'utf8');
}
