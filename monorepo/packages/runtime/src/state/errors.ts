import type { RuntimeError, RuntimeErrorCode } from "../contracts/index.js";

export class StateProjectionError extends Error {
  readonly code: RuntimeErrorCode;
  readonly runtime_error: RuntimeError;

  constructor(runtime_error: RuntimeError) {
    super(runtime_error.message);
    this.name = "StateProjectionError";
    this.code = runtime_error.code;
    this.runtime_error = runtime_error;
  }
}

export function projectionCorruption(message: string, details?: Record<string, unknown>): never {
  throw new StateProjectionError({
    code: "RUNTIME_CORRUPTION",
    message,
    ...(details === undefined ? {} : { details })
  });
}
