import assert from "node:assert/strict";
import test from "node:test";

import { ClaudeCodeBackend, CodexCliBackend } from "../dist/backends/index.js";
import { runAdapterCliRequest } from "../dist/executor/index.js";
import { parseAdapterCliRequestJson, parseAdapterCliResultJson } from "../dist/parser/index.js";

const request = {
  schema_version: "adapter-cli/v1",
  invocation_id: "invoke_1",
  backend: "claude-code",
  mode: "new",
  cwd: process.cwd(),
  prompt: "Return a short plan.",
  expected_outputs: [
    {
      ref: "planner/output",
      kind: "role_output",
      schema_id: "agentflow.role_output.v1",
      required: true
    }
  ]
};

test("request parser validates adapter-cli envelopes", () => {
  const valid = parseAdapterCliRequestJson(JSON.stringify(request));
  const invalid = parseAdapterCliRequestJson(JSON.stringify({ ...request, schema_version: "wrong" }));
  const missingSession = parseAdapterCliRequestJson(JSON.stringify({ ...request, mode: "resume" }));

  assert.equal(valid.ok, true);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "INVALID_INPUT");
  assert.equal(missingSession.ok, false);
  assert.equal(missingSession.error.code, "INVALID_INPUT");
});

test("result parser validates adapter-cli result envelopes", () => {
  const valid = parseAdapterCliResultJson(
    JSON.stringify({
      schema_version: "adapter-cli/v1",
      invocation_id: "invoke_1",
      status: "completed",
      exit_code: 0
    })
  );
  const invalid = parseAdapterCliResultJson("{");

  assert.equal(valid.ok, true);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "INVALID_OUTPUT");
});

test("claude backend creates a print-mode json invocation", () => {
  const backend = new ClaudeCodeBackend();
  const invocation = backend.createInvocation({
    ...request,
    mode: "resume",
    session_id: "session_1",
    input_mode: "stdin",
    runtime_hints: {
      model: "sonnet",
      approval: "never",
      max_turns: 3
    }
  });

  assert.equal(invocation.command, "claude");
  assert.deepEqual(invocation.args, [
    "-p",
    "--output-format",
    "json",
    "--resume",
    "session_1",
    "--model",
    "sonnet",
    "--permission-mode",
    "dontAsk",
    "--max-turns",
    "3",
    "--input-format",
    "text"
  ]);
  assert.equal(invocation.stdin, request.prompt);
});

test("runner normalizes successful Claude Code JSON output", async () => {
  const result = await runAdapterCliRequest(request, {
    process_runner: {
      async run(invocation) {
        assert.equal(invocation.command, "claude");
        return {
          exit_code: 0,
          stdout: JSON.stringify({
            result: "Plan complete.",
            session_id: "session_1",
            total_cost_usd: 0.01,
            usage: {
              input_tokens: 10,
              output_tokens: 5
            }
          }),
          stderr: ""
        };
      }
    }
  });

  assert.equal(result.status, "completed");
  assert.equal(result.session_id, "session_1");
  assert.deepEqual(result.usage, {
    tokens_input: 10,
    tokens_output: 5,
    tokens_total: 15,
    cost_usd: 0.01
  });
  assert.deepEqual(result.outputs, [
    {
      ref: "planner/output",
      kind: "role_output",
      schema_id: "agentflow.role_output.v1",
      payload: {
        text: "Plan complete."
      }
    }
  ]);
});

test("runner maps command-not-found and timeout outcomes", async () => {
  const commandMissing = await runAdapterCliRequest(request, {
    process_runner: {
      async run() {
        return {
          exit_code: 127,
          stdout: "",
          stderr: "",
          error: {
            code: "COMMAND_NOT_FOUND",
            message: "missing"
          }
        };
      }
    }
  });

  const timeout = await runAdapterCliRequest(request, {
    process_runner: {
      async run() {
        return {
          exit_code: 124,
          stdout: "",
          stderr: "",
          timed_out: true
        };
      }
    }
  });

  assert.equal(commandMissing.status, "failed");
  assert.equal(commandMissing.error.code, "COMMAND_NOT_FOUND");
  assert.equal(timeout.status, "timeout");
  assert.equal(timeout.error.code, "TIMEOUT");
});

test("runner preserves Claude Code structured error envelopes on nonzero exit", async () => {
  const result = await runAdapterCliRequest(request, {
    process_runner: {
      async run() {
        return {
          exit_code: 1,
          stdout: JSON.stringify({
            type: "result",
            subtype: "success",
            is_error: true,
            api_error_status: 529,
            result: "API Error: overloaded",
            session_id: "session_error"
          }),
          stderr: ""
        };
      }
    }
  });

  assert.equal(result.status, "failed");
  assert.equal(result.exit_code, 1);
  assert.equal(result.session_id, "session_error");
  assert.equal(result.error.code, "BACKEND_FAILED");
  assert.equal(result.error.message, "API Error: overloaded");
  assert.equal(result.error.details.api_error_status, 529);
});

test("codex backend creates exec json invocations with sandbox and approval config", () => {
  const backend = new CodexCliBackend();
  const invocation = backend.createInvocation({
    ...request,
    backend: "codex-cli",
    runtime_hints: {
      model: "gpt-5",
      sandbox: "read-only",
      approval_policy: "never"
    }
  });

  const expectedCodexArgs = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--cd",
    request.cwd,
    "--sandbox",
    "read-only",
    "-c",
    "approval_policy='never'",
    "--model",
    "gpt-5",
    request.prompt
  ];

  if (process.platform === "win32") {
    assert.equal(invocation.command, "powershell.exe");
    assert.deepEqual(invocation.args.slice(0, 4), ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]);
    assert.match(invocation.args[4], /codex\.ps1$/u);
    assert.deepEqual(invocation.args.slice(5), expectedCodexArgs);
  } else {
    assert.equal(invocation.command, "codex");
    assert.deepEqual(invocation.args, expectedCodexArgs);
  }
});

test("codex backend creates resume invocations without exec-only sandbox flags", () => {
  const backend = new CodexCliBackend();
  const invocation = backend.createInvocation({
    ...request,
    backend: "codex",
    mode: "resume",
    session_id: "019ef8ab-5ce3-7e30-8ce1-a42a3158e6be",
    input_mode: "stdin",
    runtime_hints: {
      sandbox: "read-only",
      approval: "on_request"
    }
  });

  const expectedResumeArgs = [
    "exec",
    "resume",
    "--json",
    "--skip-git-repo-check",
    "-c",
    "approval_policy='on-request'",
    "019ef8ab-5ce3-7e30-8ce1-a42a3158e6be",
    "-"
  ];
  if (process.platform === "win32") {
    assert.equal(invocation.command, "powershell.exe");
    assert.match(invocation.args[4], /codex\.ps1$/u);
    assert.deepEqual(invocation.args.slice(5), expectedResumeArgs);
  } else {
    assert.deepEqual(invocation.args, expectedResumeArgs);
  }
  assert.equal(invocation.stdin, request.prompt);
});

test("runner normalizes successful Codex JSONL output", async () => {
  const result = await runAdapterCliRequest(
    {
      ...request,
      backend: "codex-cli",
      runtime_hints: {
        sandbox: "read-only",
        approval_policy: "never"
      }
    },
    {
      process_runner: {
        async run(invocation) {
          assert.equal(process.platform === "win32" ? invocation.command === "powershell.exe" : invocation.command === "codex", true);
          return {
            exit_code: 0,
            stdout: [
              JSON.stringify({
                type: "thread.started",
                thread_id: "thread_1"
              }),
              JSON.stringify({
                type: "turn.started"
              }),
              JSON.stringify({
                type: "item.completed",
                item: {
                  id: "item_0",
                  type: "agent_message",
                  text: "adapter-cli-ok"
                }
              }),
              JSON.stringify({
                type: "turn.completed",
                usage: {
                  input_tokens: 10,
                  output_tokens: 5,
                  reasoning_output_tokens: 2
                }
              })
            ].join("\n"),
            stderr: ""
          };
        }
      }
    }
  );

  assert.equal(result.status, "completed");
  assert.equal(result.session_id, "thread_1");
  assert.equal(result.message, "adapter-cli-ok");
  assert.deepEqual(result.usage, {
    tokens_input: 10,
    tokens_output: 5,
    tokens_total: 15
  });
  assert.deepEqual(result.outputs, [
    {
      ref: "planner/output",
      kind: "role_output",
      schema_id: "agentflow.role_output.v1",
      payload: {
        text: "adapter-cli-ok"
      }
    }
  ]);
});

test("runner normalizes Codex JSONL error events", async () => {
  const result = await runAdapterCliRequest(
    {
      ...request,
      backend: "codex"
    },
    {
      process_runner: {
        async run() {
          return {
            exit_code: 1,
            stdout: [
              JSON.stringify({
                type: "thread.started",
                thread_id: "thread_error"
              }),
              JSON.stringify({
                type: "error",
                message: "model unavailable"
              }),
              JSON.stringify({
                type: "turn.failed",
                error: {
                  message: "turn failed"
                }
              })
            ].join("\n"),
            stderr: ""
          };
        }
      }
    }
  );

  assert.equal(result.status, "failed");
  assert.equal(result.session_id, "thread_error");
  assert.equal(result.error.code, "BACKEND_FAILED");
  assert.equal(result.error.message, "turn failed");
});
