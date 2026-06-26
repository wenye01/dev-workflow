import type { ActivationId, ArtifactRef, ContentHash, RunId, SchemaId } from "./ids.js";

export interface Usage {
  tokens_input?: number;
  tokens_output?: number;
  tokens_total?: number;
  calls?: number;
  wall_time_ms?: number;
  cost_usd?: number;
}

export interface ExpectedOutput {
  ref: ArtifactRef;
  kind: ArtifactKind;
  schema_id: SchemaId;
  required: boolean;
}

export interface ExpectedOutputSpec {
  ref?: ArtifactRef;
  kind?: ArtifactKind;
  schema_id?: SchemaId;
  required?: boolean;
}

export interface Artifact<T = unknown> {
  ref: ArtifactRef;
  run_id: RunId;
  kind: ArtifactKind;
  schema_id: SchemaId;
  content_hash: ContentHash;
  producer_activation_id?: ActivationId;
  payload?: T;
  storage_uri?: string;
  views?: ArtifactViews;
  metadata?: Record<string, unknown>;
}

export interface ArtifactViews {
  markdown?: string;
  summary?: string;
  diff?: string;
}

export type ArtifactKind =
  | "task"
  | "project_index"
  | "context_package"
  | "plan"
  | "workflow_spec"
  | "directive"
  | "planner_package"
  | "contract"
  | "role_output"
  | "change_package"
  | "verification_report"
  | "critique"
  | "verdict"
  | "summary"
  | "handoff"
  | "human_request"
  | "human_decision"
  | "final_report"
  | "diagnostic";

export interface ProducedArtifact<T = unknown> {
  ref: ArtifactRef;
  kind: ArtifactKind;
  schema_id: SchemaId;
  payload: T;
  views?: ArtifactViews;
  metadata?: Record<string, unknown>;
}

export const ARTIFACT_KINDS = [
  "task",
  "project_index",
  "context_package",
  "plan",
  "workflow_spec",
  "directive",
  "planner_package",
  "contract",
  "role_output",
  "change_package",
  "verification_report",
  "critique",
  "verdict",
  "summary",
  "handoff",
  "human_request",
  "human_decision",
  "final_report",
  "diagnostic"
] as const satisfies readonly ArtifactKind[];

export function isArtifactKind(value: unknown): value is ArtifactKind {
  return typeof value === "string" && ARTIFACT_KINDS.includes(value as ArtifactKind);
}

export function isExpectedOutput(value: unknown): value is ExpectedOutput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).every((key) => ["ref", "kind", "schema_id", "required"].includes(key)) &&
    typeof candidate.ref === "string" &&
    candidate.ref.length > 0 &&
    isArtifactKind(candidate.kind) &&
    typeof candidate.schema_id === "string" &&
    candidate.schema_id.length > 0 &&
    typeof candidate.required === "boolean"
  );
}
