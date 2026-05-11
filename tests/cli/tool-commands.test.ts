import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createProgram } from '../../src/cli/index.js';

describe('tool commands', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('reads run state, unit state, artifact index, context, and worktree artifacts', async () => {
    const runDir = await makeRunDir();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createProgram().parseAsync([
      'node',
      'agentflow',
      'tool',
      'state',
      '--run-dir',
      runDir,
      '--unit',
      'unit-001',
    ]);

    expect(JSON.parse(log.mock.calls[0]?.[0] ?? '{}')).toMatchObject({
      run_state: {
        run_id: 'run-001',
        status: 'running',
      },
      unit_state: {
        unit_id: 'unit-001',
        status: 'ready',
      },
    });

    log.mockClear();

    await createProgram().parseAsync([
      'node',
      'agentflow',
      'tool',
      'artifact',
      'index',
      '--run-dir',
      runDir,
    ]);

    expect(JSON.parse(log.mock.calls[0]?.[0] ?? '{}')).toMatchObject({
      artifact_index: {
        artifacts: [
          {
            ref: '.agentflow/run.json',
          },
        ],
      },
    });

    log.mockClear();

    await createProgram().parseAsync([
      'node',
      'agentflow',
      'tool',
      'context',
      'get',
      '--run-dir',
      runDir,
      '--name',
      'selected-project-context',
    ]);

    expect(JSON.parse(log.mock.calls[0]?.[0] ?? '{}')).toMatchObject({
      name: 'selected-project-context',
      ref: '.agentflow/context/selected-project-context.json',
      artifact: {
        project_index_refs: {
          manifest: expect.any(Object),
        },
      },
    });

    log.mockClear();

    await createProgram().parseAsync([
      'node',
      'agentflow',
      'tool',
      'worktree',
      'diff-summary',
      '--run-dir',
      runDir,
    ]);

    expect(JSON.parse(log.mock.calls[0]?.[0] ?? '{}')).toMatchObject({
      ref: '.agentflow/inputs/worktree-status.json',
      diff_summary: ' src/index.ts | 2 ++',
    });
  });
});

async function makeRunDir(): Promise<string> {
  const runDir = await mkdtemp(path.join(tmpdir(), 'agentflow-run-'));
  await writeTree(runDir);
  return runDir;
}

async function writeTree(runDir: string): Promise<void> {
  await Promise.all([
    mkdir(path.join(runDir, '.agentflow', 'units', 'unit-001'), {
      recursive: true,
    }),
    mkdir(path.join(runDir, '.agentflow', 'inputs'), { recursive: true }),
    mkdir(path.join(runDir, '.agentflow', 'context'), { recursive: true }),
    mkdir(path.join(runDir, '.agentflow'), { recursive: true }),
  ]);

  await Promise.all([
    writeFile(
      path.join(runDir, '.agentflow', 'run.json'),
      JSON.stringify(
        {
          schema_version: 'agentflow.run_state.v1',
          run_id: 'run-001',
          status: 'running',
          worktree_path: '.agentflow-worktrees/run-001',
          workspace_mode: 'git_worktree',
          started_at: '2026-05-11T00:00:00.000Z',
          updated_at: '2026-05-11T00:01:00.000Z',
          budgets: {
            max_batches: 1,
            max_units: 1,
            max_fix_rounds: 1,
            max_evaluator_retries: 1,
          },
          counters: {
            cli_processes_started: 0,
            commits_created: 0,
            schema_failures: 0,
            fix_loops: 0,
          },
          stop_reason: null,
        },
        null,
        2,
      ),
      'utf8',
    ),
    writeFile(
      path.join(runDir, '.agentflow', 'units', 'unit-001', 'state.json'),
      JSON.stringify(
        {
          schema_version: 'agentflow.unit_state.v1',
          unit_id: 'unit-001',
          batch_id: 'batch-001',
          status: 'ready',
          attempt: 0,
          fix_round: 0,
          dependencies: [],
          artifacts: {},
          commits: [],
          pending_transition: null,
          locks: {
            file_scope: [],
          },
          updated_at: '2026-05-11T00:01:00.000Z',
        },
        null,
        2,
      ),
      'utf8',
    ),
    writeFile(
      path.join(runDir, '.agentflow', 'artifact-index.json'),
      JSON.stringify(
        {
          schema_version: 'agentflow.artifact_index.v1',
          updated_at: '2026-05-11T00:01:00.000Z',
          artifacts: [
            {
              ref: '.agentflow/run.json',
              artifact_type: 'run_state',
              schema_version: 'agentflow.run_state.v1',
              artifact_id: 'run-state-run-001',
              run_id: 'run-001',
              producer: { kind: 'system' },
              created_at: '2026-05-11T00:00:00.000Z',
              content_sha256:
                'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              size_bytes: 1,
              commit_refs: [],
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    ),
    writeFile(
      path.join(runDir, '.agentflow', 'inputs', 'project-index-ref.json'),
      JSON.stringify(
        {
          schema_version: 'agentflow.context.project_index_ref.v1',
          generated_at: '2026-05-11T00:01:00.000Z',
          project_index: {
            status: 'built',
            index_id: 'index-001',
            index_dir: '.agentflow/project-index',
            repo: {
              root: runDir,
              base_ref: 'main',
            },
            head: {
              sha: '1234567890abcdef1234567890abcdef12345678',
              ref: 'main',
            },
            config_hash: null,
          },
          project_index_refs: {
            manifest: {
              kind: 'manifest',
              ref: '.agentflow/project-index/manifest.json',
              schema_id: 'agentflow.schema.project_index.manifest.v1',
              content_sha256:
                'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    ),
    writeFile(
      path.join(runDir, '.agentflow', 'context', 'selected-project-context.json'),
      JSON.stringify(
        {
          project_index_refs: {
            manifest: {
              kind: 'manifest',
              ref: '.agentflow/project-index/manifest.json',
              schema_id: 'agentflow.schema.project_index.manifest.v1',
              content_sha256:
                'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            },
          },
          source_slices: [],
          run_artifacts: ['.agentflow/run.json'],
          feedback: [],
          worktree_status: '.agentflow/inputs/worktree-status.json',
        },
        null,
        2,
      ),
      'utf8',
    ),
    writeFile(
      path.join(runDir, '.agentflow', 'inputs', 'worktree-status.json'),
      JSON.stringify(
        {
          schema_version: 'agentflow.context.worktree_status.v1',
          repo: runDir,
          branch: 'main',
          head: {
            sha: '1234567890abcdef1234567890abcdef12345678',
            ref: 'main',
          },
          clean: false,
          changed_files: [
            {
              path: 'src/index.ts',
              status: 'M',
            },
          ],
          untracked_files: [],
          diff_summary: ' src/index.ts | 2 ++',
          commit_refs: [],
        },
        null,
        2,
      ),
      'utf8',
    ),
  ]);
}
