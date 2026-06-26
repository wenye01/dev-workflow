import type {
  ActivationCacheKey,
  ActivationId,
  AgentRef,
  ArtifactRef,
  EventSeq,
  IdempotencyKey,
  RecipeRef,
  RunId
} from "./ids.js";
import type { Capability } from "./capability.js";
import type { ContextRequest } from "./context.js";
import type { ExpectedOutput } from "./artifact.js";

export interface Activation {
  id: ActivationId;
  run_id: RunId;
  target: ActivationTarget;
  objective: ActivationObjective;
  context_request: ContextRequest;
  expected_outputs: ExpectedOutput[];
  capability?: Capability;
  parent_activation_id?: ActivationId;
  created_by: ActivationCreator;
  idempotency_key: IdempotencyKey;
  cache_key: ActivationCacheKey;
  metadata?: ActivationMetadata;
}

export type ActivationTarget =
  | { kind: "agent"; ref: AgentRef; version?: string }
  | { kind: "recipe"; ref: RecipeRef; version?: string };

export type ActivationKind = ActivationTarget["kind"];

export interface ActivationObjective {
  title: string;
  instructions?: string;
  params?: Record<string, unknown>;
}

export interface ActivationCreator {
  kind: "recipe" | "recipe_activation" | "system";
  ref?: string;
  activation_id?: ActivationId;
}

export interface ActivationMetadata {
  audit_context?: boolean;
  concurrency_group?: string;
  branch_id?: string;
  loop_id?: string;
  labels?: string[];
  session_id?: string;
}

export type ActivationStatus =
  | "proposed"
  | "waiting_approval"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "cancelled";

export interface ActivationState {
  activation: Activation;
  status: ActivationStatus;
  requested_seq?: EventSeq;
  started_seq?: EventSeq;
  completed_seq?: EventSeq;
  failed_seq?: EventSeq;
  outputs: ArtifactRef[];
}
