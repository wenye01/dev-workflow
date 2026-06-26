import type { ActivationId, ArtifactRef } from "./ids.js";
import {
  hasOnlyKeys,
  isNonEmptyString,
  isRecord,
  isStringArray,
  isUnknownRecord,
  schemaError,
  type SchemaDecodeOutcome
} from "./schema.js";

export interface HumanRequestDraft {
  question: string;
  options?: HumanOption[];
  context_refs: ArtifactRef[];
  requested_by_activation_id?: ActivationId;
  reason?: string;
}

export interface HumanOption {
  id: string;
  label: string;
  description?: string;
}

export interface HumanRequest {
  question: string;
  options?: HumanOption[];
  context_refs: ArtifactRef[];
  requested_by_activation_id?: ActivationId;
  reason?: string;
}

export interface HumanDecision {
  request_ref: ArtifactRef;
  decision: HumanDecisionValue;
  option_id?: string;
  comment?: string;
  decided_at?: string;
  metadata?: Record<string, unknown>;
}

export type HumanDecisionValue = "approved" | "rejected" | "stop";

export function decodeHumanDecision(value: unknown): SchemaDecodeOutcome<HumanDecision> {
  return isHumanDecision(value)
    ? { ok: true, value }
    : {
        ok: false,
        error: schemaError("human_decision payload did not match the runtime contract.")
      };
}

export function isHumanDecision(value: unknown): value is HumanDecision {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["request_ref", "decision", "option_id", "comment", "decided_at", "metadata"])
  ) {
    return false;
  }

  return (
    isNonEmptyString(value.request_ref) &&
    isHumanDecisionValue(value.decision) &&
    (value.option_id === undefined || isNonEmptyString(value.option_id)) &&
    (value.comment === undefined || typeof value.comment === "string") &&
    (value.decided_at === undefined || isNonEmptyString(value.decided_at)) &&
    (value.metadata === undefined || isUnknownRecord(value.metadata))
  );
}

export function isHumanRequestDraft(value: unknown): value is HumanRequestDraft {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["question", "options", "context_refs", "requested_by_activation_id", "reason"])
  ) {
    return false;
  }

  return (
    isNonEmptyString(value.question) &&
    isStringArray(value.context_refs) &&
    (value.options === undefined || (Array.isArray(value.options) && value.options.every(isHumanOption))) &&
    (value.requested_by_activation_id === undefined || isNonEmptyString(value.requested_by_activation_id)) &&
    (value.reason === undefined || typeof value.reason === "string")
  );
}

function isHumanOption(value: unknown): value is HumanOption {
  if (!isRecord(value) || !hasOnlyKeys(value, ["id", "label", "description"])) {
    return false;
  }

  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.label) &&
    (value.description === undefined || typeof value.description === "string")
  );
}

function isHumanDecisionValue(value: unknown): value is HumanDecisionValue {
  return value === "approved" || value === "rejected" || value === "stop";
}
