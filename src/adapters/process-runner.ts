import { execFile, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { resolveArtifactRef } from '../artifacts/paths.js';
import type { ProviderConfig } from '../config/config-loader.js';
import type { AgentRunRequest, AgentRunResult } from '../core/types.js';
import type {
  AdapterSmokeTestResult,
  AgentInvocation,
  InvocationRunOptions,
} from './types.js';

const execFileAsync = promisify(execFile);

export async function runInvocation(
  request: AgentRunRequest,
  provider: ProviderConfig,
  invocation: AgentInvocation,
  options: InvocationRunOptions = {},
): Promise<AgentRunResult> {
  const startedAt = new Date();

  try {
    const stdout = await spawnInvocation(
      invocation,
      options.timeoutMs ?? timeoutMsFromRequest(request),
    );

    if (invocation.writeStdoutToOutputArtifact && request.outputArtifact) {
      await writeOutputArtifact(request.cwd, request.outputArtifact, stdout);
    }

    return buildResult({
      request,
      provider,
      startedAt,
      status: 'completed',
      exitCode: 0,
      outputArtifact: request.outputArtifact,
    });
  } catch (error) {
    const failure = normalizeProcessFailure(error);
    return buildResult({
      request,
      provider,
      startedAt,
      status: failure.timedOut ? 'timed_out' : 'failed',
      exitCode: failure.exitCode,
      error: {
        code: failure.code,
        message: failure.message,
      },
    });
  }
}

export async function runCommandSmokeTest(
  provider: ProviderConfig,
): Promise<AdapterSmokeTestResult> {
  try {
    await execFileAsync(provider.command, ['--version'], {
      timeout: 5_000,
      windowsHide: true,
    });

    return {
      provider: provider.name,
      type: provider.type,
      command: provider.command,
      status: 'passed',
    };
  } catch (error) {
    return {
      provider: provider.name,
      type: provider.type,
      command: provider.command,
      status: 'failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function buildResult(options: {
  readonly request: AgentRunRequest;
  readonly provider: ProviderConfig;
  readonly startedAt: Date;
  readonly status: AgentRunResult['status'];
  readonly exitCode?: number;
  readonly outputArtifact?: AgentRunResult['outputArtifact'];
  readonly error?: AgentRunResult['error'];
}): AgentRunResult {
  const finishedAt = new Date();
  return {
    requestId: options.request.requestId,
    status: options.status,
    provider: options.provider.name,
    model: options.request.model,
    candidates: [],
    startedAt: options.startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - options.startedAt.getTime(),
    outputArtifact: options.outputArtifact,
    exitCode: options.exitCode,
    error: options.error,
  };
}

function timeoutMsFromRequest(request: AgentRunRequest): number | undefined {
  const value = request.metadata?.timeoutMs ?? request.metadata?.timeout_ms;
  return typeof value === 'number' && value > 0 ? value : undefined;
}

function mergeEnvironment(
  environment: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...environment,
  };
}

async function spawnInvocation(
  invocation: AgentInvocation,
  timeoutMs?: number,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(invocation.command, [...invocation.args], {
      cwd: invocation.cwd,
      env: mergeEnvironment(invocation.environment),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    const timer =
      timeoutMs && timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
          }, timeoutMs)
        : undefined;

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('error', (error) => {
      clearOptionalTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearOptionalTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');

      if (code === 0) {
        resolve(stdout);
        return;
      }

      reject(
        Object.assign(
          new Error(stderr || `Provider exited with code ${code}`),
          {
            code: code ?? undefined,
            signal,
            killed: timedOut,
            stdout,
            stderr,
          },
        ),
      );
    });

    if (invocation.stdin !== undefined) {
      child.stdin.end(invocation.stdin);
    } else {
      child.stdin.end();
    }
  });
}

async function writeOutputArtifact(
  cwd: string,
  ref: AgentRunRequest['outputArtifact'],
  content: string,
): Promise<void> {
  if (!ref) {
    return;
  }

  const outputPath = resolveArtifactRef(cwd, ref);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, content, 'utf8');
}

function normalizeProcessFailure(error: unknown): {
  readonly code: string;
  readonly message: string;
  readonly exitCode?: number;
  readonly timedOut: boolean;
} {
  const maybe = error as {
    readonly code?: string | number;
    readonly signal?: string;
    readonly killed?: boolean;
    readonly stderr?: string;
    readonly stdout?: string;
    readonly message?: string;
  };
  const timedOut = maybe.signal === 'SIGTERM' && maybe.killed === true;
  const exitCode =
    typeof maybe.code === 'number' && Number.isInteger(maybe.code)
      ? maybe.code
      : undefined;

  if (maybe.code === 'ENOENT') {
    return {
      code: 'AGENTFLOW_PROVIDER_PROCESS_START_FAILED',
      message: maybe.message ?? 'Provider process could not be started.',
      timedOut: false,
    };
  }

  if (timedOut) {
    return {
      code: 'AGENTFLOW_PROVIDER_TIMEOUT',
      message: maybe.message ?? 'Provider process timed out.',
      exitCode,
      timedOut: true,
    };
  }

  return {
    code: 'AGENTFLOW_PROVIDER_PROCESS_FAILED',
    message:
      nonEmpty(maybe.stderr) ??
      nonEmpty(maybe.stdout) ??
      maybe.message ??
      String(error),
    exitCode,
    timedOut: false,
  };
}

function clearOptionalTimeout(timer: NodeJS.Timeout | undefined): void {
  if (timer) {
    clearTimeout(timer);
  }
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}
