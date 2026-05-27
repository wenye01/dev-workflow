import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CodeagentWrapperClient } from '../../src/adapters/codeagent-wrapper-adapter.js';
import { parseArtifactRef } from '../../src/artifacts/paths.js';
import type { ProviderConfig } from '../../src/config/config-loader.js';
import type { AgentRunRequest } from '../../src/core/types.js';

describe('agent adapters', () => {
  it('constructs wrapper JSON requests', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'agentflow-codex-'));
    const provider = providerConfig({
      name: 'codex-default',
      agent: 'codex',
      command: 'codex',
      wrapperPath: 'codeagent-wrapper-test',
      outputSchemaPath: 'schemas/llm/llm.role_output.schema.json',
    });
    const request = requestFor({
      provider: 'codex-default',
      model: 'gpt-test',
      cwd,
      outputArtifact: parseArtifactRef('.agentflow/roles/codex-output.json'),
    });

    const invocation = new CodeagentWrapperClient().buildInvocation(
      request,
      provider,
    );

    expect(invocation.command).toBe('codeagent-wrapper-test');
    expect(invocation.cwd).toBe(cwd);
    expect(invocation.writeStdoutToOutputArtifact).toBe(false);
    expect(invocation.args).toEqual([]);
    expect(JSON.parse(invocation.stdin ?? '')).toEqual({
      agent: 'codex',
      model: 'gpt-test',
      prompt: 'Do the work.',
      cwd,
      mode: 'new',
      session_id: null,
      json_output: true,
      output_schema_path: 'schemas/llm/llm.role_output.schema.json',
      env: {},
      options: {
        role: 'generator.implementer',
      },
    });
  });

  it('passes generic options in wrapper JSON requests', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'agentflow-claude-'));
    const provider = providerConfig({
      name: 'claude-sonnet',
      agent: 'claude',
      command: 'claude',
      wrapperPath: 'codeagent-wrapper-test',
      providerPermissionMode: 'bypass',
    });
    const request = requestFor({
      provider: 'claude-sonnet',
      model: 'sonnet',
      cwd,
      outputArtifact: parseArtifactRef('.agentflow/roles/claude-output.json'),
    });

    const invocation = new CodeagentWrapperClient().buildInvocation(
      request,
      provider,
    );

    expect(invocation.command).toBe('codeagent-wrapper-test');
    expect(invocation.cwd).toBe(cwd);
    expect(invocation.writeStdoutToOutputArtifact).toBe(false);
    expect(JSON.parse(invocation.stdin ?? '')).toMatchObject({
      agent: 'claude',
      model: 'sonnet',
      prompt: 'Do the work.',
      cwd,
      json_output: true,
      options: {
        skip_permissions: true,
      },
    });
  });

  it('writes structured wrapper artifacts back to the requested artifact path', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'agentflow-wrapper-run-'));
    const wrapperPath = await writeFakeWrapper(cwd);
    const outputArtifact = parseArtifactRef('.agentflow/roles/out.json');
    const provider = providerConfig({
      name: 'codex-default',
      agent: 'codex',
      command: 'codex',
      wrapperPath,
    });

    const result = await new CodeagentWrapperClient().run(
      requestFor({
        provider: 'codex-default',
        model: 'gpt-test',
        cwd,
        outputArtifact,
      }),
      provider,
    );

    expect(result.status).toBe('completed');
    expect(result.outputArtifact).toBe(outputArtifact);
    await expect(
      readFile(path.join(cwd, outputArtifact), 'utf8'),
    ).resolves.toContain('"summary": "Do the work."');
  });
});

async function writeFakeWrapper(dir: string): Promise<string> {
  const modulePath = path.join(dir, 'fake-wrapper.mjs');
  const script = `#!/usr/bin/env node
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  stdin += chunk;
});
process.stdin.on('end', () => {
  const request = JSON.parse(stdin);
  process.stdout.write(JSON.stringify({
    success: true,
    agent: request.agent,
    model: request.model,
    session_id: 'fake-session',
    message: 'done',
    artifacts: {
      status: 'completed',
      summary: request.prompt
    },
    exit_code: 0,
    duration_ms: 1
  }));
});
`;
  await writeFile(modulePath, script, 'utf8');

  if (process.platform === 'win32') {
    const cmdPath = path.join(dir, 'fake-wrapper.cmd');
    await writeFile(
      cmdPath,
      `@echo off\r\n"${process.execPath}" "%~dp0fake-wrapper.mjs" %*\r\n`,
      'utf8',
    );
    return cmdPath;
  }

  await chmod(modulePath, 0o755);
  return modulePath;
}

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
