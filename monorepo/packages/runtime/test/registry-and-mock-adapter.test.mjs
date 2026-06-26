import assert from "node:assert/strict";
import test from "node:test";

import { InMemorySchemaRegistry, StaticAgentRegistry, StaticRecipeRegistry } from "../dist/registry/index.js";
import { MockAgentAdapter, createMockAgentAdapter } from "../dist/testing/index.js";

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

const activation = {
  id: "act_1",
  run_id: "run_1",
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
  expected_outputs: [expectedOutput],
  created_by: {
    kind: "recipe",
    ref: "recipe/main"
  },
  idempotency_key: "idem_1",
  cache_key: "cache_1"
};

const context = {
  mode: "implementation",
  sections: [],
  source_artifacts: [],
  source_events: []
};

test("static registries resolve definitions by ref and exact version", async () => {
  const agents = new StaticAgentRegistry([agent]);
  const recipes = new StaticRecipeRegistry([recipe]);

  assert.equal(await agents.resolve("planner"), agent);
  assert.equal(await agents.resolve("planner", "1.0.0"), agent);
  assert.equal(await agents.resolve("planner", "2.0.0"), undefined);
  assert.equal(await recipes.resolve("recipe/main"), recipe);
  assert.equal(await recipes.resolve("missing"), undefined);
});

test("static registries require explicit versions for ambiguous refs", async () => {
  const agents = new StaticAgentRegistry([
    agent,
    {
      ...agent,
      version: "2.0.0"
    }
  ]);
  const recipes = new StaticRecipeRegistry([
    recipe,
    {
      ...recipe,
      version: "2.0.0"
    }
  ]);

  assert.equal(await agents.resolve("planner"), undefined);
  assert.equal((await agents.resolve("planner", "2.0.0")).version, "2.0.0");
  assert.equal(await recipes.resolve("recipe/main"), undefined);
  assert.equal((await recipes.resolve("recipe/main", "2.0.0")).version, "2.0.0");
});

test("static registries reject duplicate ref and version entries", () => {
  assert.throws(
    () =>
      new StaticAgentRegistry([
        agent,
        {
          ...agent
        }
      ]),
    /Duplicate agent definition/u
  );

  assert.throws(
    () =>
      new StaticRecipeRegistry([
        recipe,
        {
          ...recipe
        }
      ]),
    /Duplicate recipe definition/u
  );
});

test("in-memory schema registry validates expected output payloads", async () => {
  const schemas = new InMemorySchemaRegistry([
    [
      "agentflow.role_output.v1",
      (payload) => typeof payload === "object" && payload !== null && "text" in payload
    ]
  ]);

  const valid = await schemas.validate({
    schema_id: expectedOutput.schema_id,
    payload: {
      text: "done"
    }
  });
  const invalid = await schemas.validate({
    schema_id: expectedOutput.schema_id,
    payload: {
      value: "missing text"
    }
  });
  const missing = await schemas.validate({
    schema_id: "agentflow.unknown.v1",
    payload: {
      text: "done"
    }
  });

  assert.equal(valid.ok, true);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "SCHEMA_VALIDATION_FAILED");
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "SCHEMA_NOT_FOUND");
});

test("mock agent adapter returns deterministic role_output drafts", async () => {
  const adapter = new MockAgentAdapter();
  const result = await adapter.run({
    activation,
    agent,
    context,
    expected_outputs: [expectedOutput]
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(result.usage, { calls: 1 });
  assert.equal(result.outputs.length, 1);
  assert.deepEqual(result.outputs[0], {
    ref: "planner/output",
    kind: "role_output",
    schema_id: "agentflow.role_output.v1",
    payload: {
      text: "Mock output for Plan work.",
      agent_ref: "planner",
      activation_id: "act_1"
    },
    metadata: {
      mock: true
    }
  });
});

test("createMockAgentAdapter preserves handler override behavior", async () => {
  const adapter = createMockAgentAdapter((input) => ({
    status: "completed",
    outputs: [
      {
        ref: input.expected_outputs[0].ref,
        kind: input.expected_outputs[0].kind,
        schema_id: input.expected_outputs[0].schema_id,
        payload: {
          custom: true
        }
      }
    ],
    usage: {
      calls: 2
    }
  }));

  const result = await adapter.run({
    activation,
    agent,
    context,
    expected_outputs: [expectedOutput]
  });

  assert.equal(result.outputs[0].payload.custom, true);
  assert.deepEqual(result.usage, { calls: 2 });
});
