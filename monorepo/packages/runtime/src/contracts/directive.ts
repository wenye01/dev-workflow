import type { Activation, ActivationCreator, ActivationTarget } from "./activation.js";
import { isExpectedOutput } from "./artifact.js";
import { isCapability } from "./capability.js";
import { isContextRequest } from "./context.js";
import type { ActivationCacheKey, ActivationId, ArtifactRef, IdempotencyKey } from "./ids.js";
import {
  hasOnlyKeys,
  isNonEmptyString,
  isRecord,
  isStringArray,
  isUnknownRecord,
  schemaError,
  type SchemaDecodeOutcome
} from "./schema.js";

export type Directive =
  | { kind: "propose"; idempotency_key: IdempotencyKey; activations: ActivationDraft[] }
  | { kind: "wait"; idempotency_key: IdempotencyKey; reason: string; waiting_for: string[] }
  | { kind: "done"; idempotency_key: IdempotencyKey; result_artifact?: ArtifactRef }
  | { kind: "stop"; idempotency_key: IdempotencyKey; reason: string };

export type ActivationDraft = Omit<
  Activation,
  "id" | "run_id" | "created_by" | "idempotency_key" | "cache_key"
> & {
  id?: ActivationId;
  created_by?: ActivationCreator;
  idempotency_key?: IdempotencyKey;
  cache_key?: ActivationCacheKey;
};

export function decodeDirective(value: unknown): SchemaDecodeOutcome<Directive> {
  return isDirective(value)
    ? { ok: true, value }
    : {
        ok: false,
        error: schemaError("Directive payload did not match the runtime contract.")
      };
}

export function isDirective(value: unknown): value is Directive {
  if (!isRecord(value) || !isNonEmptyString(value.idempotency_key)) {
    return false;
  }

  switch (value.kind) {
    case "propose":
      return (
        hasOnlyKeys(value, ["kind", "idempotency_key", "activations"]) &&
        Array.isArray(value.activations) &&
        value.activations.every(isActivationDraft)
      );
    case "wait":
      return (
        hasOnlyKeys(value, ["kind", "idempotency_key", "reason", "waiting_for"]) &&
        isNonEmptyString(value.reason) &&
        isStringArray(value.waiting_for)
      );
    case "done":
      return (
        hasOnlyKeys(value, ["kind", "idempotency_key", "result_artifact"]) &&
        (value.result_artifact === undefined || isNonEmptyString(value.result_artifact))
      );
    case "stop":
      return (
        hasOnlyKeys(value, ["kind", "idempotency_key", "reason"]) && isNonEmptyString(value.reason)
      );
    default:
      return false;
  }
}

export function isActivationDraft(value: unknown): value is ActivationDraft {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "id",
      "target",
      "objective",
      "context_request",
      "expected_outputs",
      "capability",
      "parent_activation_id",
      "created_by",
      "idempotency_key",
      "cache_key",
      "metadata"
    ])
  ) {
    return false;
  }

  return (
    (value.id === undefined || isNonEmptyString(value.id)) &&
    isActivationTarget(value.target) &&
    isActivationObjective(value.objective) &&
    isContextRequest(value.context_request) &&
    Array.isArray(value.expected_outputs) &&
    value.expected_outputs.every(isExpectedOutput) &&
    (value.capability === undefined || isCapability(value.capability)) &&
    (value.parent_activation_id === undefined || isNonEmptyString(value.parent_activation_id)) &&
    (value.created_by === undefined || isActivationCreator(value.created_by)) &&
    (value.idempotency_key === undefined || isNonEmptyString(value.idempotency_key)) &&
    (value.cache_key === undefined || isNonEmptyString(value.cache_key)) &&
    (value.metadata === undefined || isUnknownRecord(value.metadata))
  );
}

function isActivationTarget(value: unknown): value is ActivationTarget {
  if (!isRecord(value) || !hasOnlyKeys(value, ["kind", "ref", "version"])) {
    return false;
  }

  return (
    (value.kind === "agent" || value.kind === "recipe") &&
    isNonEmptyString(value.ref) &&
    (value.version === undefined || isNonEmptyString(value.version))
  );
}

function isActivationObjective(value: unknown): value is ActivationDraft["objective"] {
  if (!isRecord(value) || !hasOnlyKeys(value, ["title", "instructions", "params"])) {
    return false;
  }

  return (
    isNonEmptyString(value.title) &&
    (value.instructions === undefined || typeof value.instructions === "string") &&
    (value.params === undefined || isUnknownRecord(value.params))
  );
}

function isActivationCreator(value: unknown): value is ActivationCreator {
  if (!isRecord(value) || !hasOnlyKeys(value, ["kind", "ref", "activation_id"])) {
    return false;
  }

  return (
    (value.kind === "recipe" || value.kind === "recipe_activation" || value.kind === "system") &&
    (value.ref === undefined || isNonEmptyString(value.ref)) &&
    (value.activation_id === undefined || isNonEmptyString(value.activation_id))
  );
}
