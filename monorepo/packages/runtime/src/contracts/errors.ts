export const RUNTIME_ERROR_CODES = [
  "AGENT_NOT_FOUND",
  "RECIPE_NOT_FOUND",
  "ARTIFACT_NOT_FOUND",
  "SCHEMA_NOT_FOUND",
  "SCHEMA_VALIDATION_FAILED",
  "DIRECTIVE_REJECTED",
  "BUDGET_EXHAUSTED",
  "APPROVAL_REJECTED",
  "CONTEXT_BUILD_FAILED",
  "ADAPTER_FAILED",
  "ADAPTER_TIMEOUT",
  "ADAPTER_CANCELLED",
  "INVALID_ARTIFACT",
  "POLICY_DENIED",
  "STORE_WRITE_FAILED",
  "EVENT_APPEND_FAILED",
  "RECOVERY_FAILED",
  "RUNTIME_CORRUPTION",
  "STALE_RUNNING"
] as const;

export type RuntimeErrorCode = (typeof RUNTIME_ERROR_CODES)[number];

export interface RuntimeError {
  code: RuntimeErrorCode;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export function isRuntimeErrorCode(value: unknown): value is RuntimeErrorCode {
  return typeof value === "string" && (RUNTIME_ERROR_CODES as readonly string[]).includes(value);
}

export function isRuntimeError(value: unknown): value is RuntimeError {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isRuntimeErrorCode(value.code) &&
    typeof value.message === "string" &&
    value.message.length > 0 &&
    (value.retryable === undefined || typeof value.retryable === "boolean") &&
    (value.details === undefined || isRecord(value.details))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
