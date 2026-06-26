import type {
  ActivationId,
  Artifact,
  ArtifactRef,
  Policy,
  RecipeRef,
  RunId,
  RunRecord,
  RunStatus,
  RuntimeError
} from "../contracts/index.js";
import type { AgentAdapter, AgentRegistry, ArtifactStore, EventLog, RecipeRegistry, RunStore, SchemaRegistry, ActivationStore } from "../ports/index.js";
import type { RunState, WaitingState } from "../state/index.js";
import type { DeterministicRecipeHandler } from "../recipe/index.js";

export interface RuntimeDependencies {
  run_store: RunStore;
  event_log: EventLog;
  artifact_store: ArtifactStore;
  activation_store: ActivationStore;
  agent_registry: AgentRegistry;
  recipe_registry: RecipeRegistry;
  schema_registry: SchemaRegistry;
  agent_adapters: AgentAdapterRegistry;
  deterministic_recipes?: Record<string, DeterministicRecipeHandler>;
  clock?: Clock;
  id_generator?: IdGenerator;
}

export interface AgentAdapterRegistry {
  resolve(ref: { kind: string; ref: string }): AgentAdapter | undefined;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  run(): RunId;
  activation(): ActivationId;
}

export interface StartRunInput {
  recipe_ref: RecipeRef;
  recipe_version?: string;
  seed_artifacts: Array<Omit<Artifact, "run_id" | "content_hash">>;
  policy?: Partial<Policy>;
  metadata?: Record<string, unknown>;
}

export interface RunTickResult {
  status: RunStatus;
  ran_activations: ActivationId[];
  waiting?: WaitingState[];
  stopped_reason?: string;
  failed_error?: RuntimeError;
}

export interface StopRunInput {
  run_id: RunId;
  reason: string;
}

export interface WorkflowEngine {
  start(input: StartRunInput): Promise<RunRecord>;
  tick(run_id: RunId): Promise<RunTickResult>;
  stop(input: StopRunInput): Promise<void>;
  getState(run_id: RunId): Promise<RunState>;
}

export class MapAgentAdapterRegistry implements AgentAdapterRegistry {
  private readonly adapters = new Map<string, AgentAdapter>();

  constructor(entries: Iterable<readonly [string, AgentAdapter]> = []) {
    for (const [ref, adapter] of entries) {
      this.adapters.set(ref, adapter);
    }
  }

  resolve(ref: { kind: string; ref: string }): AgentAdapter | undefined {
    return this.adapters.get(ref.ref) ?? this.adapters.get(`${ref.kind}:${ref.ref}`);
  }
}

export const systemClock: Clock = {
  now: () => new Date()
};
