import type { RuntimeError, Usage } from "../contracts/index.js";
import { isRuntimeError } from "../contracts/index.js";
import { isFiniteNumber, isRecord, isStringArray } from "../contracts/schema.js";

export function payloadString(payload: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = payload?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function payloadStringArray(payload: Record<string, unknown> | undefined, key: string): string[] | undefined {
  const value = payload?.[key];
  return isStringArray(value) ? value : undefined;
}

export function payloadNumber(payload: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = payload?.[key];
  return isFiniteNumber(value) ? value : undefined;
}

export function payloadRecord(
  payload: Record<string, unknown> | undefined,
  key: string
): Record<string, unknown> | undefined {
  const value = payload?.[key];
  return isRecord(value) ? value : undefined;
}

export function payloadUsage(payload: Record<string, unknown> | undefined): Usage | undefined {
  const source = payloadRecord(payload, "usage") ?? payload;
  if (source === undefined) {
    return undefined;
  }

  const usage: Usage = {
    ...optionalNumber(source, "tokens_input"),
    ...optionalNumber(source, "tokens_output"),
    ...optionalNumber(source, "tokens_total"),
    ...optionalNumber(source, "calls"),
    ...optionalNumber(source, "wall_time_ms"),
    ...optionalNumber(source, "cost_usd")
  };

  return Object.keys(usage).length === 0 ? undefined : usage;
}

export function payloadRuntimeError(payload: Record<string, unknown> | undefined): RuntimeError | undefined {
  const source = payloadRecord(payload, "error") ?? payload;
  return isRuntimeError(source) ? source : undefined;
}

function optionalNumber(source: Record<string, unknown>, key: keyof Usage): Partial<Usage> {
  const value = payloadNumber(source, key);
  return value === undefined ? {} : { [key]: value };
}
