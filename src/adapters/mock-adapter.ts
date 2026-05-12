import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { resolveArtifactRef } from '../artifacts/paths.js';
import type { ProviderConfig } from '../config/config-loader.js';
import type { AgentRunRequest, AgentRunResult } from '../core/types.js';
import { buildResult } from './process-runner.js';
import type {
  AdapterSmokeTestResult,
  AgentAdapter,
  AgentInvocation,
} from './types.js';

export const MOCK_ADAPTER_SCENARIOS = [
  'success_with_change',
  'success_no_change',
  'schema_failure',
  'business_failure',
  'test_failure',
  'timeout',
  'unsafe',
  'auth_failure',
  'crash_after_artifact_written',
  'crash_after_commit_created',
] as const;

export type MockAdapterScenario = (typeof MOCK_ADAPTER_SCENARIOS)[number];

export class MockAdapter implements AgentAdapter {
  readonly providerType = 'mock' as const;

  buildInvocation(
    request: AgentRunRequest,
    provider: ProviderConfig,
  ): AgentInvocation {
    return {
      command: provider.command,
      args: [
        '--scenario',
        scenarioFor(request, provider),
        '--role',
        request.role,
      ],
      cwd: request.cwd,
      environment: {
        ...provider.environment,
        ...request.environment,
      },
      stdin: request.prompt,
    };
  }

  async run(
    request: AgentRunRequest,
    provider: ProviderConfig,
  ): Promise<AgentRunResult> {
    const startedAt = new Date();
    const scenario = scenarioFor(request, provider);

    if (shouldWriteArtifact(scenario) && request.outputArtifact) {
      await writeMockArtifact(request, provider, scenario);
    }

    return buildResult({
      request,
      provider,
      startedAt,
      ...resultForScenario(request, scenario),
    });
  }

  async smokeTest(provider: ProviderConfig): Promise<AdapterSmokeTestResult> {
    return {
      provider: provider.name,
      type: provider.type,
      command: provider.command,
      status: provider.enabled === false ? 'failed' : 'passed',
      message:
        provider.enabled === false
          ? `Mock provider is disabled: ${provider.name}`
          : undefined,
    };
  }
}

function scenarioFor(
  request: AgentRunRequest,
  provider: ProviderConfig,
): MockAdapterScenario {
  const value =
    stringFromMetadata(request, 'mockScenario') ??
    stringFromMetadata(request, 'mock_scenario') ??
    provider.mockScenario ??
    'success_with_change';

  return isMockScenario(value) ? value : 'success_with_change';
}

function isMockScenario(value: string): value is MockAdapterScenario {
  return MOCK_ADAPTER_SCENARIOS.includes(value as MockAdapterScenario);
}

function stringFromMetadata(
  request: AgentRunRequest,
  key: string,
): string | undefined {
  const value = request.metadata?.[key];
  return typeof value === 'string' ? value : undefined;
}

function shouldWriteArtifact(scenario: MockAdapterScenario): boolean {
  return [
    'success_with_change',
    'success_no_change',
    'business_failure',
    'test_failure',
    'unsafe',
    'crash_after_artifact_written',
  ].includes(scenario);
}

function resultForScenario(
  request: AgentRunRequest,
  scenario: MockAdapterScenario,
): Pick<AgentRunResult, 'status' | 'exitCode' | 'outputArtifact' | 'error'> {
  if (
    scenario === 'success_with_change' ||
    scenario === 'success_no_change' ||
    scenario === 'business_failure' ||
    scenario === 'test_failure' ||
    scenario === 'unsafe'
  ) {
    return {
      status: 'completed',
      exitCode: 0,
      outputArtifact: request.outputArtifact,
    };
  }

  if (scenario === 'schema_failure') {
    return {
      status: 'failed',
      exitCode: 2,
      error: {
        code: 'AGENTFLOW_SCHEMA_FAILURE',
        message: 'Mock adapter produced an invalid schema payload.',
      },
    };
  }

  if (scenario === 'timeout') {
    return {
      status: 'timed_out',
      exitCode: 124,
      error: {
        code: 'AGENTFLOW_PROVIDER_TIMEOUT',
        message: 'Mock adapter timed out.',
      },
    };
  }

  if (scenario === 'auth_failure') {
    return {
      status: 'failed',
      exitCode: 401,
      error: {
        code: 'AGENTFLOW_PROVIDER_AUTH_FAILED',
        message: 'Mock adapter authentication failed.',
      },
    };
  }

  if (scenario === 'crash_after_artifact_written') {
    return {
      status: 'failed',
      exitCode: 70,
      outputArtifact: request.outputArtifact,
      error: {
        code: 'AGENTFLOW_PROVIDER_CRASH_AFTER_ARTIFACT_WRITTEN',
        message: 'Mock adapter crashed after writing an artifact.',
      },
    };
  }

  return {
    status: 'failed',
    exitCode: 71,
    error: {
      code: 'AGENTFLOW_PROVIDER_CRASH_AFTER_COMMIT_CREATED',
      message: 'Mock adapter crashed after a commit was created.',
    },
  };
}

async function writeMockArtifact(
  request: AgentRunRequest,
  provider: ProviderConfig,
  scenario: MockAdapterScenario,
): Promise<void> {
  if (!request.outputArtifact) {
    return;
  }

  const outputPath = resolveArtifactRef(request.cwd, request.outputArtifact);
  const changedPath = firstAllowedPath(request) ?? 'src/index.ts';
  const payload = {
    status:
      scenario === 'unsafe'
        ? 'unsafe'
        : scenario === 'success_no_change'
          ? 'no_change'
          : scenario === 'business_failure' || scenario === 'test_failure'
            ? 'completed_with_issues'
            : 'completed',
    summary: `Mock ${request.role} completed with scenario ${scenario}.`,
    changed_files:
      scenario === 'success_with_change' || scenario === 'test_failure'
        ? [
            {
              path: changedPath,
              change_type: 'modified',
              reason: 'Mock generator reports a deterministic fixture change.',
            },
          ]
        : [],
    verification:
      scenario === 'test_failure'
        ? [
            {
              command: 'npm test',
              kind: 'test',
              status: 'failed',
              summary: 'Mock test failure.',
            },
          ]
        : [],
    criteria_mapping: [],
    evidence: [],
    issues:
      scenario === 'business_failure' || scenario === 'test_failure'
        ? ['Mock role reported an issue.']
        : [],
    risks: [],
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function firstAllowedPath(request: AgentRunRequest): string | undefined {
  const allowedPaths = request.metadata?.allowedPaths;
  if (!Array.isArray(allowedPaths)) {
    return undefined;
  }

  return allowedPaths.find(
    (value): value is string =>
      typeof value === 'string' && !value.includes('*') && value.length > 0,
  );
}
