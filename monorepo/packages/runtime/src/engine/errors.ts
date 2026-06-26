import type { RuntimeError, RuntimeErrorCode } from "../contracts/index.js";

export class WorkflowEngineError extends Error {
  readonly code: RuntimeErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(error: RuntimeError) {
    super(error.message);
    this.name = "WorkflowEngineError";
    this.code = error.code;
    this.details = error.details;
  }
}

export function engineError(
  code: RuntimeErrorCode,
  message: string,
  details?: Record<string, unknown>
): WorkflowEngineError {
  return new WorkflowEngineError({
    code,
    message,
    ...(details === undefined ? {} : { details })
  });
}
