import type { ArtifactRef, EventSeq } from "./ids.js";
import { hasOnlyKeys, isBoolean, isFiniteNumber, isRecord, isStringArray } from "./schema.js";

export interface ContextRequest {
  mode: ContextMode;
  artifacts?: ArtifactRef[];
  include?: ContextInclude;
  max_tokens?: number;
}

export type ContextMode = "minimal" | "task" | "implementation" | "review" | "aggregation" | "memory" | "recipe";

export interface ContextInclude {
  task?: boolean;
  project_index?: boolean;
  recent_events?: boolean;
  previous_outputs?: boolean;
  handoff_summary?: boolean;
  workflow_state?: boolean;
}

export interface ContextPackage {
  ref?: ArtifactRef;
  mode: ContextMode;
  sections: ContextSection[];
  source_artifacts: ArtifactRef[];
  source_events: EventSeq[];
  estimated_tokens?: number;
}

export interface ContextSection {
  title: string;
  kind: ContextSectionKind;
  content: string;
  source_ref?: ArtifactRef;
}

export type ContextSectionKind = "task" | "artifact" | "event_summary" | "workflow_state" | "handoff" | "instruction";

const CONTEXT_MODES: readonly ContextMode[] = [
  "minimal",
  "task",
  "implementation",
  "review",
  "aggregation",
  "memory",
  "recipe"
];

export function isContextRequest(value: unknown): value is ContextRequest {
  if (!isRecord(value) || !hasOnlyKeys(value, ["mode", "artifacts", "include", "max_tokens"])) {
    return false;
  }

  return (
    isContextMode(value.mode) &&
    (value.artifacts === undefined || isStringArray(value.artifacts)) &&
    (value.include === undefined || isContextInclude(value.include)) &&
    (value.max_tokens === undefined || isFiniteNumber(value.max_tokens))
  );
}

export function isContextMode(value: unknown): value is ContextMode {
  return typeof value === "string" && CONTEXT_MODES.includes(value as ContextMode);
}

function isContextInclude(value: unknown): value is ContextInclude {
  if (!isRecord(value)) {
    return false;
  }

  return (
    hasOnlyKeys(value, [
      "task",
      "project_index",
      "recent_events",
      "previous_outputs",
      "handoff_summary",
      "workflow_state"
    ]) && Object.values(value).every((item) => item === undefined || isBoolean(item))
  );
}
