import type {
  AdapterCliArtifactDraft,
  AdapterCliError,
  AdapterCliProgressEvent,
  AdapterCliRequest,
  AdapterCliResult,
  AdapterCliUsage
} from "../protocol/index.js";
import type { AdapterCliBackend, BackendInvocation } from "./backend.js";
import type { ProcessRunResult } from "../executor/index.js";

const DEFAULT_OUTPUT_SCHEMA_ID = "agentflow.role_output.v1";
const DEFAULT_OUTPUT_KIND = "role_output";

export class ClaudeCodeBackend implements AdapterCliBackend {
  readonly name = "claude-code";
  readonly aliases = ["claude"];

  createInvocation(request: AdapterCliRequest): BackendInvocation {
    const args = ["-p", "--output-format", "json"];

    if (request.mode === "resume" && request.session_id !== undefined) {
      args.push("--resume", request.session_id);
    }

    const model = request.runtime_hints?.model;
    if (model !== undefined) {
      args.push("--model", model);
    }

    const permissionMode = resolvePermissionMode(request);
    if (permissionMode !== undefined) {
      args.push("--permission-mode", permissionMode);
    }

    const maxTurns = request.runtime_hints?.max_turns;
    if (maxTurns !== undefined) {
      args.push("--max-turns", String(maxTurns));
    }

    if (request.input_mode === "stdin" || request.input_mode === "file") {
      args.push("--input-format", "text");
    }

    if (request.args !== undefined) {
      args.push(...request.args);
    }

    const stdin = request.input_mode === "stdin" || request.input_mode === "file" ? request.prompt : undefined;
    if (stdin === undefined) {
      args.push(request.prompt);
    }

    return {
      command: request.command ?? "claude",
      args,
      cwd: request.cwd,
      ...(request.env === undefined ? {} : { env: request.env }),
      ...(stdin === undefined ? {} : { stdin })
    };
  }

  normalizeResult(request: AdapterCliRequest, result: ProcessRunResult): AdapterCliResult {
    const progress_events = createProgressEvents(request, result.stderr);

    if (result.timed_out || result.error?.code === "TIMEOUT") {
      return failedResult(request, "timeout", 124, {
        code: "TIMEOUT",
        message: result.error?.message ?? "Claude Code timed out.",
        retryable: true
      }, progress_events);
    }

    if (result.cancelled || result.error?.code === "CANCELLED") {
      return failedResult(request, "cancelled", 130, {
        code: "CANCELLED",
        message: result.error?.message ?? "Claude Code invocation was cancelled."
      }, progress_events);
    }

    if (result.error !== undefined) {
      return failedResult(request, "failed", result.exit_code, result.error, progress_events);
    }

    if (result.stdout.trim().length === 0) {
      if (result.exit_code !== 0) {
        return failedResult(request, exitStatusFromCode(result.exit_code), result.exit_code, errorFromExitCode(result), progress_events);
      }

      return failedResult(request, "failed", 1, {
        code: "NO_OUTPUT",
        message: "Claude Code completed without JSON output."
      }, progress_events);
    }

    const parsed = parseJsonObject(result.stdout);
    if (!parsed.ok) {
      return failedResult(request, "failed", 1, {
        code: "INVALID_OUTPUT",
        message: "Claude Code output was not valid JSON.",
        details: {
          parse_error: parsed.error
        }
      }, progress_events);
    }

    const envelope = parsed.value;
    if (isClaudeErrorEnvelope(envelope)) {
      return failedResult(request, "failed", result.exit_code === 0 ? 1 : result.exit_code, {
        code: "BACKEND_FAILED",
        message: stringField(envelope, "result") ?? stringField(envelope, "message") ?? "Claude Code returned an error result.",
        details: {
          ...optionalString("type", stringField(envelope, "type")),
          subtype: stringField(envelope, "subtype") ?? "error",
          ...optionalNumber("api_error_status", numberField(envelope, "api_error_status"))
        }
      }, progress_events, stringField(envelope, "session_id"));
    }

    if (result.exit_code !== 0) {
      return failedResult(request, exitStatusFromCode(result.exit_code), result.exit_code, errorFromExitCode(result), progress_events);
    }

    const resultText = stringField(envelope, "result");
    return {
      schema_version: "adapter-cli/v1",
      invocation_id: request.invocation_id,
      status: "completed",
      exit_code: 0,
      ...(resultText === undefined ? {} : { message: resultText }),
      ...optionalString("session_id", stringField(envelope, "session_id")),
      outputs: createOutputs(request, envelope),
      ...optionalUsage(envelope),
      ...(progress_events.length === 0 ? {} : { progress_events })
    };
  }
}

function resolvePermissionMode(request: AdapterCliRequest): string | undefined {
  if (request.runtime_hints?.permission_mode !== undefined) {
    return request.runtime_hints.permission_mode;
  }

  if (request.runtime_hints?.approval === "never") {
    return "dontAsk";
  }

  return undefined;
}

function failedResult(
  request: AdapterCliRequest,
  status: AdapterCliResult["status"],
  exit_code: number,
  error: AdapterCliError,
  progress_events: AdapterCliProgressEvent[] = [],
  session_id = request.mode === "resume" ? request.session_id : undefined
): AdapterCliResult {
  return {
    schema_version: "adapter-cli/v1",
    invocation_id: request.invocation_id,
    status,
    exit_code,
    message: error.message,
    ...optionalString("session_id", session_id),
    error,
    ...(progress_events.length === 0 ? {} : { progress_events })
  };
}

function exitStatusFromCode(exitCode: number): AdapterCliResult["status"] {
  if (exitCode === 124) {
    return "timeout";
  }

  if (exitCode === 130) {
    return "cancelled";
  }

  return "failed";
}

function errorFromExitCode(result: ProcessRunResult): AdapterCliError {
  if (result.exit_code === 124) {
    return {
      code: "TIMEOUT",
      message: "Claude Code timed out.",
      retryable: true
    };
  }

  if (result.exit_code === 127) {
    return {
      code: "COMMAND_NOT_FOUND",
      message: "Claude Code command was not found."
    };
  }

  if (result.exit_code === 130) {
    return {
      code: "CANCELLED",
      message: "Claude Code invocation was cancelled."
    };
  }

  return {
    code: "BACKEND_FAILED",
    message: firstNonEmptyLine(result.stderr) ?? `Claude Code exited with code ${result.exit_code}.`,
    details: {
      exit_code: result.exit_code
    }
  };
}

function createOutputs(request: AdapterCliRequest, envelope: Record<string, unknown>): AdapterCliArtifactDraft[] {
  const payload = payloadFromEnvelope(envelope);
  const expected = request.expected_outputs ?? [];
  if (expected.length === 0) {
    return [
      {
        ref: `${request.invocation_id}/output`,
        kind: DEFAULT_OUTPUT_KIND,
        schema_id: DEFAULT_OUTPUT_SCHEMA_ID,
        payload
      }
    ];
  }

  return expected.map((output, index) => ({
    ref: output.ref ?? `${request.invocation_id}/output${index === 0 ? "" : `-${index + 1}`}`,
    kind: output.kind ?? DEFAULT_OUTPUT_KIND,
    schema_id: output.schema_id ?? DEFAULT_OUTPUT_SCHEMA_ID,
    payload
  }));
}

function payloadFromEnvelope(envelope: Record<string, unknown>): unknown {
  if ("structured_output" in envelope) {
    return envelope.structured_output;
  }

  const resultText = stringField(envelope, "result");
  if (resultText !== undefined) {
    return { text: resultText };
  }

  return envelope;
}

function optionalUsage(envelope: Record<string, unknown>): { usage?: AdapterCliUsage } {
  const usageRecord = recordField(envelope, "usage");
  const tokens_input = numberField(usageRecord, "input_tokens") ?? numberField(usageRecord, "tokens_input");
  const tokens_output = numberField(usageRecord, "output_tokens") ?? numberField(usageRecord, "tokens_output");
  const tokens_total =
    numberField(usageRecord, "total_tokens") ??
    numberField(usageRecord, "tokens_total") ??
    (tokens_input === undefined && tokens_output === undefined ? undefined : (tokens_input ?? 0) + (tokens_output ?? 0));
  const cost_usd = numberField(envelope, "total_cost_usd") ?? numberField(usageRecord, "cost_usd");

  const usage: AdapterCliUsage = {
    ...(tokens_input === undefined ? {} : { tokens_input }),
    ...(tokens_output === undefined ? {} : { tokens_output }),
    ...(tokens_total === undefined ? {} : { tokens_total }),
    ...(cost_usd === undefined ? {} : { cost_usd })
  };

  return Object.keys(usage).length === 0 ? {} : { usage };
}

function createProgressEvents(request: AdapterCliRequest, stderr: string): AdapterCliProgressEvent[] {
  const message = firstNonEmptyLine(stderr);
  if (request.progress !== true || message === undefined) {
    return [];
  }

  return [
    {
      invocation_id: request.invocation_id,
      backend: request.backend,
      phase: "diagnostic",
      message,
      total_events: 1,
      timestamp: new Date().toISOString()
    }
  ];
}

function isClaudeErrorEnvelope(value: Record<string, unknown>): boolean {
  return value.is_error === true || stringField(value, "subtype") === "error";
}

function parseJsonObject(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? { ok: true, value: parsed } : { ok: false, error: "JSON output was not an object." };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown JSON parse error."
    };
  }
}

function firstNonEmptyLine(value: string): string | undefined {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function recordField(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function optionalString<Key extends string>(key: Key, value: string | undefined): Partial<Record<Key, string>> {
  return value === undefined ? {} : { [key]: value } as Partial<Record<Key, string>>;
}

function optionalNumber<Key extends string>(key: Key, value: number | undefined): Partial<Record<Key, number>> {
  return value === undefined ? {} : { [key]: value } as Partial<Record<Key, number>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
