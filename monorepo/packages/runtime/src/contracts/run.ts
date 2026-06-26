import type { RecipeRef, RunId } from "./ids.js";
import type { Policy } from "./policy.js";

export interface RunRecord {
  id: RunId;
  recipe_ref: RecipeRef;
  recipe_version?: string;
  status: RunStatus;
  policy: Policy;
  created_at: string;
  updated_at: string;
  metadata?: Record<string, unknown>;
}

export type RunStatus = "created" | "running" | "waiting" | "completed" | "stopped" | "failed";
