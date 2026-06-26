import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

import type {
  AdapterCliArtifactDraft,
  AdapterCliError,
  AdapterCliProgressEvent,
  AdapterCliRequest,
  AdapterCliResult,
  AdapterCliUsage,
  CodexApprovalPolicy,
  CodexSandboxMode
} from "../protocol/index.js";
import type { ProcessRunResult } from "../executor/index.js";
import type { AdapterCliBackend, BackendInvocation } from "./backend.js";

const DEFAULT_OUTPUT_SCHEMA_ID = "agentflow.role_output.v1";
const DEFAULT_OUTPUT_KIND = "role_output";
const CODEX_SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;
const CODEX_APPROVAL_POLICIES = ["untrusted", "on-failure", "on-request", "granular", "never"] as const;

export class CodexCliBackend implements AdapterCliBackend {
  readonly name = "codex-cli";
  readonly aliases = ["codex"];

  createInvocation(request: AdapterCliRequest): BackendInvocation {
    const args = request.mode === "resume" ? ["exec", "resume"] : ["exec"];
    args.push("--json", "--skip-git-repo-check");

    if (request.mode === "new") {
      args.push("--cd", request.cwd);
      const sandbox = resolveSandboxMode(request);
      if (sandbox !== undefined) {
        args.push("--sandbox", sandbox);
      }
    }

    const approvalPolicy = resolveApprovalPolicy(request);
    if (approvalPolicy !== undefined) {
      args.push("-c", `approval_policy='${approvalPolicy}'`);
    }

    if (request.runtime_hints?.dangerously_bypass_approvals_and_sandbox === true) {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    }

    const model = request.runtime_hints?.model;
    if (model !== undefined) {
      args.push("--model", model);
    }

    if (request.args !== undefined) {
      args.push(...request.args);
    }

    if (request.mode === "resume" && request.session_id !== undefined) {
      args.push(request.session_id);
    }

    const stdin = request.input_mode === "stdin" || request.input_mode === "file" ? request.prompt : undefined;
    args.push(stdin === undefined ? request.prompt : "-");

    const invocationCommand = createCodexInvocationCommand(request.command, args);
    return {
      command: invocationCommand.command,
      args: invocationCommand.args,
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
        message: result.error?.message ?? "Codex CLI timed out.",
        retryable: true
      }, progress_events);
    }

    if (result.cancelled || result.error?.code === "CANCELLED") {
      return failedResult(request, "cancelled", 130, {
        code: "CANCELLED",
        message: result.error?.message ?? "Codex CLI invocation was cancelled."
      }, progress_events);
    }

    if (result.error !== undefined) {
      return failedResult(request, "failed", result.exit_code, result.error, progress_events);
    }

    const parsed = parseCodexJsonLines(result.stdout);
    if (!parsed.ok) {
      if (result.stdout.trim().length === 0 && result.exit_code !== 0) {
        return failedResult(request, exitStatusFromCode(result.exit_code), result.exit_code, errorFromExitCode(result), progress_events);
      }

      return failedResult(request, "failed", result.exit_code === 0 ? 1 : result.exit_code, {
        code: result.stdout.trim().length === 0 ? "NO_OUTPUT" : "INVALID_OUTPUT",
        message:
          result.stdout.trim().length === 0
            ? "Codex CLI completed without JSONL output."
            : "Codex CLI output was not valid JSONL.",
        details: {
          parse_error: parsed.error
        }
      }, progress_events);
    }

    const normalized = normalizeCodexEvents(parsed.events);
    if (normalized.error !== undefined) {
      return failedResult(request, "failed", result.exit_code === 0 ? 1 : result.exit_code, normalized.error, progress_events, normalized.session_id);
    }

    if (result.exit_code !== 0) {
      return failedResult(request, exitStatusFromCode(result.exit_code), result.exit_code, errorFromExitCode(result), progress_events, normalized.session_id);
    }

    if (normalized.text === undefined) {
      return failedResult(request, "failed", 1, {
        code: "NO_OUTPUT",
        message: "Codex CLI completed without an agent message."
      }, progress_events, normalized.session_id);
    }

    return {
      schema_version: "adapter-cli/v1",
      invocation_id: request.invocation_id,
      status: "completed",
      exit_code: 0,
      message: normalized.text,
      ...optionalString("session_id", normalized.session_id),
      outputs: createOutputs(request, { text: normalized.text }),
      ...optionalUsage(normalized.usage),
      ...(progress_events.length === 0 ? {} : { progress_events })
    };
  }
}

function resolveSandboxMode(request: AdapterCliRequest): CodexSandboxMode | undefined {
  const sandbox = request.runtime_hints?.sandbox;
  return isCodexSandboxMode(sandbox) ? sandbox : undefined;
}

function resolveApprovalPolicy(request: AdapterCliRequest): CodexApprovalPolicy | undefined {
  const direct = request.runtime_hints?.approval_policy;
  if (isCodexApprovalPolicy(direct)) {
    return direct;
  }

  if (request.runtime_hints?.approval === "never") {
    return "never";
  }

  if (request.runtime_hints?.approval === "on_request") {
    return "on-request";
  }

  return undefined;
}

function createCodexInvocationCommand(
  commandOverride: string | undefined,
  args: string[]
): { command: string; args: string[] } {
  if (commandOverride !== undefined || process.platform !== "win32") {
    return {
      command: commandOverride ?? "codex",
      args
    };
  }

  const powershellShim = findCodexPowerShellShim();
  if (powershellShim !== undefined) {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", powershellShim, ...args]
    };
  }

  return {
    command: "codex",
    args
  };
}

function findCodexPowerShellShim(): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory.length === 0) {
      continue;
    }

    const candidate = join(directory, "codex.ps1");
    if (existsSync(candidate)) {
      return candidate;
    }
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

function parseCodexJsonLines(text: string): { ok: true; events: Record<string, unknown>[] } | { ok: false; error: string } {
  const events: Record<string, unknown>[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!isRecord(parsed)) {
        return { ok: false, error: "JSONL line was not an object." };
      }

      events.push(parsed);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown JSON parse error."
      };
    }
  }

  return events.length === 0 ? { ok: false, error: "No JSONL events found." } : { ok: true, events };
}

function normalizeCodexEvents(events: Record<string, unknown>[]): {
  session_id?: string;
  text?: string;
  usage?: AdapterCliUsage;
  error?: AdapterCliError;
} {
  let sessionId: string | undefined;
  let text: string | undefined;
  let usage: AdapterCliUsage | undefined;
  let error: AdapterCliError | undefined;

  for (const event of events) {
    if (event.type === "thread.started") {
      sessionId = stringField(event, "thread_id") ?? sessionId;
      continue;
    }

    if (event.type === "item.completed") {
      const item = recordField(event, "item");
      if (stringField(item, "type") === "agent_message") {
        text = stringField(item, "text") ?? text;
      } else if (stringField(item, "type") === "error") {
        error = {
          code: "BACKEND_FAILED",
          message: stringField(item, "message") ?? "Codex CLI returned an error item."
        };
      }
      continue;
    }

    if (event.type === "turn.completed") {
      usage = codexUsage(recordField(event, "usage")) ?? usage;
      continue;
    }

    if (event.type === "error") {
      error = {
        code: "BACKEND_FAILED",
        message: stringField(event, "message") ?? "Codex CLI returned an error event."
      };
      continue;
    }

    if (event.type === "turn.failed") {
      const turnError = recordField(event, "error");
      error = {
        code: "BACKEND_FAILED",
        message: stringField(turnError, "message") ?? "Codex CLI turn failed."
      };
    }
  }

  return {
    ...optionalString("session_id", sessionId),
    ...optionalString("text", text),
    ...(usage === undefined ? {} : { usage }),
    ...(error === undefined ? {} : { error })
  };
}

function createOutputs(request: AdapterCliRequest, payload: unknown): AdapterCliArtifactDraft[] {
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

function optionalUsage(usage: AdapterCliUsage | undefined): { usage?: AdapterCliUsage } {
  return usage === undefined ? {} : { usage };
}

function codexUsage(value: Record<string, unknown> | undefined): AdapterCliUsage | undefined {
  if (value === undefined) {
    return undefined;
  }

  const tokens_input = numberField(value, "input_tokens");
  const tokens_output = numberField(value, "output_tokens");
  const tokens_total =
    tokens_input === undefined && tokens_output === undefined ? undefined : (tokens_input ?? 0) + (tokens_output ?? 0);

  const usage: AdapterCliUsage = {
    ...(tokens_input === undefined ? {} : { tokens_input }),
    ...(tokens_output === undefined ? {} : { tokens_output }),
    ...(tokens_total === undefined ? {} : { tokens_total })
  };

  return Object.keys(usage).length === 0 ? undefined : usage;
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
      message: "Codex CLI timed out.",
      retryable: true
    };
  }

  if (result.exit_code === 127) {
    return {
      code: "COMMAND_NOT_FOUND",
      message: "Codex CLI command was not found."
    };
  }

  if (result.exit_code === 130) {
    return {
      code: "CANCELLED",
      message: "Codex CLI invocation was cancelled."
    };
  }

  return {
    code: "BACKEND_FAILED",
    message: firstNonEmptyLine(result.stderr) ?? `Codex CLI exited with code ${result.exit_code}.`,
    details: {
      exit_code: result.exit_code
    }
  };
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

function firstNonEmptyLine(value: string): string | undefined {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

function isCodexSandboxMode(value: unknown): value is CodexSandboxMode {
  return typeof value === "string" && CODEX_SANDBOX_MODES.includes(value as CodexSandboxMode);
}

function isCodexApprovalPolicy(value: unknown): value is CodexApprovalPolicy {
  return typeof value === "string" && CODEX_APPROVAL_POLICIES.includes(value as CodexApprovalPolicy);
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function recordField(record: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const value = record?.[key];
  return isRecord(value) ? value : undefined;
}

function optionalString<Key extends string>(key: Key, value: string | undefined): Partial<Record<Key, string>> {
  return value === undefined ? {} : { [key]: value } as Partial<Record<Key, string>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
