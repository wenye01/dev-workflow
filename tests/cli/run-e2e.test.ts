import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createProgram } from '../../src/cli/index.js';

const execFileAsync = promisify(execFile);

describe('agentflow run CLI integration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('runs fail -> fix -> pass from the CLI and finalizes with runtime counters', async () => {
    const repo = await makeFailFixPassRepo();
    const taskPath = path.join(repo, 'TASK.md');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    await createProgram().parseAsync([
      'node',
      'agentflow',
      'run',
      '--repo',
      repo,
      '--task',
      taskPath,
      '--run-id',
      'run-cli-fail-fix-pass',
      '--max-fix-rounds',
      '1',
      '--max-evaluator-retries',
      '1',
    ]);

    expect(error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();

    const output = JSON.parse(log.mock.calls.at(-1)?.[0] ?? '{}') as {
      readonly status: string;
      readonly outputs: {
        readonly final_or_stop_report: string;
        readonly final_run_state: string;
      };
      readonly unit: {
        readonly decision: string;
        readonly fix_rounds: number;
      };
    };

    expect(output.status).toBe('finalized');
    expect(output.unit.decision).toBe('pass');
    expect(output.unit.fix_rounds).toBe(1);
    expect(output.outputs.final_or_stop_report).toBe(
      '.agentflow/final-summary.json',
    );
    expect(output.outputs.final_run_state).toBe('.agentflow/run.json');

    await expect(
      readFile(path.join(repo, output.outputs.final_or_stop_report), 'utf8'),
    ).resolves.toContain('"status": "finalized"');

    await expect(
      readFile(
        path.join(
          repo,
          '.agentflow',
          'units',
          'auth-refresh',
          'change-package.fix.json',
        ),
        'utf8',
      ),
    ).resolves.toContain('"mode": "fix"');

    const finalDecision = await readJson<{
      readonly payload: { readonly decision: string };
    }>(
      path.join(
        repo,
        '.agentflow',
        'units',
        'auth-refresh',
        'decision.0.json',
      ),
    );
    expect(finalDecision.payload.decision).toBe('pass');

    const runState = await readJson<{
      readonly status: string;
      readonly budgets: {
        readonly max_fix_rounds: number;
        readonly max_evaluator_retries: number;
      };
      readonly counters: {
        readonly fix_loops: number;
        readonly commits_created: number;
        readonly cli_processes_started: number;
        readonly schema_failures: number;
      };
    }>(path.join(repo, '.agentflow', 'run.json'));

    expect(runState.status).toBe('finalized');
    expect(runState.budgets).toMatchObject({
      max_fix_rounds: 1,
      max_evaluator_retries: 1,
    });
    expect(runState.counters.fix_loops).toBe(1);
    expect(runState.counters.commits_created).toBeGreaterThanOrEqual(2);
    expect(runState.counters.cli_processes_started).toBe(4);
    expect(runState.counters.schema_failures).toBe(0);
  });
});

async function makeFailFixPassRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), 'agentflow-cli-e2e-'));
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.name', 'Agentflow Test']);
  await git(repo, ['config', 'user.email', 'agentflow-test@example.invalid']);

  const wrapperPath = await writeFailFixPassWrapper(repo);
  await writeJson(repo, 'package.json', {
    name: 'fixture-cli-e2e',
    scripts: {
      test: 'node tests/auth/index.test.js',
      build: 'node -e "process.exit(0)"',
    },
  });
  await writeText(
    repo,
    'src/auth/index.js',
    'exports.login = function login() {\n  return true;\n};\n',
  );
  await writeText(
    repo,
    'tests/auth/index.test.js',
    [
      "const assert = require('node:assert/strict');",
      "const { login } = require('../../src/auth/index.js');",
      'assert.equal(login(), true);',
      '',
    ].join('\n'),
  );
  await writeText(
    repo,
    'TASK.md',
    [
      '# Fixture Task',
      '',
      'Implement auth refresh behavior in src/auth/index.js and cover it with tests/auth/index.test.js.',
      '',
    ].join('\n'),
  );
  await writeJson(repo, '.agentflow/settings.json', {
    budgets: {
      max_fix_rounds: 1,
      max_evaluator_retries: 1,
    },
    providers: {
      'fixture-wrapper': {
        agent: 'mock',
        model: 'fixture-wrapper',
        wrapper_path: process.execPath,
        wrapper_extra_args: [wrapperPath],
      },
    },
    roles: {
      'generator.implementer': {
        provider_candidates: [
          { provider: 'fixture-wrapper', model: 'fixture-wrapper' },
        ],
      },
      'evaluator.contract_checker': {
        provider_candidates: [
          { provider: 'fixture-wrapper', model: 'fixture-wrapper' },
        ],
      },
    },
  });

  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'initial']);
  return repo;
}

async function writeFailFixPassWrapper(repo: string): Promise<string> {
  const wrapperPath = path.join(repo, 'fixture-wrapper.mjs');
  await writeFile(
    wrapperPath,
    `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  stdin += chunk;
});
process.stdin.on('end', () => {
  const request = JSON.parse(stdin);
  const role = request.options?.role ?? '';
  const mode = /fix mode/.test(request.prompt) ? 'fix' : 'initial';

  if (role === 'generator.implementer') {
    const sourcePath = path.join(request.cwd, 'src', 'auth', 'index.js');
    const value = mode === 'fix' ? 'true' : 'false';
    fs.writeFileSync(
      sourcePath,
      'exports.login = function login() {\\n  return ' + value + ';\\n};\\n',
      'utf8',
    );
  }

  const changedFiles =
    role === 'generator.implementer'
      ? [{ path: 'src/auth/index.js', change_type: 'modified', reason: 'Fixture wrapper changed auth behavior.' }]
      : [];
  process.stdout.write(JSON.stringify({
    success: true,
    agent: request.agent,
    model: request.model,
    session_id: 'fixture-session',
    message: 'fixture completed',
    artifacts: {
      status: 'completed',
      summary: role + ' fixture completed in ' + mode + ' mode.',
      changed_files: changedFiles,
      verification: [],
      criteria_mapping: [],
      evidence: [],
      issues: [],
      risks: []
    },
    exit_code: 0,
    duration_ms: 1
  }));
});
`,
    'utf8',
  );
  return wrapperPath;
}

async function writeText(
  repo: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const filePath = path.join(repo, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

async function writeJson(
  repo: string,
  relativePath: string,
  content: unknown,
): Promise<void> {
  await writeText(repo, relativePath, `${JSON.stringify(content, null, 2)}\n`);
}

async function readJson<T = unknown>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}
