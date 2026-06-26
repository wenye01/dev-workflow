import type { AdapterCliError, AdapterCliResult } from "../protocol/index.js";

export type AdapterCliResultParseOutcome =
  | { ok: true; result: AdapterCliResult }
  | { ok: false; error: AdapterCliError };

export function parseAdapterCliResultJson(text: string): AdapterCliResultParseOutcome {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isAdapterCliResult(parsed)) {
      return {
        ok: false,
        error: {
          code: "INVALID_OUTPUT",
          message: "Adapter CLI result did not match the adapter-cli/v1 envelope."
        }
      };
    }

    return { ok: true, result: parsed };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "INVALID_OUTPUT",
        message: "Adapter CLI result JSON could not be parsed.",
        details: {
          parse_error: error instanceof Error ? error.message : "Unknown JSON parse error."
        }
      }
    };
  }
}

function isAdapterCliResult(value: unknown): value is AdapterCliResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    candidate.schema_version === "adapter-cli/v1" &&
    typeof candidate.invocation_id === "string" &&
    isAdapterCliStatus(candidate.status) &&
    typeof candidate.exit_code === "number"
  );
}

function isAdapterCliStatus(value: unknown): value is AdapterCliResult["status"] {
  return value === "completed" || value === "failed" || value === "timeout" || value === "cancelled";
}
