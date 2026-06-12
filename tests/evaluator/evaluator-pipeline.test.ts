import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { ContextBuilder } from '../../src/context/context-builder.js';
import { EvaluatorPipeline } from '../../src/evaluator/evaluator-pipeline.js';
import { GeneratorPipeline } from '../../src/generator/generator-pipeline.js';
import { PlannerPipeline } from '../../src/planner/planner-pipeline.js';
import { SchemaRegistry } from '../../src/schemas/registry.js';

const execFileAsync = promisify(execFile);

describe('EvaluatorPipeline', () => {
  it('writes evaluation input, evaluator report, and pass decision', async () => {
    const setup = await prepareGeneratedRun('evaluator-pass', {
      testScript: 'node -e "process.exit(0)"',
    });
    const result = await new EvaluatorPipeline().build(setup.options);
    const registry = SchemaRegistry.load();

    expect(result.decision).toBe('pass');
    expect(result.verificationResults[0]?.status).toBe('passed');

    registry.assertCanonicalArtifact(
      'evaluation_input',
      await readJson(path.join(setup.repo, result.evaluationInputRef)),
    );
    registry.assertCanonicalArtifact(
      'evaluator_report',
      await readJson(path.join(setup.repo, result.evaluatorReportRef)),
    );
    registry.assertCanonicalArtifact(
      'unit_decision',
      await readJson(path.join(setup.repo, result.unitDecisionRef)),
    );

    const decision = await readJson<{
      readonly payload: { readonly decision: string };
    }>(path.join(setup.repo, result.unitDecisionRef));
    expect(decision.payload.decision).toBe('pass');
  });

  it('routes failed verification to generator fix while fix budget remains', async () => {
    const setup = await prepareGeneratedRun('evaluator-fix', {
      testScript: 'node -e "process.exit(1)"',
    });
    const result = await new EvaluatorPipeline().build(setup.options);

    expect(result.decision).toBe('fix');
    expect(result.verificationResults[0]?.status).toBe('failed');

    const decision = await readJson<{
      readonly payload: {
        readonly failure_classification: string;
        readonly next_pipeline: Record<string, unknown> | null;
      };
    }>(path.join(setup.repo, result.unitDecisionRef));
    expect(decision.payload.failure_classification).toBe('test_failure');
    expect(decision.payload.next_pipeline).toMatchObject({
      module: 'generator',
      mode: 'fix',
    });
  });

  it('accepts budgets greater than one from PlannerPipeline options', async () => {
    const setup = await prepareGeneratedRun('evaluator-higher-budgets', {
      testScript: 'node -e "process.exit(1)"',
      maxFixRounds: 2,
      maxEvaluatorRetries: 2,
    });
    const result = await new EvaluatorPipeline().build({
      ...setup.options,
      maxFixRounds: 2,
      maxEvaluatorRetries: 2,
    });

    expect(result.unitDecision.max_fix_rounds).toBe(2);
    expect(setup.options.planner.maxEvaluatorRetries).toBe(2);
    expect(setup.options.planner.maxFixRounds).toBe(2);
  });
});

async function prepareGeneratedRun(
  name: string,
  options: {
    readonly testScript: string;
    readonly maxFixRounds?: number;
    readonly maxEvaluatorRetries?: number;
  },
) {
  const repo = await makeTypeScriptRepo(name, options.testScript);
  const taskPath = path.join(repo, 'TASK.md');
  const configPath = path.join(repo, 'agentflow.config.yaml');
  await writeText(
    repo,
    'TASK.md',
    '# Fixture Task\n\nImplement auth refresh behavior in src/auth/index.ts and cover it with tests/auth/index.test.ts.\n',
  );
  await writeText(repo, 'agentflow.config.yaml', agentflowConfig());
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
    maxFixRounds: options.maxFixRounds,
    maxEvaluatorRetries: options.maxEvaluatorRetries,
  });
  const generator = await new GeneratorPipeline().build({
    repoRoot: context.repoRoot,
    runId: context.runId,
    configPath,
    context,
    planner,
  });

  return {
    repo,
    options: {
      repoRoot: context.repoRoot,
      runId: context.runId,
      configPath,
      context,
      planner,
      generator,
    },
  };
}

async function makeTypeScriptRepo(
  name: string,
  testScript: string,
): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), `agentflow-${name}-`));
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.name', 'Agentflow Test']);
  await git(repo, ['config', 'user.email', 'agentflow-test@example.invalid']);
  await writeJson(repo, 'package.json', {
    name: `fixture-${name}`,
    scripts: {
      test: testScript,
      build: 'node -e "process.exit(0)"',
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

function agentflowConfig(): string {
  return [
    'providers:',
    '  mock-generator:',
    '    agent: mock',
    '    model: mock-generator',
    '    mock_scenario: success_with_change',
    '  mock-evaluator:',
    '    agent: mock',
    '    model: mock-evaluator',
    '    mock_scenario: success_no_change',
    'roles:',
    '  generator.implementer:',
    '    provider_candidates:',
    '      - provider: mock-generator',
    '        model: mock-generator',
    '  evaluator.contract_checker:',
    '    provider_candidates:',
    '      - provider: mock-evaluator',
    '        model: mock-evaluator',
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
