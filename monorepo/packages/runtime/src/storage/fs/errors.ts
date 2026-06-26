export type FsStoreErrorCode =
  | "INVALID_PATH_SEGMENT"
  | "RUN_ALREADY_EXISTS"
  | "RUN_NOT_FOUND"
  | "RUN_ID_MISMATCH"
  | "EVENT_LOG_CORRUPTION"
  | "STORED_RECORD_CORRUPTION"
  | "LOCK_ALREADY_HELD";

export class FsStoreError extends Error {
  readonly code: FsStoreErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: FsStoreErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "FsStoreError";
    this.code = code;
    this.details = details;
  }
}

export function isErrorWithCode(error: unknown, code: string): boolean {
  return hasErrorCode(error) && error.code === code;
}

function hasErrorCode(error: unknown): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  );
}
