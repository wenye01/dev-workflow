import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { ContextBuilder } from '../../src/context/context-builder.js';
import {
  GeneratorPipeline,
  GeneratorPipelineError,
} from '../../src/generator/generator-pipeline.js';
import { PlannerPipeline } from '../../src/planner/planner-pipeline.js';
import { SchemaRegistry } from '../../src/schemas/registry.js';

const execFileAsync = promisify(execFile);

describe('GeneratorPipeline', () => {
  it('writes generation input, role output, and a fresh Change Package', async () => {
    const setup = await preparePlannedRun(
      'generator-success',
      'success_with_change',
    );
    const result = await new GeneratorPipeline().build(setup.options);
    const registry = SchemaRegistry.load();

    expect(result.mode).toBe('initial');
    expect(result.changedFiles).toContain('src/auth/index.ts');
    expect(result.commitRef?.sha).toMatch(/^[a-f0-9]{7,64}$/);

    registry.assertCanonicalArtifact(
      'generation_input',
      await readJson(path.join(setup.repo, result.generationInputRef)),
    );
    registry.assertCanonicalArtifact(
      'role_output',
      await readJson(path.join(setup.repo, result.roleOutputRef)),
    );
    registry.assertCanonicalArtifact(
      'change_package',
      await readJson(path.join(setup.repo, result.changePackageRef)),
    );

    const changePackage = await readJson<{
      readonly payload: {
        readonly mode: string;
        readonly changed_files: readonly { readonly path: string }[];
      };
    }>(path.join(setup.repo, result.changePackageRef));
    expect(changePackage.payload.mode).toBe('initial');
    expect(changePackage.payload.changed_files[0]?.path).toBe(
      'src/auth/index.ts',
    );
  });

  it('supports fix mode and carries previous failures into generation input', async () => {
    const setup = await preparePlannedRun(
      'generator-fix',
      'success_with_change',
    );
    const result = await new GeneratorPipeline().build({
      ...setup.options,
      mode: 'fix',
      previousFailures: [
        {
          classification: 'test_failure',
          summary: 'Initial implementation failed auth tests.',
        },
      ],
    });
    const generationInput = await readJson<{
      readonly attempt: number;
      readonly fix_round: number;
      readonly payload: {
        readonly mode: string;
        readonly previous_failures: readonly unknown[];
      };
    }>(path.join(setup.repo, result.generationInputRef));

    expect(result.mode).toBe('fix');
    expect(generationInput.attempt).toBe(1);
    expect(generationInput.fix_round).toBe(1);
    expect(generationInput.payload.mode).toBe('fix');
    expect(generationInput.payload.previous_failures).toHaveLength(1);
  });

  it('stops when the generator reports no effective changes', async () => {
    const setup = await preparePlannedRun(
      'generator-no-change',
      'success_no_change',
    );

    await expect(
      new GeneratorPipeline().build(setup.options),
    ).rejects.toMatchObject({
      name: 'GeneratorPipelineError',
      code: 'AGENTFLOW_GENERATOR_NO_EFFECTIVE_CHANGE',
      classification: 'no_effective_change',
    } satisfies Partial<GeneratorPipelineError>);
  });
});

async function preparePlannedRun(name: string, scenario: string) {
  const repo = await makeTypeScriptRepo(name);
  const taskPath = path.join(repo, 'TASK.md');
  const configPath = path.join(repo, 'agentflow.config.yaml');
  await writeText(
    repo,
    'TASK.md',
    '# Fixture Task\n\nImplement auth refresh behavior in src/auth/index.ts and cover it with tests/auth/index.test.ts.\n',
  );
  await writeText(repo, 'agentflow.config.yaml', generatorConfig(scenario));
  await git(repo, ['add', 'TASK.md', 'agentflow.config.yaml']);
  await git(repo, ['commit', '-m', 'add run inputs']);

  const context = await new ContextBuilder().build({
    repoPath: repo,
    taskPath,
    configPath,
    runId: `run-${name}`,
  });
  const planner = await new PlannerPipeline().build({
    repoRoot: context.repoRoot,
    runId: context.runId,
    taskPath,
    context,
  });

  return {
    repo,
    options: {
      repoRoot: context.repoRoot,
      runId: context.runId,
      configPath,
      context,
      planner,
    },
  };
}

async function makeTypeScriptRepo(name: string): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), `agentflow-${name}-`));
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.name', 'Agentflow Test']);
  await git(repo, ['config', 'user.email', 'agentflow-test@example.invalid']);
  await writeJson(repo, 'package.json', {
    name: `fixture-${name}`,
    scripts: {
      test: 'vitest run',
      build: 'tsup',
    },
  });
  await writeText(repo, 'README.md', '# Fixture Service\n');
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

function generatorConfig(scenario: string): string {
  return [
    'providers:',
    '  mock-generator:',
    '    type: mock',
    '    model: mock-generator',
    `    mock_scenario: ${scenario}`,
    'roles:',
    '  generator.implementer:',
    '    provider_candidates:',
    '      - provider: mock-generator',
    '        model: mock-generator',
    '',
  ].join('\n');
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
