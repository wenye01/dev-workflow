export type Brand<Value, Name extends string> = Value & {
  readonly __brand: Name;
};

export type RunId = Brand<string, 'RunId'>;
export type UnitId = Brand<string, 'UnitId'>;
export type ArtifactRef = Brand<`.agentflow${string}`, 'ArtifactRef'>;
export type GitSha = Brand<string, 'GitSha'>;

export interface CommitRef {
  readonly sha: GitSha;
  readonly ref?: string;
  readonly subject?: string;
  readonly committedAt?: string;
}

export interface AgentRunRequest {
  readonly requestId: string;
  readonly role: string;
  readonly provider: string;
  readonly model: string;
  readonly cwd: string;
  readonly prompt: string;
  readonly inputArtifacts: readonly ArtifactRef[];
  readonly outputArtifact?: ArtifactRef;
  readonly environment?: Readonly<Record<string, string>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type AgentRunStatus = 'completed' | 'failed' | 'cancelled' | 'timed_out';

export interface AgentRunCandidate {
  readonly provider: string;
  readonly model: string;
  readonly reason?: string;
}

export interface AgentRunUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

export interface AgentRunResult {
  readonly requestId: string;
  readonly status: AgentRunStatus;
  readonly provider: string;
  readonly model: string;
  readonly candidates: readonly AgentRunCandidate[];
  readonly selectionReason?: string;
  readonly fallbackReason?: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly outputArtifact?: ArtifactRef;
  readonly exitCode?: number;
  readonly usage?: AgentRunUsage;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

export function asRunId(value: string): RunId {
  return value as RunId;
}

export function asUnitId(value: string): UnitId {
  return value as UnitId;
}

export function asGitSha(value: string): GitSha {
  return value as GitSha;
}
