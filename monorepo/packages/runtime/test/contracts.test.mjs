import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeDirective,
  decodeEvent,
  decodeHumanDecision,
  decodeWorkflowSpec,
  parseEventJson
} from "../dist/contracts/index.js";

const expectedOutput = {
  ref: "role/output",
  kind: "role_output",
  schema_id: "agentflow.role_output.v1",
  required: true
};

const contextRequest = {
  mode: "implementation",
  artifacts: ["task"],
  include: {
    task: true,
    recent_events: false
  }
};

test("event decoder accepts known event envelopes", () => {
  const decoded = decodeEvent({
    seq: 1,
    run_id: "run_1",
    type: "run.started",
    recorded_at: "2026-06-23T00:00:00.000Z"
  });

  assert.equal(decoded.ok, true);
});

test("event decoder rejects unknown event types and invalid json", () => {
  const unknown = decodeEvent({
    seq: 1,
    run_id: "run_1",
    type: "run.unknown",
    recorded_at: "2026-06-23T00:00:00.000Z"
  });
  const invalidJson = parseEventJson("{");

  assert.equal(unknown.ok, false);
  assert.equal(invalidJson.ok, false);
  assert.equal(unknown.error.code, "RUNTIME_CORRUPTION");
  assert.equal(invalidJson.error.code, "RUNTIME_CORRUPTION");
});

test("directive decoder validates proposed activation drafts", () => {
  const decoded = decodeDirective({
    kind: "propose",
    idempotency_key: "directive_1",
    activations: [
      {
        target: {
          kind: "agent",
          ref: "planner"
        },
        objective: {
          title: "Plan work"
        },
        context_request: contextRequest,
        expected_outputs: [expectedOutput]
      }
    ]
  });

  assert.equal(decoded.ok, true);
});

test("directive decoder rejects unknown fields", () => {
  const decoded = decodeDirective({
    kind: "done",
    idempotency_key: "directive_2",
    result_artifact: "final",
    unexpected: true
  });

  assert.equal(decoded.ok, false);
});

test("workflow_spec decoder rejects dangling dependencies", () => {
  const decoded = decodeWorkflowSpec({
    units: [
      {
        id: "unit_a",
        agent: "builder",
        objective: "Build",
        context: contextRequest,
        output: expectedOutput,
        depends_on: ["missing"]
      }
    ]
  });

  assert.equal(decoded.ok, false);
});

test("human_decision decoder validates approval payloads", () => {
  const decoded = decodeHumanDecision({
    request_ref: "approval/request",
    decision: "approved",
    option_id: "yes"
  });

  assert.equal(decoded.ok, true);
});
