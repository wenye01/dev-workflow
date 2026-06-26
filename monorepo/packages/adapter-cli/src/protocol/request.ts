import type { AdapterCliExpectedOutputSpec } from "./artifact.js";

export type AdapterCliSchemaVersion = "adapter-cli/v1";
export type AdapterCliMode = "new" | "resume";
export type AdapterCliInputMode = "stdin" | "argument" | "file";
export type CodexApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "granular" | "never";
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface AdapterCliRuntimeHints {
  model?: string;
  approval?: "default" | "never" | "on_request";
  approval_policy?: CodexApprovalPolicy;
  permission_mode?: "default" | "acceptEdits" | "plan" | "auto" | "dontAsk" | "bypassPermissions";
  max_turns?: number;
  sandbox?: CodexSandboxMode | string;
  dangerously_bypass_approvals_and_sandbox?: boolean;
  max_output_bytes?: number;
  [key: string]: unknown;
}

export interface AdapterCliRequest {
  schema_version: AdapterCliSchemaVersion;
  invocation_id: string;
  backend: string;
  mode: AdapterCliMode;
  session_id?: string;
  cwd: string;
  prompt: string;
  input_mode?: AdapterCliInputMode;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  timeout_ms?: number;
  expected_outputs?: AdapterCliExpectedOutputSpec[];
  runtime_hints?: AdapterCliRuntimeHints;
  progress?: boolean;
  metadata?: Record<string, unknown>;
}
