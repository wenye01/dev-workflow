import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { RouterRunner } from '../../src/routers/router-runner.js';
import {
  parseArtifactRef,
  resolveArtifactRef,
} from '../../src/artifacts/paths.js';
import { SchemaRegistry } from '../../src/schemas/registry.js';

describe('RouterRunner', () => {
  it('writes validated routing decisions and role run requests', async () => {
    const runRoot = await mkdtemp(path.join(tmpdir(), 'agentflow-router-'));
    await writeConfig(runRoot);
    const runner = new RouterRunner(SchemaRegistry.load());

    const result = await runner.route({
      runRoot,
      configPath: path.join(runRoot, 'agentflow.config.yaml'),
      requestId: 'request-001',
      role: 'planner.router',
      prompt: 'route the work',
      outputArtifact: parseArtifactRef(
        '.agentflow/routing/raw-router-output.json',
      ),
      rawPayload: await readJsonFixture('valid-router-dispatch.json'),
      roleOutputArtifacts: {
        'generator.implementer': parseArtifactRef(
          '.agentflow/units/unit-001/roles/generator-output.json',
        ),
      },
      selectedProjectContext: {
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
      requiredOutputSchemas: {
        'generator.implementer': 'agentflow.schema.artifact.role_output.v1',
      },
    });

    expect(result.routingDecision.artifact).toMatchObject({
      artifact_type: 'routing_decision',
      payload: {
        mode: 'initial',
      },
    });
    expect(result.roleRunRequests).toHaveLength(1);
    expect(result.roleRunRequests[0]?.artifact).toMatchObject({
      artifact_type: 'role_run_request',
      payload: {
        request_id: 'request-001-1',
        role: 'generator.implementer',
        output_artifact:
          '.agentflow/units/unit-001/roles/generator-output.json',
      },
    });

    const registry = SchemaRegistry.load();
    registry.assertCanonicalArtifact(
      'routing_decision',
      JSON.parse(
        await readFile(
          resolveArtifactRef(
            runRoot,
            parseArtifactRef('.agentflow/routing/decision.json'),
          ),
          'utf8',
        ),
      ),
    );
    registry.assertCanonicalArtifact(
      'role_run_request',
      JSON.parse(
        await readFile(
          resolveArtifactRef(
            runRoot,
            parseArtifactRef(
              '.agentflow/routing/requests/1-generator.implementer.json',
            ),
          ),
          'utf8',
        ),
      ),
    );
  });

  it('writes validated aggregate artifacts', async () => {
    const runRoot = await mkdtemp(
      path.join(tmpdir(), 'agentflow-router-aggregate-'),
    );
    await writeConfig(runRoot);
    const runner = new RouterRunner(SchemaRegistry.load());

    const result = await runner.aggregate({
      runRoot,
      configPath: path.join(runRoot, 'agentflow.config.yaml'),
      requestId: 'request-002',
      role: 'planner.router',
      prompt: 'aggregate the plan',
      outputType: 'planner_package',
      outputArtifact: parseArtifactRef('.agentflow/planner/package.json'),
      rawPayload: await readJsonFixture('valid-planner-package.json'),
    });

    expect(result.output.artifact).toMatchObject({
      artifact_type: 'planner_package',
      payload: {
        goal: 'Implement refresh-token handling.',
      },
    });
  });
});

async function writeConfig(runRoot: string): Promise<void> {
  await mkdir(runRoot, { recursive: true });
  await writeFile(
    path.join(runRoot, 'agentflow.config.yaml'),
    [
      'providers:',
      '  mock-router:',
      '    agent: mock',
      '    model: mock-router',
      'roles:',
      '  planner.router:',
      '    provider_candidates:',
      '      - provider: mock-router',
      '        model: mock-router',
      '',
    ].join('\n'),
    'utf8',
  );
}

async function readJsonFixture(file: string): Promise<unknown> {
  return JSON.parse(
    await readFile(
      path.join(process.cwd(), 'fixtures', 'payloads', file),
      'utf8',
    ),
  ) as unknown;
}
