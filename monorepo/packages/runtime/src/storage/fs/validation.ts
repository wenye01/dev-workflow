import type {
  Activation,
  ActivationCreator,
  ActivationTarget,
  Artifact,
  Policy,
  RunRecord,
  RunStatus
} from "../../contracts/index.js";
import { isArtifactKind, isExpectedOutput } from "../../contracts/artifact.js";
import { isCapability } from "../../contracts/capability.js";
import { isContextRequest } from "../../contracts/context.js";
import { hasOnlyKeys, isNonEmptyString, isRecord, isUnknownRecord } from "../../contracts/schema.js";
import { FsStoreError } from "./errors.js";

const RUN_STATUSES: readonly RunStatus[] = ["created", "running", "waiting", "completed", "stopped", "failed"];

export function decodeStoredRunRecord(value: unknown, path: string): RunRecord {
  if (isRunRecord(value)) {
    return value;
  }

  throw new FsStoreError("STORED_RECORD_CORRUPTION", "Stored run record did not match the runtime contract.", {
    path
  });
}

export function decodeStoredArtifact(value: unknown, path: string): Artifact {
  if (isArtifact(value)) {
    return value;
  }

  throw new FsStoreError("STORED_RECORD_CORRUPTION", "Stored artifact did not match the runtime contract.", {
    path
  });
}

export function decodeStoredActivation(value: unknown, path: string): Activation {
  if (isActivation(value)) {
    return value;
  }

  throw new FsStoreError("STORED_RECORD_CORRUPTION", "Stored activation did not match the runtime contract.", {
    path
  });
}

function isRunRecord(value: unknown): value is RunRecord {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["id", "recipe_ref", "recipe_version", "status", "policy", "created_at", "updated_at", "metadata"])
  ) {
    return false;
  }

  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.recipe_ref) &&
    (value.recipe_version === undefined || isNonEmptyString(value.recipe_version)) &&
    isRunStatus(value.status) &&
    isPolicy(value.policy) &&
    isNonEmptyString(value.created_at) &&
    isNonEmptyString(value.updated_at) &&
    (value.metadata === undefined || isUnknownRecord(value.metadata))
  );
}

function isRunStatus(value: unknown): value is RunStatus {
  return typeof value === "string" && RUN_STATUSES.includes(value as RunStatus);
}

function isPolicy(value: unknown): value is Policy {
  if (!isRecord(value) || !hasOnlyKeys(value, ["allow_directive_from", "budget_limits", "workflow_limits"])) {
    return false;
  }

  return (
    value.allow_directive_from === "recipe_only" &&
    (value.budget_limits === undefined || isUnknownRecord(value.budget_limits)) &&
    (value.workflow_limits === undefined || isUnknownRecord(value.workflow_limits))
  );
}

function isArtifact(value: unknown): value is Artifact {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "ref",
      "run_id",
      "kind",
      "schema_id",
      "content_hash",
      "producer_activation_id",
      "payload",
      "storage_uri",
      "views",
      "metadata"
    ])
  ) {
    return false;
  }

  return (
    isNonEmptyString(value.ref) &&
    isNonEmptyString(value.run_id) &&
    isArtifactKind(value.kind) &&
    isNonEmptyString(value.schema_id) &&
    isNonEmptyString(value.content_hash) &&
    (value.producer_activation_id === undefined || isNonEmptyString(value.producer_activation_id)) &&
    (value.storage_uri === undefined || isNonEmptyString(value.storage_uri)) &&
    (value.views === undefined || isArtifactViews(value.views)) &&
    (value.metadata === undefined || isUnknownRecord(value.metadata))
  );
}

function isArtifactViews(value: unknown): value is Artifact["views"] {
  if (!isRecord(value) || !hasOnlyKeys(value, ["markdown", "summary", "diff"])) {
    return false;
  }

  return Object.values(value).every((item) => item === undefined || typeof item === "string");
}

function isActivation(value: unknown): value is Activation {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "id",
      "run_id",
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
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.run_id) &&
    isActivationTarget(value.target) &&
    isActivationObjective(value.objective) &&
    isContextRequest(value.context_request) &&
    Array.isArray(value.expected_outputs) &&
    value.expected_outputs.every(isExpectedOutput) &&
    (value.capability === undefined || isCapability(value.capability)) &&
    (value.parent_activation_id === undefined || isNonEmptyString(value.parent_activation_id)) &&
    isActivationCreator(value.created_by) &&
    isNonEmptyString(value.idempotency_key) &&
    isNonEmptyString(value.cache_key) &&
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

function isActivationObjective(value: unknown): value is Activation["objective"] {
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
