import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createFsRuntimeStorage } from "../dist/storage/fs/index.js";
import { StateProjectionError, StateProjector } from "../dist/state/index.js";

const runRecord = {
  id: "run_state_1",
  recipe_ref: "recipe/main",
  status: "created",
  policy: {
    allow_directive_from: "recipe_only",
    budget_limits: {
      max_total_tokens: 100,
      max_total_calls: 5,
      max_total_wall_time_ms: 5000
    }
  },
  created_at: "2026-06-23T00:00:00.000Z",
  updated_at: "2026-06-23T00:00:00.000Z"
};

const activation = {
  id: "act_1",
  run_id: "run_state_1",
  target: {
    kind: "agent",
    ref: "planner"
  },
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
  expected_outputs: [
    {
      ref: "planner/output",
      kind: "role_output",
      schema_id: "agentflow.role_output.v1",
      required: true
    }
  ],
  created_by: {
    kind: "recipe",
    ref: "recipe/main"
  },
  idempotency_key: "idem_1",
  cache_key: "cache_1"
};

const cacheHitActivation = {
  ...activation,
  id: "act_2",
  idempotency_key: "idem_2",
  cache_key: "cache_1"
};

async function createStores(t) {
  const tempDir = await mkdtemp(join(tmpdir(), "agentflow-runtime-state-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  return createFsRuntimeStorage({ rootDir: join(tempDir, ".agentflow") });
}

test("state projector restores run state from persisted stores", async (t) => {
  const stores = await createStores(t);
  await stores.run_store.create(runRecord);
  await stores.activation_store.put(activation);
  await stores.artifact_store.write({
    ref: "seed/task",
    run_id: "run_state_1",
    kind: "task",
    schema_id: "agentflow.task.v1",
    payload: {
      title: "Build projector"
    }
  });
  await stores.artifact_store.write({
    ref: "planner/output",
    run_id: "run_state_1",
    kind: "role_output",
    schema_id: "agentflow.role_output.v1",
    producer_activation_id: "act_1",
    payload: {
      text: "done"
    }
  });

  await stores.event_log.append("run_state_1", { run_id: "run_state_1", type: "run.started" });
  await stores.event_log.append("run_state_1", {
    run_id: "run_state_1",
    type: "artifact.written",
    artifact_ref: "seed/task"
  });
  await stores.event_log.append("run_state_1", {
    run_id: "run_state_1",
    type: "activation.requested",
    activation_id: "act_1"
  });
  await stores.event_log.append("run_state_1", {
    run_id: "run_state_1",
    type: "activation.queued",
    activation_id: "act_1"
  });
  await stores.event_log.append("run_state_1", {
    run_id: "run_state_1",
    type: "activation.started",
    activation_id: "act_1"
  });
  await stores.event_log.append("run_state_1", {
    run_id: "run_state_1",
    type: "artifact.written",
    activation_id: "act_1",
    artifact_ref: "planner/output"
  });
  await stores.event_log.append("run_state_1", {
    run_id: "run_state_1",
    type: "budget.charged",
    activation_id: "act_1",
    payload: {
      usage: {
        tokens_input: 10,
        tokens_output: 5,
        calls: 1,
        wall_time_ms: 250
      }
    }
  });
  await stores.event_log.append("run_state_1", {
    run_id: "run_state_1",
    type: "activation.completed",
    activation_id: "act_1",
    payload: {
      outputs: ["planner/output"],
      usage: {
        tokens_total: 15,
        calls: 1
      }
    }
  });
  await stores.event_log.append("run_state_1", {
    run_id: "run_state_1",
    type: "phase.started",
    payload: {
      phase_id: "phase-3",
      label: "StateProjector"
    }
  });
  await stores.event_log.append("run_state_1", {
    run_id: "run_state_1",
    type: "progress.logged",
    activation_id: "act_1",
    payload: {
      message: "projector replayed"
    }
  });

  const state = await new StateProjector(stores).project("run_state_1");

  assert.equal(state.run.status, "running");
  assert.equal(state.events.length, 10);
  assert.equal(state.artifacts.has("seed/task"), true);
  assert.equal(state.artifacts.has("planner/output"), true);
  assert.deepEqual(state.activations.get("act_1").outputs, ["planner/output"]);
  assert.equal(state.activations.get("act_1").status, "completed");
  assert.equal(state.budget.tokens_total, 15);
  assert.equal(state.budget.remaining.tokens, 85);
  assert.equal(state.budget.remaining.calls, 4);
  assert.equal(state.workflow.phases["phase-3"].status, "running");
  assert.equal(state.workflow.progress[0].message, "projector replayed");
});

test("state projector ignores artifact files without artifact.written events", async (t) => {
  const stores = await createStores(t);
  await stores.run_store.create(runRecord);
  await stores.artifact_store.write({
    ref: "orphan/output",
    run_id: "run_state_1",
    kind: "role_output",
    schema_id: "agentflow.role_output.v1",
    payload: {
      text: "not visible"
    }
  });
  await stores.event_log.append("run_state_1", { run_id: "run_state_1", type: "run.started" });

  const state = await new StateProjector(stores).project("run_state_1");

  assert.equal(state.artifacts.has("orphan/output"), false);
});

test("state projector projects activation cache hits through reused activation outputs", async (t) => {
  const stores = await createStores(t);
  await stores.run_store.create(runRecord);
  await stores.activation_store.put(activation);
  await stores.activation_store.put(cacheHitActivation);
  await stores.artifact_store.write({
    ref: "planner/output",
    run_id: "run_state_1",
    kind: "role_output",
    schema_id: "agentflow.role_output.v1",
    producer_activation_id: "act_1",
    payload: {
      text: "cached"
    }
  });

  await stores.event_log.append("run_state_1", { run_id: "run_state_1", type: "run.started" });
  await stores.event_log.append("run_state_1", {
    run_id: "run_state_1",
    type: "activation.requested",
    activation_id: "act_1"
  });
  await stores.event_log.append("run_state_1", {
    run_id: "run_state_1",
    type: "artifact.written",
    activation_id: "act_1",
    artifact_ref: "planner/output"
  });
  await stores.event_log.append("run_state_1", {
    run_id: "run_state_1",
    type: "activation.completed",
    activation_id: "act_1",
    payload: {
      outputs: ["planner/output"]
    }
  });
  await stores.event_log.append("run_state_1", {
    run_id: "run_state_1",
    type: "activation.requested",
    activation_id: "act_2"
  });
  await stores.event_log.append("run_state_1", {
    run_id: "run_state_1",
    type: "activation.cache_hit",
    activation_id: "act_2",
    payload: {
      cache_key: "cache_1",
      reused_activation_id: "act_1"
    }
  });

  const state = await new StateProjector(stores).project("run_state_1");

  assert.equal(state.activations.get("act_2").status, "completed");
  assert.deepEqual(state.activations.get("act_2").outputs, ["planner/output"]);
  assert.equal(state.activations.get("act_2").cache_hit.reused_activation_id, "act_1");
});

test("state projector reports runtime corruption for missing referenced records", async (t) => {
  const stores = await createStores(t);
  await stores.run_store.create(runRecord);
  await stores.event_log.append("run_state_1", { run_id: "run_state_1", type: "run.started" });
  await stores.event_log.append("run_state_1", {
    run_id: "run_state_1",
    type: "artifact.written",
    artifact_ref: "missing/output"
  });

  await assert.rejects(() => new StateProjector(stores).project("run_state_1"), {
    name: "StateProjectionError",
    code: "RUNTIME_CORRUPTION"
  });
  await assert.rejects(() => new StateProjector(stores).project("run_state_1"), StateProjectionError);
});

test("state projector keeps diagnostic artifacts out of business-visible artifacts", async (t) => {
  const stores = await createStores(t);
  await stores.run_store.create(runRecord);
  await stores.artifact_store.write({
    ref: "diagnostics/adapter",
    run_id: "run_state_1",
    kind: "diagnostic",
    schema_id: "agentflow.diagnostic.v1",
    payload: {
      stderr: "progress only"
    }
  });
  await stores.event_log.append("run_state_1", { run_id: "run_state_1", type: "run.started" });
  await stores.event_log.append("run_state_1", {
    run_id: "run_state_1",
    type: "artifact.written",
    artifact_ref: "diagnostics/adapter"
  });

  const state = await new StateProjector(stores).project("run_state_1");

  assert.equal(state.artifacts.has("diagnostics/adapter"), false);
  assert.equal(state.diagnostic_artifacts.has("diagnostics/adapter"), true);
});
