import type { AgentName, ProviderConfig } from '../config/config-loader.js';
import type { AgentRunRequest, AgentRunResult } from '../core/types.js';

export interface AgentInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdin?: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly writeStdoutToOutputArtifact?: boolean;
}

export interface AgentAdapter {
  buildInvocation(
    request: AgentRunRequest,
    provider: ProviderConfig,
  ): AgentInvocation;
  run(
    request: AgentRunRequest,
    provider: ProviderConfig,
  ): Promise<AgentRunResult>;
  smokeTest?(provider: ProviderConfig): Promise<AdapterSmokeTestResult>;
}

export interface AdapterSmokeTestResult {
  readonly provider: string;
  readonly agent: AgentName;
  readonly command: string;
  readonly status: 'passed' | 'failed';
  readonly message?: string;
}

export interface InvocationRunOptions {
  readonly timeoutMs?: number;
}
