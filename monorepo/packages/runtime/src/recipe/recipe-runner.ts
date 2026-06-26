import type { ActivationDraft, Directive, RecipeDefinition } from "../contracts/index.js";
import type { RunState } from "../state/index.js";

export type DeterministicRecipeHandler = (state: RunState, api: WorkflowConstructApi) => Directive | Promise<Directive>;

export interface WorkflowConstructApi {
  agent(input: AgentConstructInput): ActivationDraft;
  propose(activations: ActivationDraft[]): Directive;
  done(input?: DoneInput): Directive;
  wait(input: WaitInput): Directive;
  stop(reason: string): Directive;
}

export interface AgentConstructInput {
  ref: string;
  version?: string;
  objective: ActivationDraft["objective"];
  context_request: ActivationDraft["context_request"];
  expected_outputs: ActivationDraft["expected_outputs"];
  capability?: ActivationDraft["capability"];
  metadata?: ActivationDraft["metadata"];
  idempotency_key?: string;
}

export interface DoneInput {
  result_artifact?: string;
}

export interface WaitInput {
  reason: string;
  waiting_for: string[];
}

export class RecipeRunner {
  private readonly deterministicHandlers: Readonly<Record<string, DeterministicRecipeHandler>>;

  constructor(deterministicHandlers: Readonly<Record<string, DeterministicRecipeHandler>> = {}) {
    this.deterministicHandlers = deterministicHandlers;
  }

  async decide(recipe: RecipeDefinition, state: RunState): Promise<Directive> {
    if (recipe.mode !== "deterministic") {
      return createConstructApi(recipe.ref).stop(`Recipe mode is not implemented: ${recipe.mode}.`);
    }

    const handler = this.deterministicHandlers[recipe.ref];
    if (handler === undefined) {
      return createConstructApi(recipe.ref).stop(`No deterministic recipe handler registered for ${recipe.ref}.`);
    }

    return handler(state, createConstructApi(recipe.ref));
  }
}

function createConstructApi(recipeRef: string): WorkflowConstructApi {
  return {
    agent: (input) => ({
      target: {
        kind: "agent",
        ref: input.ref,
        ...(input.version === undefined ? {} : { version: input.version })
      },
      objective: input.objective,
      context_request: input.context_request,
      expected_outputs: input.expected_outputs,
      ...(input.capability === undefined ? {} : { capability: input.capability }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      ...(input.idempotency_key === undefined ? {} : { idempotency_key: input.idempotency_key })
    }),
    propose: (activations) => ({
      kind: "propose",
      idempotency_key: `${recipeRef}:propose:${activations.map(stableActivationKey).join("|")}`,
      activations
    }),
    done: (input = {}) => ({
      kind: "done",
      idempotency_key: `${recipeRef}:done:${input.result_artifact ?? "none"}`,
      ...(input.result_artifact === undefined ? {} : { result_artifact: input.result_artifact })
    }),
    wait: (input) => ({
      kind: "wait",
      idempotency_key: `${recipeRef}:wait:${input.waiting_for.join("|")}`,
      reason: input.reason,
      waiting_for: input.waiting_for
    }),
    stop: (reason) => ({
      kind: "stop",
      idempotency_key: `${recipeRef}:stop:${reason}`,
      reason
    })
  };
}

function stableActivationKey(activation: ActivationDraft): string {
  return [
    activation.target.kind,
    activation.target.ref,
    activation.target.version ?? "",
    activation.objective.title,
    activation.idempotency_key ?? ""
  ].join(":");
}
