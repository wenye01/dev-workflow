import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { resolveArtifactRef } from '../artifacts/paths.js';
import type { ProviderConfig } from '../config/config-loader.js';
import type { AgentRunRequest, AgentRunResult } from '../core/types.js';
import { isRecord } from '../schemas/validator.js';
import { buildResult } from './process-runner.js';
import type {
  AdapterSmokeTestResult,
  AgentAdapter,
  AgentInvocation,
  InvocationRunOptions,
} from './types.js';

const execFileAsync = promisify(execFile);
const WRAPPER_BINARY =
  process.platform === 'win32' ? 'codeagent-wrapper.exe' : 'codeagent-wrapper';

interface CodeagentWrapperStepResult {
  readonly success: boolean;
  readonly agent?: string;
  readonly model?: string;
  readonly session_id?: string;
  readonly message?: string;
  readonly artifacts?: Record<string, unknown>;
  readonly exit_code: number;
  readonly error?: string;
  readonly log_path?: string;
  readonly duration_ms?: number;
}

interface CapturedProcess {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
}

export class CodeagentWrapperClient implements AgentAdapter {
  buildInvocation(
    request: AgentRunRequest,
    provider: ProviderConfig,
  ): AgentInvocation {
    return {
      command: resolveCodeagentWrapperCommand(provider),
      args: wrapperExtraArgs(provider),
      cwd: request.cwd,
      stdin: JSON.stringify(buildWrapperRequest(request, provider)),
      environment: {
        ...provider.environment,
        ...request.environment,
      },
      writeStdoutToOutputArtifact: false,
    };
  }

  async run(
    request: AgentRunRequest,
    provider: ProviderConfig,
  ): Promise<AgentRunResult> {
    await ensureOutputArtifactParent(request.cwd, request.outputArtifact);
    return await runCodeagentWrapperInvocation(
      request,
      provider,
      this.buildInvocation(request, provider),
    );
  }

  async smokeTest(provider: ProviderConfig): Promise<AdapterSmokeTestResult> {
    return await runCodeagentWrapperSmokeTest(provider);
  }
}

export const CodeagentWrapperAdapter = CodeagentWrapperClient;

export async function runCodeagentWrapperInvocation(
  request: AgentRunRequest,
  provider: ProviderConfig,
  invocation: AgentInvocation,
  options: InvocationRunOptions = {},
): Promise<AgentRunResult> {
  const startedAt = new Date();

  try {
    const captured = await spawnInvocation(
      invocation,
      options.timeoutMs ?? timeoutMsFromRequest(request),
    );
    const step = parseStepResult(captured.stdout);
    const exitCode = step?.exit_code ?? captured.exitCode;
    const failed =
      captured.timedOut ||
      exitCode !== 0 ||
      (step !== undefined && !step.success);

    if (failed) {
      return buildResult({
        request,
        provider,
        startedAt,
        status: captured.timedOut || exitCode === 124 ? 'timed_out' : 'failed',
        exitCode,
        error: {
          code: errorCodeForFailure(exitCode, captured.timedOut),
          message:
            nonEmpty(step?.error) ??
            nonEmpty(captured.stderr) ??
            nonEmpty(captured.stdout) ??
            `codeagent-wrapper exited with code ${exitCode}`,
        },
      });
    }

    const outputArtifact = request.outputArtifact
      ? await writeOutputArtifactFromStep(request, step, captured.stdout)
      : undefined;

    return buildResult({
      request,
      provider,
      startedAt,
      status: 'completed',
      exitCode,
      outputArtifact,
    });
  } catch (error) {
    const failure = normalizeSpawnFailure(error);
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

export async function runCodeagentWrapperSmokeTest(
  provider: ProviderConfig,
): Promise<AdapterSmokeTestResult> {
  const wrapperCommand = resolveCodeagentWrapperCommand(provider);

  try {
    await execFileAsync(wrapperCommand, ['--version'], {
      env: mergeEnvironment(provider.environment),
      timeout: 5_000,
      windowsHide: true,
    });
    await execFileAsync(provider.command, ['--version'], {
      env: mergeEnvironment(provider.environment),
      timeout: 5_000,
      windowsHide: true,
    });

    return {
      provider: provider.name,
      agent: provider.agent,
      command: wrapperCommand,
      status: 'passed',
    };
  } catch (error) {
    return {
      provider: provider.name,
      agent: provider.agent,
      command: wrapperCommand,
      status: 'failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function resolveCodeagentWrapperCommand(
  provider?: ProviderConfig,
): string {
  const explicit =
    provider?.wrapperPath ??
    stringFromRaw(provider, 'wrapper_path') ??
    stringFromRaw(provider, 'codeagent_wrapper_path') ??
    stringFromRaw(provider, 'codeagent_wrapper') ??
    process.env.CODEAGENT_WRAPPER_PATH;

  if (explicit && explicit.trim().length > 0) {
    return explicit;
  }

  for (const candidate of wrapperPathCandidates()) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return WRAPPER_BINARY;
}

function outputSchemaPathFor(
  request: AgentRunRequest,
  provider: ProviderConfig,
): string | undefined {
  return (
    stringFromMetadata(request, 'outputSchemaPath') ??
    stringFromMetadata(request, 'output_schema_path') ??
    provider.outputSchemaPath ??
    (request.outputArtifact ? defaultRoleOutputSchemaPath() : undefined)
  );
}

function defaultRoleOutputSchemaPath(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    path.resolve(here, '../schemas/llm/llm.role_output.schema.json'),
    path.resolve(here, '../../schemas/llm/llm.role_output.schema.json'),
    path.resolve(here, '../../../schemas/llm/llm.role_output.schema.json'),
    path.resolve(process.cwd(), 'schemas/llm/llm.role_output.schema.json'),
  ]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function buildWrapperRequest(
  request: AgentRunRequest,
  provider: ProviderConfig,
): Record<string, unknown> {
  const timeoutMs = timeoutMsFromRequest(request);
  return {
    agent: provider.agent,
    model: request.model,
    prompt: request.prompt,
    cwd: request.cwd,
    mode: stringFromMetadata(request, 'session_id') ? 'resume' : 'new',
    session_id: stringFromMetadata(request, 'session_id') ?? null,
    ...(timeoutMs ? { timeout_ms: timeoutMs } : {}),
    json_output: true,
    ...(outputSchemaPathFor(request, provider)
      ? { output_schema_path: outputSchemaPathFor(request, provider) }
      : {}),
    env: {
      ...provider.environment,
      ...request.environment,
    },
    options: {
      ...(provider.mockScenario
        ? { mock_scenario: provider.mockScenario }
        : {}),
      ...(Array.isArray(request.metadata?.allowedPaths)
        ? { allowed_paths: request.metadata.allowedPaths }
        : {}),
      role: request.role,
      ...(shouldSkipPermissions(provider) ? { skip_permissions: true } : {}),
      ...recordFromMetadata(request, 'options'),
    },
  };
}

function shouldSkipPermissions(provider: ProviderConfig): boolean {
  const mode = provider.providerPermissionMode?.trim().toLowerCase();
  return (
    mode === 'bypass' ||
    mode === 'bypasspermissions' ||
    mode === 'dangerously-skip-permissions' ||
    booleanFromRaw(provider, 'skip_permissions') === true ||
    booleanFromRaw(provider, 'dangerously_skip_permissions') === true
  );
}

function wrapperExtraArgs(provider: ProviderConfig): readonly string[] {
  const value =
    provider.raw.wrapper_extra_args ??
    provider.raw.codeagent_wrapper_extra_args;
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === 'string');
}

function wrapperPathCandidates(): readonly string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const binary = WRAPPER_BINARY;
  const platformBinary = platformReleaseBinary();

  return [
    path.resolve(here, '../../codeagent-wrapper', binary),
    path.resolve(here, '../../../codeagent-wrapper', binary),
    path.resolve(process.cwd(), 'codeagent-wrapper', binary),
    ...(platformBinary
      ? [
          path.resolve(here, '../../bin', platformBinary),
          path.resolve(here, '../../../bin', platformBinary),
          path.resolve(process.cwd(), 'bin', platformBinary),
        ]
      : []),
  ];
}

function platformReleaseBinary(): string | undefined {
  const os =
    process.platform === 'darwin'
      ? 'darwin'
      : process.platform === 'linux'
        ? 'linux'
        : process.platform === 'win32'
          ? 'windows'
          : undefined;
  const arch =
    process.arch === 'x64'
      ? 'amd64'
      : process.arch === 'arm64'
        ? 'arm64'
        : undefined;

  if (!os || !arch) {
    return undefined;
  }

  const suffix = os === 'windows' ? '.exe' : '';
  return `codeagent-wrapper-${os}-${arch}${suffix}`;
}

async function spawnInvocation(
  invocation: AgentInvocation,
  timeoutMs?: number,
): Promise<CapturedProcess> {
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
    child.on('close', (code) => {
      clearOptionalTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        exitCode: timedOut ? 124 : (code ?? 1),
        timedOut,
      });
    });

    if (invocation.stdin !== undefined) {
      child.stdin.end(invocation.stdin);
    } else {
      child.stdin.end();
    }
  });
}

async function writeOutputArtifactFromStep(
  request: AgentRunRequest,
  step: CodeagentWrapperStepResult | undefined,
  stdout: string,
) {
  if (!request.outputArtifact) {
    return undefined;
  }

  const content = outputArtifactContent(step, stdout);
  if (content === undefined) {
    throw Object.assign(
      new Error('codeagent-wrapper completed without output artifact content.'),
      { code: 'AGENTFLOW_PROVIDER_OUTPUT_ARTIFACT_MISSING' },
    );
  }

  const outputPath = resolveArtifactRef(request.cwd, request.outputArtifact);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${content}\n`, 'utf8');
  return request.outputArtifact;
}

function outputArtifactContent(
  step: CodeagentWrapperStepResult | undefined,
  stdout: string,
): string | undefined {
  if (step?.artifacts && Object.keys(step.artifacts).length > 0) {
    return JSON.stringify(step.artifacts, null, 2);
  }

  const message = nonEmpty(step?.message);
  if (message) {
    const extracted = extractJsonObject(message);
    return extracted ? JSON.stringify(extracted, null, 2) : message;
  }

  if (!step) {
    return nonEmpty(stdout);
  }

  return undefined;
}

function parseStepResult(
  stdout: string,
): CodeagentWrapperStepResult | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return undefined;
  }

  const direct = parseStepResultObject(trimmed);
  if (direct) {
    return direct;
  }

  for (const line of trimmed.split(/\r?\n/).reverse()) {
    const parsed = parseStepResultObject(line.trim());
    if (parsed) {
      return parsed;
    }
  }

  return undefined;
}

function parseStepResultObject(
  source: string,
): CodeagentWrapperStepResult | undefined {
  if (!source.startsWith('{') || !source.endsWith('}')) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(source);
    if (!isRecord(parsed)) {
      return undefined;
    }
    if (
      typeof parsed.success !== 'boolean' ||
      typeof parsed.exit_code !== 'number'
    ) {
      return undefined;
    }
    return {
      success: parsed.success,
      session_id:
        typeof parsed.session_id === 'string' ? parsed.session_id : undefined,
      message: typeof parsed.message === 'string' ? parsed.message : undefined,
      artifacts: isRecord(parsed.artifacts) ? parsed.artifacts : undefined,
      exit_code: parsed.exit_code,
      error: typeof parsed.error === 'string' ? parsed.error : undefined,
      log_path:
        typeof parsed.log_path === 'string' ? parsed.log_path : undefined,
      duration_ms:
        typeof parsed.duration_ms === 'number' ? parsed.duration_ms : undefined,
    };
  } catch {
    return undefined;
  }
}

function extractJsonObject(
  source: string,
): Record<string, unknown> | undefined {
  const fenced = /```json\s*([\s\S]*?)\s*```/gi;
  const matches = [...source.matchAll(fenced)];

  for (const match of matches.reverse()) {
    const parsed = parseJsonRecord(match[1]);
    if (parsed) {
      return parsed;
    }
  }

  return parseJsonRecord(source);
}

function parseJsonRecord(source: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(source.trim());
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function errorCodeForFailure(exitCode: number, timedOut: boolean): string {
  if (timedOut || exitCode === 124) {
    return 'AGENTFLOW_PROVIDER_TIMEOUT';
  }

  if (exitCode === 2) {
    return 'AGENTFLOW_SCHEMA_FAILURE';
  }

  if (exitCode === 127) {
    return 'AGENTFLOW_PROVIDER_PROCESS_START_FAILED';
  }

  return 'AGENTFLOW_PROVIDER_PROCESS_FAILED';
}

function normalizeSpawnFailure(error: unknown): {
  readonly code: string;
  readonly message: string;
  readonly exitCode?: number;
  readonly timedOut: boolean;
} {
  const maybe = error as {
    readonly code?: string | number;
    readonly signal?: string;
    readonly killed?: boolean;
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
      message: maybe.message ?? 'codeagent-wrapper could not be started.',
      timedOut: false,
    };
  }

  if (timedOut) {
    return {
      code: 'AGENTFLOW_PROVIDER_TIMEOUT',
      message: maybe.message ?? 'codeagent-wrapper timed out.',
      exitCode,
      timedOut: true,
    };
  }

  if (maybe.code === 'AGENTFLOW_PROVIDER_OUTPUT_ARTIFACT_MISSING') {
    return {
      code: 'AGENTFLOW_PROVIDER_OUTPUT_ARTIFACT_MISSING',
      message:
        maybe.message ??
        'codeagent-wrapper completed without output artifact content.',
      exitCode,
      timedOut: false,
    };
  }

  return {
    code: 'AGENTFLOW_PROVIDER_PROCESS_FAILED',
    message: maybe.message ?? String(error),
    exitCode,
    timedOut: false,
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

async function ensureOutputArtifactParent(
  cwd: string,
  ref?: AgentRunRequest['outputArtifact'],
): Promise<void> {
  if (!ref) {
    return;
  }

  await mkdir(path.dirname(resolveArtifactRef(cwd, ref)), { recursive: true });
}

function clearOptionalTimeout(timer: NodeJS.Timeout | undefined): void {
  if (timer) {
    clearTimeout(timer);
  }
}

function stringFromMetadata(
  request: AgentRunRequest,
  key: string,
): string | undefined {
  const value = request.metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function recordFromMetadata(
  request: AgentRunRequest,
  key: string,
): Record<string, unknown> {
  const value = request.metadata?.[key];
  return isRecord(value) ? value : {};
}

function stringFromRaw(
  provider: ProviderConfig | undefined,
  key: string,
): string | undefined {
  const value = provider?.raw[key] ?? provider?.raw[toCamelCase(key)];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function booleanFromRaw(
  provider: ProviderConfig,
  key: string,
): boolean | undefined {
  const value = provider.raw[key] ?? provider.raw[toCamelCase(key)];
  return typeof value === 'boolean' ? value : undefined;
}

function toCamelCase(value: string): string {
  return value.replace(/_([a-z])/g, (_, letter: string) =>
    letter.toUpperCase(),
  );
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}
