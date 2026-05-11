import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { resolveArtifactRef } from '../artifacts/paths.js';
import type { ProviderConfig } from '../config/config-loader.js';
import type { AgentRunRequest, ArtifactRef } from '../core/types.js';
import { runCommandSmokeTest, runInvocation } from './process-runner.js';
import type {
  AdapterSmokeTestResult,
  AgentAdapter,
  AgentInvocation,
} from './types.js';

export class CodexAdapter implements AgentAdapter {
  readonly providerType = 'codex' as const;

  buildInvocation(
    request: AgentRunRequest,
    provider: ProviderConfig,
  ): AgentInvocation {
    const args = ['exec'];

    args.push('--cd', request.cwd);

    if (request.model) {
      args.push('--model', request.model);
    }

    if (provider.sandbox) {
      args.push('--sandbox', provider.sandbox);
    }

    if (provider.approval) {
      args.push('-c', `approval_policy=${JSON.stringify(provider.approval)}`);
    }

    if (provider.outputSchemaPath) {
      args.push('--output-schema', provider.outputSchemaPath);
    }

    if (request.outputArtifact) {
      args.push(
        '--output-last-message',
        resolveArtifactRef(request.cwd, request.outputArtifact),
      );
    }

    if (provider.jsonl !== false && provider.json !== false) {
      args.push('--json');
    }

    args.push(...provider.extraArgs, '-');

    return {
      command: provider.command,
      args,
      cwd: request.cwd,
      stdin: request.prompt,
      environment: {
        ...provider.environment,
        ...request.environment,
      },
      writeStdoutToOutputArtifact: false,
    };
  }

  async run(request: AgentRunRequest, provider: ProviderConfig) {
    await ensureOutputArtifactParent(request.cwd, request.outputArtifact);
    return await runInvocation(
      request,
      provider,
      this.buildInvocation(request, provider),
    );
  }

  async smokeTest(provider: ProviderConfig): Promise<AdapterSmokeTestResult> {
    return await runCommandSmokeTest(provider);
  }
}

async function ensureOutputArtifactParent(
  cwd: string,
  ref?: ArtifactRef,
): Promise<void> {
  if (!ref) {
    return;
  }

  await mkdir(path.dirname(resolveArtifactRef(cwd, ref)), { recursive: true });
}
