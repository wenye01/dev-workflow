import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createProgram } from '../../src/cli/index.js';
import { ContextBuilder } from '../../src/context/context-builder.js';
import { SchemaRegistry } from '../../src/schemas/registry.js';

const execFileAsync = promisify(execFile);

describe('Context Builder MVP', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('generates complete context artifacts for three fixture repositories', async () => {
    const repos = [
      await makeTypeScriptRepo('complete'),
      await makeMinimalRepo('minimal'),
      await makeDocumentedRepo('documented'),
    ];
    const builder = new ContextBuilder();

    for (const repo of repos) {
      const { taskPath, configPath } = await writeRunInputs(repo);
      const result = await builder.build({
        repoPath: repo,
        taskPath,
        configPath,
        runId: `run-${path.basename(repo).replace(/[^A-Za-z0-9-]/g, '-')}`,
      });

      expect(['pass', 'degraded']).toContain(result.status);
      await expectContextFiles(repo, result.outputs);
      await expectContextSchemasValid(repo, result.outputs.roleInputs);
    }
  });

  it('records missing required commands as explicit degradations', async () => {
    const repo = await makeMinimalRepo('missing-test-context');
    const { taskPath, configPath } = await writeRunInputs(repo);
    const result = await new ContextBuilder().build({
      repoPath: repo,
      taskPath,
      configPath,
      runId: 'run-missing-test-context',
    });
    const report = await readJson<{
      readonly status: string;
      readonly quality: {
        readonly missing_required_commands: readonly string[];
        readonly degradation_count: number;
      };
      readonly degradations: readonly string[];
    }>(path.join(repo, '.agentflow', 'context-build-report.json'));
    const degradationPayloads = await Promise.all(
      report.degradations.map((ref) => readJson(path.join(repo, ref))),
    );

    expect(result.status).toBe('degraded');
    expect(report.status).toBe('degraded');
    expect(report.quality.missing_required_commands).toEqual(
      expect.arrayContaining(['test']),
    );
    expect(report.quality.degradation_count).toBeGreaterThan(0);
    expect(degradationPayloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason_code: 'missing_test_command',
          allow_continue: true,
        }),
      ]),
    );
  });

  it('keeps selected context as Project Index refs instead of inline summaries', async () => {
    const repo = await makeTypeScriptRepo('refs-only');
    const { taskPath, configPath } = await writeRunInputs(
      repo,
      'Update src/auth/index.ts and tests/auth/index.test.ts.',
    );

    await new ContextBuilder().build({
      repoPath: repo,
      taskPath,
      configPath,
      runId: 'run-refs-only',
    });

    const selectedContext = await readJson<Record<string, unknown>>(
      path.join(repo, '.agentflow', 'context', 'selected-project-context.json'),
    );
    const serialized = JSON.stringify(selectedContext);

    expect(selectedContext).toHaveProperty('project_index_refs');
    expect(serialized).not.toContain('project_overview');
    expect(serialized).not.toContain('Auth module inferred from');
    expect(
      (
        selectedContext.project_index_refs as {
          readonly modules: ReadonlyArray<{ readonly content_sha256: string }>;
        }
      ).modules[0]?.content_sha256,
    ).toMatch(/^[a-f0-9]{64}$/);
  });

  it('wires agentflow run through Context Builder and stops before Planner runtime', async () => {
    const repo = await makeTypeScriptRepo('cli-run');
    const { taskPath, configPath } = await writeRunInputs(repo);
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
      '--config',
      configPath,
      '--run-id',
      'run-cli-context',
    ]);

    expect(error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    expect(JSON.parse(log.mock.calls.at(-1)?.[0] ?? '{}')).toMatchObject({
      status: 'context_ready',
      run_id: 'run-cli-context',
      project_index_status: 'built',
      next: 'Planner runtime is not implemented until Milestone 8.',
    });
  });
});

async function expectContextFiles(
  repo: string,
  outputs: {
    readonly task: string;
    readonly projectIndexRef: string;
    readonly worktreeStatus: string;
    readonly selectedProjectContext: string;
    readonly sourceSlices: readonly string[];
    readonly roleInputs: readonly string[];
    readonly contextBuildReport: string;
  },
): Promise<void> {
  const refs = [
    outputs.task,
    outputs.projectIndexRef,
    outputs.worktreeStatus,
    outputs.selectedProjectContext,
    outputs.contextBuildReport,
    ...outputs.sourceSlices,
    ...outputs.roleInputs,
    '.agentflow/artifact-index.json',
  ];

  for (const ref of refs) {
    await expect(readFile(path.join(repo, ref), 'utf8')).resolves.toBeTypeOf(
      'string',
    );
  }
}

async function expectContextSchemasValid(
  repo: string,
  roleInputs: readonly string[],
): Promise<void> {
  const registry = SchemaRegistry.load();

  registry.assertBySchemaId(
    'agentflow.schema.context.project_index_ref.v1',
    await readJson(
      path.join(repo, '.agentflow', 'inputs', 'project-index-ref.json'),
    ),
  );
  registry.assertBySchemaId(
    'agentflow.schema.context.worktree_status.v1',
    await readJson(
      path.join(repo, '.agentflow', 'inputs', 'worktree-status.json'),
    ),
  );
  registry.assertBySchemaId(
    'agentflow.schema.context.selected_project_context.v1',
    await readJson(
      path.join(repo, '.agentflow', 'context', 'selected-project-context.json'),
    ),
  );
  registry.assertBySchemaId(
    'agentflow.schema.context.build_report.v1',
    await readJson(path.join(repo, '.agentflow', 'context-build-report.json')),
  );

  const sourceSliceDir = path.join(
    repo,
    '.agentflow',
    'index',
    'source-slices',
  );
  for (const name of ['planner.json', 'generator.json', 'evaluator.json']) {
    registry.assertBySchemaId(
      'agentflow.schema.context.source_slice.v1',
      await readJson(path.join(sourceSliceDir, name)),
    );
  }

  for (const ref of roleInputs) {
    registry.assertCanonicalArtifact(
      'role_input',
      await readJson(path.join(repo, ref)),
    );
  }
}

async function writeRunInputs(
  repo: string,
  task = 'Implement auth refresh behavior in src/auth/index.ts and cover it with tests/auth/index.test.ts.',
): Promise<{ readonly taskPath: string; readonly configPath: string }> {
  const taskPath = path.join(repo, 'TASK.md');
  const configPath = path.join(repo, 'agentflow.config.yaml');
  await writeText(repo, 'TASK.md', `# Fixture Task\n\n${task}\n`);
  await writeText(repo, 'agentflow.config.yaml', 'providers: {}\nroles: {}\n');
  await git(repo, ['add', 'TASK.md', 'agentflow.config.yaml']);
  await git(repo, ['commit', '-m', 'add run inputs']);
  return { taskPath, configPath };
}

async function makeTypeScriptRepo(name: string): Promise<string> {
  const repo = await makeGitRepo(name);
  await writeJson(repo, 'package.json', {
    name: `fixture-${name}`,
    description: 'TypeScript service fixture.',
    scripts: {
      test: 'vitest run',
      lint: 'eslint .',
      typecheck: 'tsc --noEmit',
      build: 'tsup',
    },
    dependencies: {
      '@example/runtime': '1.0.0',
    },
    devDependencies: {
      typescript: '5.8.3',
    },
  });
  await writeText(repo, 'README.md', '# Fixture Service\n\nDeveloper usage.\n');
  await writeText(
    repo,
    'docs/design.md',
    '# Auth Design\n\nAuth module design.\n',
  );
  await writeText(
    repo,
    'src/auth/index.ts',
    'export function login() {\n  return true;\n}\n',
  );
  await writeText(
    repo,
    'tests/auth/index.test.ts',
    "import { login } from '../../src/auth/index';\nlogin();\n",
  );
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'initial']);
  return repo;
}

async function makeMinimalRepo(name: string): Promise<string> {
  const repo = await makeGitRepo(name);
  await writeJson(repo, 'package.json', {
    name: `fixture-${name}`,
    scripts: {
      build: 'echo build',
    },
  });
  await writeText(repo, 'README.md', '# Minimal Fixture\n\nNo tests yet.\n');
  await writeText(repo, 'src/index.ts', 'export const value = 1;\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'initial']);
  return repo;
}

async function makeDocumentedRepo(name: string): Promise<string> {
  const repo = await makeGitRepo(name);
  await writeJson(repo, 'package.json', {
    name: `fixture-${name}`,
    description: 'Documented fixture.',
    scripts: {
      test: 'node --test',
      lint: 'echo lint',
      typecheck: 'echo types',
      build: 'echo build',
    },
  });
  await writeText(repo, 'README.md', '# Documented Fixture\n\nReadme body.\n');
  await writeText(repo, 'docs/api.md', '# API\n\nPublic API notes.\n');
  await writeText(repo, 'src/index.js', 'exports.ok = true;\n');
  await writeText(repo, 'test/index.test.js', 'require("../src");\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'initial']);
  return repo;
}

async function makeGitRepo(name: string): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), `agentflow-context-${name}-`));
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.name', 'Agentflow Test']);
  await git(repo, ['config', 'user.email', 'agentflow-test@example.invalid']);
  return repo;
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

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}
