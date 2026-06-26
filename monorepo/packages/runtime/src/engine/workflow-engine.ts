import type { Activation, ActivationId, Directive, Policy, RunId, RunRecord, RuntimeError } from "../contracts/index.js";
import { decodeDirective } from "../contracts/index.js";
import { ActivationCache, ActivationFactory, ActivationRunner } from "../activation/index.js";
import { ContextBuilder } from "../context/index.js";
import { RecipeRunner } from "../recipe/index.js";
import { StateProjector, type RunState } from "../state/index.js";
import { SerialActivationQueue } from "../queue/index.js";
import { engineError } from "./errors.js";
import { systemClock, type IdGenerator, type RunTickResult, type RuntimeDependencies, type StartRunInput, type StopRunInput, type WorkflowEngine } from "./types.js";

const defaultPolicy: Policy = {
  allow_directive_from: "recipe_only"
};

export class DefaultWorkflowEngine implements WorkflowEngine {
  private readonly projector: StateProjector;
  private readonly recipeRunner: RecipeRunner;
  private readonly activationFactory: ActivationFactory;
  private readonly activationCache = new ActivationCache();
  private readonly contextBuilder: ContextBuilder;
  private readonly activationRunner: ActivationRunner;
  private readonly idGenerator: IdGenerator;

  constructor(private readonly dependencies: RuntimeDependencies) {
    this.idGenerator = dependencies.id_generator ?? createDefaultIdGenerator();
    this.projector = new StateProjector(dependencies);
    this.recipeRunner = new RecipeRunner(dependencies.deterministic_recipes);
    this.activationFactory = new ActivationFactory({ idGenerator: this.idGenerator });
    this.contextBuilder = new ContextBuilder(dependencies);
    this.activationRunner = new ActivationRunner({
      stores: dependencies,
      agent_registry: dependencies.agent_registry,
      schema_registry: dependencies.schema_registry,
      agent_adapters: dependencies.agent_adapters,
      context_builder: this.contextBuilder
    });
  }

  async start(input: StartRunInput): Promise<RunRecord> {
    const recipe = await this.dependencies.recipe_registry.resolve(input.recipe_ref, input.recipe_version);
    if (recipe === undefined) {
      throw engineError("RECIPE_NOT_FOUND", `Recipe not found: ${input.recipe_ref}.`);
    }

    const now = (this.dependencies.clock ?? systemClock).now().toISOString();
    const run: RunRecord = {
      id: this.idGenerator.run(),
      recipe_ref: input.recipe_ref,
      ...(input.recipe_version === undefined ? {} : { recipe_version: input.recipe_version }),
      status: "created",
      policy: {
        ...defaultPolicy,
        ...input.policy
      },
      created_at: now,
      updated_at: now,
      ...(input.metadata === undefined ? {} : { metadata: input.metadata })
    };

    await this.dependencies.run_store.create(run);
    await this.dependencies.event_log.append(run.id, { run_id: run.id, type: "run.started" });

    for (const artifact of input.seed_artifacts) {
      const stored = await this.dependencies.artifact_store.write({
        ...artifact,
        run_id: run.id
      });
      await this.dependencies.event_log.append(run.id, {
        run_id: run.id,
        type: "artifact.written",
        artifact_ref: stored.ref
      });
    }

    await this.dependencies.run_store.updateStatus(run.id, "running");
    return {
      ...run,
      status: "running"
    };
  }

  async tick(run_id: RunId): Promise<RunTickResult> {
    const ranActivations: ActivationId[] = [];
    let state = await this.projector.project(run_id);

    for (let iteration = 0; iteration < 10; iteration += 1) {
      if (isTerminal(state.run.status)) {
        return { status: state.run.status, ran_activations: ranActivations };
      }

      if (state.waiting.some((waiting) => !waiting.resolved)) {
        return { status: "waiting", ran_activations: ranActivations, waiting: state.waiting };
      }

      const recipe = await this.dependencies.recipe_registry.resolve(state.run.recipe_ref, state.run.recipe_version);
      if (recipe === undefined) {
        const error = { code: "RECIPE_NOT_FOUND", message: `Recipe not found: ${state.run.recipe_ref}.` } satisfies RuntimeError;
        await this.failRun(run_id, error);
        return { status: "failed", ran_activations: ranActivations, failed_error: error };
      }

      const directive = await this.recipeRunner.decide(recipe, state);
      const decoded = decodeDirective(directive);
      if (!decoded.ok) {
        await this.failRun(run_id, decoded.error);
        return { status: "failed", ran_activations: ranActivations, failed_error: decoded.error };
      }

      await this.recordDirective(run_id, decoded.value);
      const outcome = await this.applyDirective(state, recipe.ref, decoded.value);
      ranActivations.push(...outcome.ran_activations);
      state = await this.projector.project(run_id);

      if (outcome.terminal !== undefined) {
        return { status: outcome.terminal, ran_activations: ranActivations };
      }

      if (!outcome.progressed) {
        return { status: state.run.status, ran_activations: ranActivations };
      }
    }

    return { status: state.run.status, ran_activations: ranActivations };
  }

  async stop(input: StopRunInput): Promise<void> {
    await this.dependencies.event_log.append(input.run_id, {
      run_id: input.run_id,
      type: "run.stopped",
      payload: { reason: input.reason }
    });
    await this.dependencies.run_store.updateStatus(input.run_id, "stopped");
  }

  async getState(run_id: RunId): Promise<RunState> {
    return this.projector.project(run_id);
  }

  private async applyDirective(
    state: RunState,
    recipeRef: string,
    directive: Directive
  ): Promise<{ progressed: boolean; ran_activations: ActivationId[]; terminal?: RunTickResult["status"] }> {
    if (directive.kind === "done") {
      await this.dependencies.event_log.append(state.run.id, {
        run_id: state.run.id,
        type: "run.completed",
        ...(directive.result_artifact === undefined ? {} : { artifact_ref: directive.result_artifact })
      });
      await this.dependencies.run_store.updateStatus(state.run.id, "completed");
      return { progressed: true, ran_activations: [], terminal: "completed" };
    }

    if (directive.kind === "stop") {
      await this.dependencies.event_log.append(state.run.id, {
        run_id: state.run.id,
        type: "run.stopped",
        payload: { reason: directive.reason }
      });
      await this.dependencies.run_store.updateStatus(state.run.id, "stopped");
      return { progressed: true, ran_activations: [], terminal: "stopped" };
    }

    if (directive.kind === "wait") {
      await this.dependencies.event_log.append(state.run.id, {
        run_id: state.run.id,
        type: "external.wakeup",
        payload: { reason: directive.reason, waiting_for: directive.waiting_for }
      });
      await this.dependencies.run_store.updateStatus(state.run.id, "waiting");
      return { progressed: true, ran_activations: [], terminal: "waiting" };
    }

    const queue = new SerialActivationQueue();
    let progressed = false;
    for (const [index, draft] of directive.activations.entries()) {
      const activation = this.activationFactory.normalize({
        run_id: state.run.id,
        recipe_ref: recipeRef,
        directive_idempotency_key: directive.idempotency_key,
        index,
        draft,
        state
      });

      const existing = await this.dependencies.activation_store.findByIdempotencyKey(state.run.id, activation.idempotency_key);
      if (existing !== undefined) {
        continue;
      }

      await this.dependencies.activation_store.put(activation);
      await this.dependencies.event_log.append(state.run.id, {
        run_id: state.run.id,
        type: "activation.requested",
        activation_id: activation.id
      });
      progressed = true;

      const cached = this.activationCache.findCompleted(state, activation.cache_key);
      if (cached !== undefined) {
        await this.dependencies.event_log.append(state.run.id, {
          run_id: state.run.id,
          type: "activation.cache_hit",
          activation_id: activation.id,
          payload: {
            cache_key: activation.cache_key,
            reused_activation_id: cached.id
          }
        });
        continue;
      }

      await this.dependencies.event_log.append(state.run.id, {
        run_id: state.run.id,
        type: "activation.queued",
        activation_id: activation.id
      });
      queue.enqueue(activation);
    }

    const ran = await queue.drain(this.activationRunner);
    return { progressed: progressed || ran.length > 0, ran_activations: ran };
  }

  private async recordDirective(run_id: RunId, directive: Directive): Promise<void> {
    await this.dependencies.event_log.append(run_id, {
      run_id,
      type: "recipe.directive_recorded",
      payload: {
        kind: directive.kind,
        idempotency_key: directive.idempotency_key
      }
    });
  }

  private async failRun(run_id: RunId, error: RuntimeError): Promise<void> {
    await this.dependencies.event_log.append(run_id, {
      run_id,
      type: "run.failed",
      payload: { error }
    });
    await this.dependencies.run_store.updateStatus(run_id, "failed");
  }
}

function isTerminal(status: string): boolean {
  return status === "completed" || status === "stopped" || status === "failed";
}

function createDefaultIdGenerator(): IdGenerator {
  let runSeq = 0;
  let activationSeq = 0;
  return {
    run: () => {
      runSeq += 1;
      return `run_${runSeq}`;
    },
    activation: () => {
      activationSeq += 1;
      return `act_${activationSeq}`;
    }
  };
}
