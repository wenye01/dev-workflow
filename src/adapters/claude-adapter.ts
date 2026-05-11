import type { ProviderConfig } from '../config/config-loader.js';
import type { AgentRunRequest } from '../core/types.js';
import { runCommandSmokeTest, runInvocation } from './process-runner.js';
import type {
  AdapterSmokeTestResult,
  AgentAdapter,
  AgentInvocation,
} from './types.js';

export class ClaudeAdapter implements AgentAdapter {
  readonly providerType = 'claude' as const;

  buildInvocation(
    request: AgentRunRequest,
    provider: ProviderConfig,
  ): AgentInvocation {
    const args = ['--print'];

    if (request.model) {
      args.push('--model', request.model);
    }

    if (provider.providerPermissionMode) {
      args.push(
        '--permission-mode',
        normalizeClaudePermissionMode(provider.providerPermissionMode),
      );
    }

    if (provider.outputFormat) {
      args.push('--output-format', provider.outputFormat);
    }

    if (provider.inputFormat) {
      args.push('--input-format', provider.inputFormat);
    }

    if (provider.jsonSchema !== undefined) {
      args.push('--json-schema', stringifyJsonSchema(provider.jsonSchema));
    }

    if (provider.verbose) {
      args.push('--verbose');
    }

    if (provider.debug === true) {
      args.push('--debug');
    } else if (typeof provider.debug === 'string') {
      args.push('--debug', provider.debug);
    }

    args.push(...provider.extraArgs, request.prompt);

    return {
      command: provider.command,
      args,
      cwd: request.cwd,
      environment: {
        ...provider.environment,
        ...request.environment,
      },
      writeStdoutToOutputArtifact: Boolean(request.outputArtifact),
    };
  }

  async run(request: AgentRunRequest, provider: ProviderConfig) {
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

function normalizeClaudePermissionMode(value: string): string {
  if (value === 'bypass') {
    return 'bypassPermissions';
  }

  if (value === 'accept_edits') {
    return 'acceptEdits';
  }

  if (value === 'dont_ask') {
    return 'dontAsk';
  }

  return value;
}

function stringifyJsonSchema(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}
