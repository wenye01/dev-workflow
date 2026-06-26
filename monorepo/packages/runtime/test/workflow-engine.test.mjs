import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DefaultWorkflowEngine, MapAgentAdapterRegistry } from "../dist/engine/index.js";
import { InMemorySchemaRegistry, StaticAgentRegistry, StaticRecipeRegistry } from "../dist/registry/index.js";
import { createFsRuntimeStorage } from "../dist/storage/fs/index.js";
import { MockAgentAdapter } from "../dist/testing/index.js";

const expectedOutput = {
  ref: "planner/output",
  kind: "role_output",
  schema_id: "agentflow.role_output.v1",
  required: true
};

const agent = {
  ref: "planner",
  version: "1.0.0",
  role: "planner",
  adapter: {
    kind: "mock",
    ref: "mock/default"
  },
  output_schemas: [expectedOutput]
};

const recipe = {
  ref: "recipe/main",
  version: "1.0.0",
  mode: "deterministic"
};

const seedArtifact = {
  ref: "seed/task",
  kind: "task",
  schema_id: "agentflow.task.v1",
  payload: {
    title: "Build a closed loop"
  }
};

async function createHarness(t) {
  const tempDir = await mkdtemp(join(tmpdir(), "agentflow-runtime-engine-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const stores = createFsRuntimeStorage({ rootDir: join(tempDir, ".agentflow") });
  let runSeq = 0;
  let activationSeq = 0;
  const engine = new DefaultWorkflowEngine({
    ...stores,
    agent_registry: new StaticAgentRegistry([agent]),
    recipe_registry: new StaticRecipeRegistry([recipe]),
    schema_registry: new InMemorySchemaRegistry([
      ["agentflow.task.v1", (payload) => typeof payload === "object" && payload !== null],
      [
        "agentflow.role_output.v1",
        (payload) => typeof payload === "object" && payload !== null && "text" in payload
      ]
    ]),
    agent_adapters: new MapAgentAdapterRegistry([["mock/default", new MockAgentAdapter()]]),
    deterministic_recipes: {
      "recipe/main": (state, api) => {
        if (state.artifacts.has("planner/output")) {
          return api.done({ result_artifact: "planner/output" });
        }

        return api.propose([
          api.agent({
            ref: "planner",
            version: "1.0.0",
            objective: {
              title: "Plan work"
            },
            context_request: {
              mode: "implementation",
              artifacts: ["seed/task"],
              include: {
                task: true
              }
            },
            expected_outputs: [expectedOutput],
            idempotency_key: "planner-on-seed"
          })
        ]);
      }
    },
    id_generator: {
      run: () => {
        runSeq += 1;
        return `run_${runSeq}`;
      },
      activation: () => {
        activationSeq += 1;
        return `act_${activationSeq}`;
      }
    },
    clock: {
      now: () => new Date("2026-06-23T00:00:00.000Z")
    }
  });

  return { engine, stores };
}

test("workflow engine runs a single agent tick to completion", async (t) => {
  const { engine, stores } = await createHarness(t);
  const run = await engine.start({
    recipe_ref: "recipe/main",
    seed_artifacts: [seedArtifact]
  });

  const result = await engine.tick(run.id);
  const state = await engine.getState(run.id);
  const events = await stores.event_log.list(run.id);

  assert.equal(result.status, "completed");
  assert.deepEqual(result.ran_activations, ["act_1"]);
  assert.equal(state.run.status, "completed");
  assert.equal(state.artifacts.has("planner/output"), true);
  assert.equal(state.activations.get("act_1").status, "completed");
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "run.started",
      "artifact.written",
      "recipe.directive_recorded",
      "activation.requested",
      "activation.queued",
      "activation.started",
      "artifact.written",
      "budget.charged",
      "activation.completed",
      "recipe.directive_recorded",
      "run.completed"
    ]
  );
});

test("workflow engine records cache hit without rerunning adapter", async (t) => {
  const { stores } = await createHarness(t);
  let runSeq = 0;
  let activationSeq = 0;
  let adapterCalls = 0;
  const engine = new DefaultWorkflowEngine({
    ...stores,
    agent_registry: new StaticAgentRegistry([agent]),
    recipe_registry: new StaticRecipeRegistry([recipe]),
    schema_registry: new InMemorySchemaRegistry([
      ["agentflow.task.v1", (payload) => typeof payload === "object" && payload !== null],
      [
        "agentflow.role_output.v1",
        (payload) => typeof payload === "object" && payload !== null && "text" in payload
      ]
    ]),
    agent_adapters: new MapAgentAdapterRegistry([
      [
        "mock/default",
        new MockAgentAdapter({
          handler: async (input) => {
            adapterCalls += 1;
            return new MockAgentAdapter().run(input);
          }
        })
      ]
    ]),
    deterministic_recipes: {
      "recipe/main": (state, api) => {
        if (state.activations.has("act_2")) {
          return api.done({ result_artifact: "planner/output" });
        }

        return api.propose([
          api.agent({
            ref: "planner",
            version: "1.0.0",
            objective: {
              title: "Plan work"
            },
            context_request: {
              mode: "implementation",
              artifacts: ["seed/task"],
              include: {
                task: true
              }
            },
            expected_outputs: [expectedOutput],
            idempotency_key: state.activations.has("act_1") ? "planner-on-seed-second" : "planner-on-seed"
          })
        ]);
      }
    },
    id_generator: {
      run: () => {
        runSeq += 1;
        return `run_${runSeq}`;
      },
      activation: () => {
        activationSeq += 1;
        return `act_${activationSeq}`;
      }
    },
    clock: {
      now: () => new Date("2026-06-23T00:00:00.000Z")
    }
  });
  const run = await engine.start({
    recipe_ref: "recipe/main",
    seed_artifacts: [seedArtifact]
  });

  const first = await engine.tick(run.id);

  const finalState = await engine.getState(run.id);
  const events = await stores.event_log.list(run.id);

  assert.equal(first.status, "completed");
  assert.deepEqual(first.ran_activations, ["act_1"]);
  assert.equal(adapterCalls, 1);
  assert.equal(finalState.activations.get("act_2").status, "completed");
  assert.deepEqual(finalState.activations.get("act_2").outputs, ["planner/output"]);
  assert.equal(
    events.some((event) => event.type === "activation.cache_hit" && event.activation_id === "act_2"),
    true
  );
});

test("workflow engine default id generator is stable across starts", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "agentflow-runtime-engine-ids-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const stores = createFsRuntimeStorage({ rootDir: join(tempDir, ".agentflow") });
  const engine = new DefaultWorkflowEngine({
    ...stores,
    agent_registry: new StaticAgentRegistry([agent]),
    recipe_registry: new StaticRecipeRegistry([recipe]),
    schema_registry: new InMemorySchemaRegistry([
      ["agentflow.task.v1", (payload) => typeof payload === "object" && payload !== null],
      ["agentflow.role_output.v1", (payload) => typeof payload === "object" && payload !== null]
    ]),
    agent_adapters: new MapAgentAdapterRegistry([["mock/default", new MockAgentAdapter()]]),
    deterministic_recipes: {
      "recipe/main": (_state, api) => api.done()
    }
  });

  const first = await engine.start({
    recipe_ref: "recipe/main",
    seed_artifacts: [seedArtifact]
  });
  const second = await engine.start({
    recipe_ref: "recipe/main",
    seed_artifacts: [seedArtifact]
  });

  assert.equal(first.id, "run_1");
  assert.equal(second.id, "run_2");
});
