import type { ActivationId, ArtifactRef, EventSeq, RunId } from "./ids.js";
import {
  hasOnlyKeys,
  isFiniteNumber,
  isNonEmptyString,
  isRecord,
  isUnknownRecord,
  schemaError,
  type SchemaDecodeOutcome
} from "./schema.js";

export interface Event {
  seq: EventSeq;
  run_id: RunId;
  type: EventType;
  activation_id?: ActivationId;
  artifact_ref?: ArtifactRef;
  payload?: Record<string, unknown>;
  recorded_at: string;
}

export const EVENT_TYPES = [
  "run.started",
  "run.completed",
  "run.stopped",
  "run.failed",
  "recipe.directive_recorded",
  "activation.requested",
  "activation.waiting_approval",
  "activation.queued",
  "activation.started",
  "activation.cache_hit",
  "activation.completed",
  "activation.failed",
  "activation.skipped",
  "artifact.written",
  "policy.rejected",
  "policy.stopped",
  "budget.charged",
  "approval.requested",
  "approval.granted",
  "approval.rejected",
  "human.responded",
  "external.wakeup",
  "progress.logged",
  "phase.started",
  "phase.completed"
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export function parseEventJson(text: string): SchemaDecodeOutcome<Event> {
  try {
    return decodeEvent(JSON.parse(text) as unknown);
  } catch (error) {
    return {
      ok: false,
      error: schemaError("Event JSON could not be parsed.", "RUNTIME_CORRUPTION", {
        parse_error: error instanceof Error ? error.message : "Unknown JSON parse error."
      })
    };
  }
}

export function decodeEvent(value: unknown): SchemaDecodeOutcome<Event> {
  return isEvent(value)
    ? { ok: true, value }
    : {
        ok: false,
        error: schemaError("Event record did not match the runtime event envelope.", "RUNTIME_CORRUPTION")
      };
}

export function isEvent(value: unknown): value is Event {
  if (!isRecord(value) || !hasOnlyKeys(value, ["seq", "run_id", "type", "activation_id", "artifact_ref", "payload", "recorded_at"])) {
    return false;
  }

  return (
    isFiniteNumber(value.seq) &&
    isNonEmptyString(value.run_id) &&
    isEventType(value.type) &&
    (value.activation_id === undefined || isNonEmptyString(value.activation_id)) &&
    (value.artifact_ref === undefined || isNonEmptyString(value.artifact_ref)) &&
    (value.payload === undefined || isUnknownRecord(value.payload)) &&
    isNonEmptyString(value.recorded_at)
  );
}

export function isEventType(value: unknown): value is EventType {
  return typeof value === "string" && EVENT_TYPES.includes(value as EventType);
}
