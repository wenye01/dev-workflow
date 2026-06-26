export type AdapterCliErrorCode =
  | "COMMAND_NOT_FOUND"
  | "TIMEOUT"
  | "CANCELLED"
  | "INVALID_INPUT"
  | "INVALID_OUTPUT"
  | "BACKEND_FAILED"
  | "PARSE_FAILED"
  | "NO_OUTPUT";

export interface AdapterCliError {
  code: AdapterCliErrorCode;
  message: string;
  backend?: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}
