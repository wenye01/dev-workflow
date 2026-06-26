import type { ArtifactRef } from "./ids.js";
import { hasOnlyKeys, isBoolean, isFiniteNumber, isRecord, isStringArray } from "./schema.js";

export interface Capability {
  work_mode: WorkMode;
  visible_inputs?: VisibleInputs;
  budget?: CapabilityBudget;
  approval?: CapabilityApproval;
  runtime_hints?: RuntimeHints;
}

export type WorkMode = "plan" | "execute" | "review" | "aggregate" | "summarize" | "memory" | "recipe";

export interface VisibleInputs {
  artifacts?: ArtifactRef[];
  include_recent_events?: boolean;
  include_project_index?: boolean;
  include_handoff?: boolean;
}

export interface CapabilityBudget {
  max_tokens?: number;
  max_calls?: number;
  max_wall_time_ms?: number;
}

export interface CapabilityApproval {
  required: boolean;
  reason?: string;
  prompt?: string;
}

export interface RuntimeHints {
  model?: string;
  output_format?: "json" | "markdown" | "patch" | "mixed";
  temperature?: number;
  timeout_ms?: number;
}

const WORK_MODES: readonly WorkMode[] = ["plan", "execute", "review", "aggregate", "summarize", "memory", "recipe"];

export function isCapability(value: unknown): value is Capability {
  if (!isRecord(value) || !hasOnlyKeys(value, ["work_mode", "visible_inputs", "budget", "approval", "runtime_hints"])) {
    return false;
  }

  return (
    isWorkMode(value.work_mode) &&
    (value.visible_inputs === undefined || isVisibleInputs(value.visible_inputs)) &&
    (value.budget === undefined || isCapabilityBudget(value.budget)) &&
    (value.approval === undefined || isCapabilityApproval(value.approval)) &&
    (value.runtime_hints === undefined || isRuntimeHints(value.runtime_hints))
  );
}

function isWorkMode(value: unknown): value is WorkMode {
  return typeof value === "string" && WORK_MODES.includes(value as WorkMode);
}

function isVisibleInputs(value: unknown): value is VisibleInputs {
  if (!isRecord(value) || !hasOnlyKeys(value, ["artifacts", "include_recent_events", "include_project_index", "include_handoff"])) {
    return false;
  }

  return (
    (value.artifacts === undefined || isStringArray(value.artifacts)) &&
    (value.include_recent_events === undefined || isBoolean(value.include_recent_events)) &&
    (value.include_project_index === undefined || isBoolean(value.include_project_index)) &&
    (value.include_handoff === undefined || isBoolean(value.include_handoff))
  );
}

function isCapabilityBudget(value: unknown): value is CapabilityBudget {
  if (!isRecord(value) || !hasOnlyKeys(value, ["max_tokens", "max_calls", "max_wall_time_ms"])) {
    return false;
  }

  return Object.values(value).every((item) => item === undefined || isFiniteNumber(item));
}

function isCapabilityApproval(value: unknown): value is CapabilityApproval {
  if (!isRecord(value) || !hasOnlyKeys(value, ["required", "reason", "prompt"])) {
    return false;
  }

  return (
    isBoolean(value.required) &&
    (value.reason === undefined || typeof value.reason === "string") &&
    (value.prompt === undefined || typeof value.prompt === "string")
  );
}

function isRuntimeHints(value: unknown): value is RuntimeHints {
  if (!isRecord(value) || !hasOnlyKeys(value, ["model", "output_format", "temperature", "timeout_ms"])) {
    return false;
  }

  return (
    (value.model === undefined || typeof value.model === "string") &&
    (value.output_format === undefined ||
      value.output_format === "json" ||
      value.output_format === "markdown" ||
      value.output_format === "patch" ||
      value.output_format === "mixed") &&
    (value.temperature === undefined || isFiniteNumber(value.temperature)) &&
    (value.timeout_ms === undefined || isFiniteNumber(value.timeout_ms))
  );
}
