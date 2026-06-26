import type { AdapterCliError, AdapterCliErrorCode } from "../protocol/index.js";

export function createAdapterCliError(
  code: AdapterCliErrorCode,
  message: string,
  details?: Record<string, unknown>
): AdapterCliError {
  return {
    code,
    message,
    details
  };
}
