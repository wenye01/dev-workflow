import type { RuntimeError, RuntimeErrorCode } from "./errors.js";

export type SchemaDecodeOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: RuntimeError };

export function schemaError(
  message: string,
  code: RuntimeErrorCode = "SCHEMA_VALIDATION_FAILED",
  details?: Record<string, unknown>
): RuntimeError {
  return {
    code,
    message,
    ...(details === undefined ? {} : { details })
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

export function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(record).every((key) => keys.includes(key));
}

export function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}
