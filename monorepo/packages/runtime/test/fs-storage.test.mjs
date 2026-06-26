import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createFsRuntimeStorage, escapeStorageKey, FsStoreError } from "../dist/storage/fs/index.js";

const runRecord = {
  id: "run_1",
  recipe_ref: "recipe/main",
  status: "created",
  policy: {
    allow_directive_from: "recipe_only"
  },
  created_at: "2026-06-23T00:00:00.000Z",
  updated_at: "2026-06-23T00:00:00.000Z"
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

async function createStores(t) {
  const tempDir = await mkdtemp(join(tmpdir(), "agentflow-runtime-fs-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  return {
    tempDir,
    rootDir: join(tempDir, ".agentflow"),
    stores: createFsRuntimeStorage({ rootDir: join(tempDir, ".agentflow") })
  };
}

test("fs run store creates the run layout and updates status atomically", async (t) => {
  const { rootDir, stores } = await createStores(t);

  await stores.run_store.create(runRecord);
  await stores.run_store.updateStatus("run_1", "running");

  const stored = await stores.run_store.get("run_1");
  assert.equal(stored.status, "running");
  assert.equal(stored.id, "run_1");

  const runDirEntries = await readdir(join(rootDir, "runs", "run_1"));
  assert.deepEqual(
    runDirEntries.sort(),
    ["activations", "artifacts", "blobs", "diagnostics", "events.jsonl", "run.json"].sort()
  );
});

test("fs artifact store writes escaped refs and reads seed artifacts back", async (t) => {
  const { rootDir, stores } = await createStores(t);
  await stores.run_store.create(runRecord);

  const artifact = await stores.artifact_store.write({
    ref: "seed/task",
    run_id: "run_1",
    kind: "task",
    schema_id: "agentflow.task.v1",
    payload: {
      title: "Build storage"
    }
  });

  assert.match(artifact.content_hash, /^sha256-[a-f0-9]{64}$/u);

  const read = await stores.artifact_store.get("run_1", "seed/task");
  assert.deepEqual(read.payload, { title: "Build storage" });

  const artifactFiles = await readdir(join(rootDir, "runs", "run_1", "artifacts"));
  assert.deepEqual(artifactFiles, [`${escapeStorageKey("seed/task")}.json`]);
});

test("fs event log appends monotonic seq values and filters by seq", async (t) => {
  const { stores } = await createStores(t);
  await stores.run_store.create(runRecord);

  const started = await stores.event_log.append("run_1", {
    run_id: "run_1",
    type: "run.started"
  });
  const written = await stores.event_log.append("run_1", {
    run_id: "run_1",
    type: "artifact.written",
    artifact_ref: "seed/task"
  });

  assert.equal(started.seq, 1);
  assert.equal(written.seq, 2);

  const events = await stores.event_log.list("run_1", 1);
  assert.deepEqual(
    events.map((event) => event.type),
    ["artifact.written"]
  );
});

test("fs artifact writes do not create visible artifact events by themselves", async (t) => {
  const { stores } = await createStores(t);
  await stores.run_store.create(runRecord);

  await stores.artifact_store.write({
    ref: "orphan/output",
    run_id: "run_1",
    kind: "role_output",
    schema_id: "agentflow.role_output.v1",
    payload: {
      text: "stored but not evented"
    }
  });

  const events = await stores.event_log.list("run_1");
  assert.equal(events.some((event) => event.type === "artifact.written"), false);

  await stores.event_log.append("run_1", {
    run_id: "run_1",
    type: "artifact.written",
    artifact_ref: "orphan/output"
  });

  const visibleRefs = (await stores.event_log.list("run_1"))
    .filter((event) => event.type === "artifact.written")
    .map((event) => event.artifact_ref);
  assert.deepEqual(visibleRefs, ["orphan/output"]);
});

test("fs activation store indexes activations by idempotency key and cache key", async (t) => {
  const { stores } = await createStores(t);
  await stores.run_store.create(runRecord);
  await stores.activation_store.put(activation);

  const byId = await stores.activation_store.get("run_1", "act_1");
  const byIdempotency = await stores.activation_store.findByIdempotencyKey("run_1", "idem_1");
  const byCache = await stores.activation_store.findCompletedByCacheKey("run_1", "cache_1");

  assert.equal(byId.objective.title, "Plan work");
  assert.equal(byIdempotency.id, "act_1");
  assert.equal(byCache.id, "act_1");
});

test("fs event log rejects corrupted jsonl records", async (t) => {
  const { rootDir, stores } = await createStores(t);
  await stores.run_store.create(runRecord);
  await stores.event_log.append("run_1", {
    run_id: "run_1",
    type: "run.started"
  });

  const eventsPath = join(rootDir, "runs", "run_1", "events.jsonl");
  const original = await readFile(eventsPath, "utf8");
  await stores.run_store.updateStatus("run_1", "running");
  await rm(eventsPath);
  await stores.event_log.append("run_1", {
    run_id: "run_1",
    type: "run.completed"
  });
  const rewritten = await readFile(eventsPath, "utf8");
  await rm(eventsPath);
  await writeFile(eventsPath, `${original}{\n${rewritten}`, "utf8");

  await assert.rejects(() => stores.event_log.list("run_1"), {
    name: "FsStoreError",
    code: "EVENT_LOG_CORRUPTION"
  });
});

test("fs writer lock prevents a second writer until released", async (t) => {
  const { stores } = await createStores(t);

  const first = await stores.lock.acquire("run_1");
  await assert.rejects(() => stores.lock.acquire("run_1"), {
    name: "FsStoreError",
    code: "LOCK_ALREADY_HELD"
  });

  await first.release();
  const second = await stores.lock.acquire("run_1");
  await second.release();
});

test("fs store errors expose stable codes", () => {
  const error = new FsStoreError("RUN_NOT_FOUND", "missing");
  assert.equal(error.name, "FsStoreError");
  assert.equal(error.code, "RUN_NOT_FOUND");
});
