import type { HumanRequestDraft } from "./human.js";

export interface Policy {
  allow_directive_from: "recipe_only";
  budget_limits?: BudgetLimits;
  workflow_limits?: WorkflowLimits;
}

export interface BudgetLimits {
  max_total_tokens?: number;
  max_total_calls?: number;
  max_total_wall_time_ms?: number;
}

export interface WorkflowLimits {
  max_activations?: number;
  max_loop_depth?: number;
  max_recipe_depth?: number;
}

export type PolicyVerdict =
  | { kind: "admit" }
  | { kind: "wait_approval"; request: HumanRequestDraft }
  | { kind: "reject"; reason: string }
  | { kind: "stop"; reason: string };
