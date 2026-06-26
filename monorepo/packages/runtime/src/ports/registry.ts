import type { AgentRef, RecipeRef, SchemaId } from "../contracts/ids.js";
import type { AgentDefinition, RecipeDefinition, RuntimeError } from "../contracts/index.js";

export interface AgentRegistry {
  resolve(ref: AgentRef, version?: string): Promise<AgentDefinition | undefined>;
}

export interface RecipeRegistry {
  resolve(ref: RecipeRef, version?: string): Promise<RecipeDefinition | undefined>;
}

export type SchemaValidationOutcome = { ok: true } | { ok: false; error: RuntimeError };

export interface SchemaRegistry {
  validate(input: { schema_id: SchemaId; payload: unknown }): Promise<SchemaValidationOutcome>;
}
