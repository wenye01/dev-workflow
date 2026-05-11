import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createProgram } from '../../src/cli/index.js';
import { ProjectIndexBuilder } from '../../src/project-index/project-index-builder.js';
import {
  SchemaRegistry,
  type ProjectIndexType,
} from '../../src/schemas/registry.js';

const execFileAsync = promisify(execFile);

describe('Project Index MVP', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('builds schema-valid Project Index artifacts for three fixture repositories', async () => {
    const repos = [
      await makeTypeScriptRepo('complete'),
      await makeMinimalRepo('minimal'),
      await makeDocumentedRepo('documented'),
    ];
    const builder = new ProjectIndexBuilder();

    for (const repo of repos) {
      const result = await builder.build({ repoPath: repo });

      expect(result.status).toBe('built');
      await expectProjectIndexFiles(repo);
      await expectSchemaValidProjectIndex(repo);
    }
  });

  it('records skip reasons and missing commands in the build report', async () => {
    const repo = await makeTypeScriptRepo('skip-reasons');
    const result = await new ProjectIndexBuilder().build({ repoPath: repo });

    const report = await readJson<Record<string, unknown>>(
      path.join(repo, '.agentflow', 'project-index', 'build-report.json'),
    );
    const skippedFiles = report.skipped_files as Array<{
      readonly path: string;
      readonly reason: string;
    }>;
    const skipReasons = new Set(skippedFiles.map((entry) => entry.reason));

    expect(result.status).toBe('built');
    expect([...skipReasons]).toEqual(
      expect.arrayContaining([
        'dependency',
        'gitignored',
        'log_file',
        'sensitive_path',
        'binary',
      ]),
    );
    expect(skippedFiles.map((entry) => entry.path)).toEqual(
      expect.arrayContaining([
        'node_modules',
        'ignored.tmp',
        'debug.log',
        '.env',
        'assets/blob.bin',
      ]),
    );
  });

  it('does not silently ignore a missing test command', async () => {
    const repo = await makeMinimalRepo('missing-test');
    await new ProjectIndexBuilder().build({ repoPath: repo });

    const commands = await readJson<{
      readonly missing: ReadonlyArray<{ readonly kind: string }>;
    }>(path.join(repo, '.agentflow', 'project-index', 'commands.json'));
    const report = await readJson<{
      readonly status: string;
      readonly missing_commands: ReadonlyArray<{ readonly kind: string }>;
      readonly degradations: ReadonlyArray<{ readonly reason: string }>;
    }>(path.join(repo, '.agentflow', 'project-index', 'build-report.json'));

    expect(commands.missing.map((entry) => entry.kind)).toContain('test');
    expect(report.missing_commands.map((entry) => entry.kind)).toContain(
      'test',
    );
    expect(report.degradations.map((entry) => entry.reason)).toContain(
      'Missing test command.',
    );
    expect(report.status).toBe('degraded');
  });

  it('reuses fresh indexes, supports force rebuilds, and shows module artifacts', async () => {
    const repo = await makeTypeScriptRepo('cli');
    const first = await runCli([
      'project-index',
      'build',
      '--repo',
      repo,
      '--out',
      '.agentflow/custom-index',
    ]);
    const second = await runCli([
      'project-index',
      'build',
      '--repo',
      repo,
      '--out',
      '.agentflow/custom-index',
    ]);
    const forced = await runCli([
      'project-index',
      'build',
      '--repo',
      repo,
      '--out',
      '.agentflow/custom-index',
      '--force',
    ]);
    const shownModules = await runCli([
      'project-index',
      'show',
      '--index-dir',
      path.join(repo, '.agentflow', 'custom-index'),
      '--name',
      'modules',
    ]);

    expect(first.status).toBe('built');
    expect(second.status).toBe('reused');
    expect(forced.status).toBe('built');
    expect(shownModules).toMatchObject({
      name: 'modules',
      modules: expect.arrayContaining([
        expect.objectContaining({ module_id: 'auth' }),
      ]),
    });
  });
});

async function expectProjectIndexFiles(repo: string): Promise<void> {
  const indexDir = path.join(repo, '.agentflow', 'project-index');
  const expected = [
    'manifest.json',
    'overview.json',
    'overview.md',
    'repo-tree.json',
    'commands.json',
    path.join('documents', 'index.json'),
    'build-report.json',
  ];

  for (const file of expected) {
    await expect(
      readFile(path.join(indexDir, file), 'utf8'),
    ).resolves.toBeTypeOf('string');
  }

  const manifest = await readJson<{
    readonly artifacts: ReadonlyArray<{ readonly kind: string }>;
  }>(path.join(indexDir, 'manifest.json'));
  expect(manifest.artifacts.map((artifact) => artifact.kind)).toEqual(
    expect.arrayContaining([
      'overview',
      'repo_tree',
      'commands',
      'module',
      'document_index',
      'build_report',
    ]),
  );
}

async function expectSchemaValidProjectIndex(repo: string): Promise<void> {
  const registry = SchemaRegistry.load();
  const indexDir = path.join(repo, '.agentflow', 'project-index');
  const manifest = await readJson<{
    readonly artifacts: ReadonlyArray<{
      readonly kind: string;
      readonly ref: string;
    }>;
  }>(path.join(indexDir, 'manifest.json'));

  registry.assertProjectIndex('manifest', manifest);

  for (const artifact of manifest.artifacts) {
    const artifactPath = path.join(repo, artifact.ref);
    registry.assertProjectIndex(
      typeForKind(artifact.kind),
      await readJson(artifactPath),
    );
  }
}

function typeForKind(kind: string): ProjectIndexType {
  const mapping: Readonly<Record<string, ProjectIndexType>> = {
    overview: 'overview',
    repo_tree: 'repo_tree',
    commands: 'commands',
    module: 'module',
    document_index: 'document_index',
    document_summary: 'document_summary',
    build_report: 'build_report',
  };
  const type = mapping[kind];
  if (!type) {
    throw new Error(`Unknown Project Index kind in test: ${kind}`);
  }
  return type;
}

async function runCli(
  args: readonly string[],
): Promise<Record<string, unknown>> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  process.exitCode = undefined;

  await createProgram().parseAsync(['node', 'agentflow', ...args]);

  expect(error).not.toHaveBeenCalled();
  expect(process.exitCode).toBeUndefined();

  return JSON.parse(log.mock.calls.at(-1)?.[0] ?? '{}') as Record<
    string,
    unknown
  >;
}

async function makeTypeScriptRepo(name: string): Promise<string> {
  const repo = await makeGitRepo(name);
  await writeText(
    repo,
    '.gitignore',
    'node_modules/\n*.log\n.env\nignored.tmp\n',
  );
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
  await writeBinary(repo, 'assets/blob.bin', Buffer.from([0, 1, 2, 3]));
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'initial']);

  await writeText(repo, 'node_modules/pkg/index.js', 'module.exports = {};\n');
  await writeText(repo, 'ignored.tmp', 'ignored\n');
  await writeText(repo, 'debug.log', 'debug\n');
  await writeText(repo, '.env', 'TOKEN=secret\n');

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
  const repo = await mkdtemp(path.join(tmpdir(), `agentflow-${name}-`));
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

async function writeBinary(
  repo: string,
  relativePath: string,
  content: Buffer,
): Promise<void> {
  const filePath = path.join(repo, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
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
