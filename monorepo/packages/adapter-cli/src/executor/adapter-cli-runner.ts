import { ClaudeCodeBackend } from "../backends/index.js";
import { CodexCliBackend } from "../backends/index.js";
import type { AdapterCliBackend } from "../backends/index.js";
import type { AdapterCliError, AdapterCliRequest, AdapterCliResult } from "../protocol/index.js";
import { createNoopProgressSink, type ProgressSink } from "../progress/index.js";
import { NodeProcessRunner, type ProcessRunner } from "./process-runner.js";

export interface RunAdapterCliRequestOptions {
  backends?: Iterable<AdapterCliBackend>;
  process_runner?: ProcessRunner;
  progress_sink?: ProgressSink;
}

export async function runAdapterCliRequest(
  request: AdapterCliRequest,
  options: RunAdapterCliRequestOptions = {}
): Promise<AdapterCliResult> {
  const backend = resolveBackend(request.backend, options.backends ?? createDefaultBackends());
  if (backend === undefined) {
    return createAdapterCliFailureResult(request.invocation_id, {
      code: "INVALID_INPUT",
      message: `Unsupported adapter-cli backend: ${request.backend}.`,
      details: {
        backend: request.backend
      }
    });
  }

  const progressSink = options.progress_sink ?? createNoopProgressSink();
  progressSink.emit({
    invocation_id: request.invocation_id,
    backend: request.backend,
    phase: "starting",
    message: `Starting backend ${backend.name}.`,
    timestamp: new Date().toISOString()
  });

  const invocation = backend.createInvocation(request);
  const runner = options.process_runner ?? new NodeProcessRunner();
  const processResult = await runner.run({
    ...invocation,
    timeout_ms: request.timeout_ms
  });
  const result = backend.normalizeResult(request, processResult);

  progressSink.emit({
    invocation_id: request.invocation_id,
    backend: request.backend,
    phase: "completed",
    message: `Backend ${backend.name} finished with status ${result.status}.`,
    timestamp: new Date().toISOString()
  });

  return result;
}

export function createDefaultBackends(): AdapterCliBackend[] {
  return [new ClaudeCodeBackend(), new CodexCliBackend()];
}

export function processExitCodeForResult(result: AdapterCliResult): number {
  if (result.status === "completed") {
    return 0;
  }

  if (result.status === "timeout" || result.error?.code === "TIMEOUT") {
    return 124;
  }

  if (result.status === "cancelled" || result.error?.code === "CANCELLED") {
    return 130;
  }

  if (result.error?.code === "COMMAND_NOT_FOUND") {
    return 127;
  }

  return 1;
}

export function createAdapterCliFailureResult(
  invocation_id: string,
  error: AdapterCliError,
  exit_code = 1
): AdapterCliResult {
  return {
    schema_version: "adapter-cli/v1",
    invocation_id,
    status: error.code === "TIMEOUT" ? "timeout" : error.code === "CANCELLED" ? "cancelled" : "failed",
    exit_code,
    message: error.message,
    error
  };
}

function resolveBackend(name: string, backends: Iterable<AdapterCliBackend>): AdapterCliBackend | undefined {
  for (const backend of backends) {
    if (backend.name === name || backend.aliases?.includes(name) === true) {
      return backend;
    }
  }

  return undefined;
}
