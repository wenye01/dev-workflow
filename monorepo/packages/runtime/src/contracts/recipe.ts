import type { AgentRef, RecipeRef } from "./ids.js";
import type { Capability } from "./capability.js";
import type { ContextRequest } from "./context.js";
import type { ExpectedOutput } from "./artifact.js";

export interface RecipeDefinition {
  ref: RecipeRef;
  version: string;
  mode: RecipeMode;
  limits?: RecipeLimits;
}

export type RecipeMode = "deterministic" | "interpreted_spec" | "recipe_agent";

export interface RecipeLimits {
  max_loop_depth?: number;
  max_activations?: number;
  max_recipe_depth?: number;
}

export interface AgentDefinition {
  ref: AgentRef;
  version: string;
  role: string;
  adapter: AgentAdapterRef;
  default_context?: Partial<ContextRequest>;
  default_capability?: Partial<Capability>;
  output_schemas?: ExpectedOutputTemplate[];
  description?: string;
}

export interface AgentAdapterRef {
  kind: "cli" | "local_function" | "mock";
  ref: string;
}

export type ExpectedOutputTemplate = Partial<ExpectedOutput> & {
  ref: string;
  schema_id: string;
};
