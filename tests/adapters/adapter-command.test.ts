import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ClaudeAdapter } from '../../src/adapters/claude-adapter.js';
import { CodexAdapter } from '../../src/adapters/codex-adapter.js';
import { parseArtifactRef } from '../../src/artifacts/paths.js';
import type { ProviderConfig } from '../../src/config/config-loader.js';
import type { AgentRunRequest } from '../../src/core/types.js';

describe('agent adapters', () => {
  it('constructs codex exec non-interactive invocations', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'agentflow-codex-'));
    const provider = providerConfig({
      name: 'codex-default',
      type: 'codex',
      command: 'codex',
      sandbox: 'workspace-write',
      approval: 'never',
      outputSchemaPath: 'schemas/llm/llm.role_output.schema.json',
    });
    const request = requestFor({
      provider: 'codex-default',
      model: 'gpt-test',
      cwd,
      outputArtifact: parseArtifactRef('.agentflow/roles/codex-output.json'),
    });

    const invocation = new CodexAdapter().buildInvocation(request, provider);

    expect(invocation.command).toBe('codex');
    expect(invocation.cwd).toBe(cwd);
    expect(invocation.stdin).toBe('Do the work.');
    expect(invocation.args).toEqual(
      expect.arrayContaining([
        'exec',
        '--cd',
        cwd,
        '--model',
        'gpt-test',
        '--sandbox',
        'workspace-write',
        '-c',
        'approval_policy="never"',
        '--output-schema',
        'schemas/llm/llm.role_output.schema.json',
        '--output-last-message',
        path.join(cwd, '.agentflow/roles/codex-output.json'),
        '--json',
        '-',
      ]),
    );
  });

  it('constructs claude print invocations with permission and output options', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'agentflow-claude-'));
    const provider = providerConfig({
      name: 'claude-sonnet',
      type: 'claude',
      command: 'claude',
      providerPermissionMode: 'bypass',
      outputFormat: 'stream-json',
      inputFormat: 'text',
      jsonSchema: {
        type: 'object',
        required: ['status'],
        properties: { status: { type: 'string' } },
      },
      verbose: true,
      debug: 'api',
    });
    const request = requestFor({
      provider: 'claude-sonnet',
      model: 'sonnet',
      cwd,
      outputArtifact: parseArtifactRef('.agentflow/roles/claude-output.json'),
    });

    const invocation = new ClaudeAdapter().buildInvocation(request, provider);

    expect(invocation.command).toBe('claude');
    expect(invocation.cwd).toBe(cwd);
    expect(invocation.writeStdoutToOutputArtifact).toBe(true);
    expect(invocation.args).toEqual(
      expect.arrayContaining([
        '--print',
        '--model',
        'sonnet',
        '--permission-mode',
        'bypassPermissions',
        '--output-format',
        'stream-json',
        '--input-format',
        'text',
        '--json-schema',
        JSON.stringify(provider.jsonSchema),
        '--verbose',
        '--debug',
        'api',
        'Do the work.',
      ]),
    );
  });
});

function providerConfig(
  value: Omit<
    ProviderConfig,
    'enabled' | 'extraArgs' | 'environment' | 'capabilityOverrides' | 'raw'
  > &
    Partial<
      Pick<
        ProviderConfig,
        'enabled' | 'extraArgs' | 'environment' | 'capabilityOverrides' | 'raw'
      >
    >,
): ProviderConfig {
  return {
    enabled: true,
    extraArgs: [],
    environment: {},
    capabilityOverrides: {},
    raw: {},
    ...value,
  };
}

function requestFor(
  value: Pick<AgentRunRequest, 'provider' | 'model' | 'cwd' | 'outputArtifact'>,
): AgentRunRequest {
  return {
    requestId: 'request-command',
    role: 'generator.implementer',
    provider: value.provider,
    model: value.model,
    cwd: value.cwd,
    prompt: 'Do the work.',
    inputArtifacts: [],
    outputArtifact: value.outputArtifact,
  };
}
