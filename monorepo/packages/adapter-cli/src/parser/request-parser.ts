import type { AdapterCliError, AdapterCliRequest } from "../protocol/index.js";

export type AdapterCliRequestParseOutcome =
  | { ok: true; request: AdapterCliRequest }
  | { ok: false; error: AdapterCliError };

export function parseAdapterCliRequestJson(text: string): AdapterCliRequestParseOutcome {
  try {
    return decodeAdapterCliRequest(JSON.parse(text) as unknown);
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "Adapter CLI request JSON could not be parsed.",
        details: {
          parse_error: error instanceof Error ? error.message : "Unknown JSON parse error."
        }
      }
    };
  }
}

export function decodeAdapterCliRequest(value: unknown): AdapterCliRequestParseOutcome {
  if (!isAdapterCliRequest(value)) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "Adapter CLI request did not match the adapter-cli/v1 envelope."
      }
    };
  }

  if (value.mode === "resume" && value.session_id === undefined) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "Adapter CLI resume mode requires session_id."
      }
    };
  }

  return { ok: true, request: value };
}

function isAdapterCliRequest(value: unknown): value is AdapterCliRequest {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.schema_version === "adapter-cli/v1" &&
    isNonEmptyString(value.invocation_id) &&
    isNonEmptyString(value.backend) &&
    (value.mode === "new" || value.mode === "resume") &&
    (value.session_id === undefined || isNonEmptyString(value.session_id)) &&
    isNonEmptyString(value.cwd) &&
    isNonEmptyString(value.prompt) &&
    (value.input_mode === undefined || isInputMode(value.input_mode)) &&
    (value.command === undefined || isNonEmptyString(value.command)) &&
    (value.args === undefined || isStringArray(value.args)) &&
    (value.env === undefined || isStringRecord(value.env)) &&
    (value.timeout_ms === undefined || isPositiveNumber(value.timeout_ms)) &&
    (value.expected_outputs === undefined ||
      (Array.isArray(value.expected_outputs) && value.expected_outputs.every(isExpectedOutputSpec))) &&
    (value.runtime_hints === undefined || isRecord(value.runtime_hints)) &&
    (value.progress === undefined || typeof value.progress === "boolean") &&
    (value.metadata === undefined || isRecord(value.metadata))
  );
}

function isExpectedOutputSpec(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  return (
    (value.ref === undefined || isNonEmptyString(value.ref)) &&
    (value.kind === undefined || isNonEmptyString(value.kind)) &&
    (value.schema_id === undefined || isNonEmptyString(value.schema_id)) &&
    (value.required === undefined || typeof value.required === "boolean")
  );
}

function isInputMode(value: unknown): boolean {
  return value === "stdin" || value === "argument" || value === "file";
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
