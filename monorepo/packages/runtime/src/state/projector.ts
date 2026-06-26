import type {
  Activation,
  ActivationId,
  ArtifactRef,
  Event,
  EventSeq,
  RunId,
  RunStatus,
  Usage
} from "../contracts/index.js";
import type { ActivationStore, ArtifactStore, EventLog, RunStore } from "../ports/index.js";
import { projectionCorruption } from "./errors.js";
import {
  createInitialRunState,
  type ProjectedActivationState,
  type RunState,
  updateBudgetRemaining,
  type WaitingState
} from "./run-state.js";
import {
  payloadNumber,
  payloadRecord,
  payloadRuntimeError,
  payloadString,
  payloadStringArray,
  payloadUsage
} from "./event-payloads.js";

export interface StateProjectorStores {
  run_store: RunStore;
  event_log: EventLog;
  artifact_store: ArtifactStore;
  activation_store: ActivationStore;
}

export class StateProjector {
  readonly stores: StateProjectorStores;

  constructor(stores: StateProjectorStores) {
    this.stores = stores;
  }

  async project(run_id: RunId): Promise<RunState> {
    return projectRunState(this.stores, run_id);
  }
}

export async function projectRunState(stores: StateProjectorStores, run_id: RunId): Promise<RunState> {
  const run = await stores.run_store.get(run_id);
  if (run === undefined) {
    projectionCorruption("Run record is missing during state projection.", { run_id });
  }

  const state = createInitialRunState(run);
  const events = await stores.event_log.list(run_id);

  for (const event of events) {
    if (event.run_id !== run_id) {
      projectionCorruption("Event run_id does not match projected run.", {
        run_id,
        event_run_id: event.run_id,
        seq: event.seq
      });
    }

    state.events.push(event);
    await foldEvent(stores, state, event);
  }

  finalizeRunStatus(state);
  return state;
}

async function foldEvent(stores: StateProjectorStores, state: RunState, event: Event): Promise<void> {
  switch (event.type) {
    case "run.started":
      setRunStatus(state, "running");
      return;
    case "run.completed":
      setRunStatus(state, "completed");
      return;
    case "run.stopped":
      setRunStatus(state, "stopped");
      return;
    case "run.failed":
      setRunStatus(state, "failed");
      return;
    case "recipe.directive_recorded":
      recordDirective(state, event);
      return;
    case "activation.requested":
      await recordActivationRequested(stores, state, event);
      return;
    case "activation.waiting_approval":
      updateActivationStatus(state, event, "waiting_approval", "waiting_approval");
      upsertWaiting(state, {
        kind: "approval",
        activation_id: event.activation_id,
        request_ref: event.artifact_ref ?? payloadString(event.payload, "request_ref"),
        reason: payloadString(event.payload, "reason") ?? "Activation is waiting for approval.",
        requested_seq: event.seq
      });
      return;
    case "activation.queued":
      updateActivationStatus(state, event, "queued");
      return;
    case "activation.started":
      updateActivationStatus(state, event, "running", "started");
      return;
    case "activation.cache_hit":
      recordActivationCacheHit(state, event);
      return;
    case "activation.completed":
      recordActivationCompleted(state, event);
      return;
    case "activation.failed":
      recordActivationFailed(state, event);
      return;
    case "activation.skipped":
      updateActivationStatus(state, event, "skipped", "completed");
      return;
    case "artifact.written":
      await recordArtifactWritten(stores, state, event);
      return;
    case "budget.charged":
      chargeBudget(state, payloadUsage(event.payload));
      return;
    case "approval.requested":
      upsertWaiting(state, {
        kind: "approval",
        activation_id: event.activation_id,
        request_ref: event.artifact_ref ?? payloadString(event.payload, "request_ref"),
        reason: payloadString(event.payload, "reason") ?? "Approval requested.",
        requested_seq: event.seq
      });
      return;
    case "approval.granted":
    case "approval.rejected":
      resolveWaiting(state, event, payloadString(event.payload, "decision") ?? event.type);
      return;
    case "human.responded":
      resolveWaiting(state, event, payloadString(event.payload, "decision"));
      return;
    case "external.wakeup":
      state.workflow.wakeups.push({
        seq: event.seq,
        ...(event.activation_id === undefined ? {} : { activation_id: event.activation_id }),
        ...optionalStringField("reason", payloadString(event.payload, "reason")),
        ...(event.payload === undefined ? {} : { payload: event.payload })
      });
      return;
    case "progress.logged":
      state.workflow.progress.push({
        seq: event.seq,
        ...(event.activation_id === undefined ? {} : { activation_id: event.activation_id }),
        message: payloadString(event.payload, "message") ?? payloadString(event.payload, "text") ?? "Progress logged.",
        ...optionalRecordField("metadata", payloadRecord(event.payload, "metadata"))
      });
      return;
    case "phase.started":
      recordPhase(state, event, "running");
      return;
    case "phase.completed":
      recordPhase(state, event, "completed");
      return;
    case "policy.rejected":
    case "policy.stopped":
      setRunStatus(state, event.type === "policy.stopped" ? "stopped" : "failed");
      return;
  }
}

async function recordActivationRequested(
  stores: StateProjectorStores,
  state: RunState,
  event: Event
): Promise<void> {
  const activation_id = requireEventActivationId(event);
  const activation = await stores.activation_store.get(event.run_id, activation_id);
  if (activation === undefined) {
    projectionCorruption("activation.requested references a missing activation spec.", {
      run_id: event.run_id,
      activation_id,
      seq: event.seq
    });
  }

  state.activations.set(activation_id, {
    activation,
    status: "proposed",
    requested_seq: event.seq,
    outputs: []
  });
}

async function recordArtifactWritten(stores: StateProjectorStores, state: RunState, event: Event): Promise<void> {
  const artifact_ref = requireEventArtifactRef(event);
  const artifact = await stores.artifact_store.get(event.run_id, artifact_ref);
  if (artifact === undefined) {
    projectionCorruption("artifact.written references a missing artifact.", {
      run_id: event.run_id,
      artifact_ref,
      seq: event.seq
    });
  }

  if (artifact.kind === "diagnostic") {
    state.diagnostic_artifacts.set(artifact.ref, artifact);
  } else {
    state.artifacts.set(artifact.ref, artifact);
  }

  if (artifact.producer_activation_id !== undefined) {
    addActivationOutput(state, artifact.producer_activation_id, artifact.ref, event.seq);
  }
}

function recordActivationCacheHit(state: RunState, event: Event): void {
  const activation_id = requireEventActivationId(event);
  const activation = requireActivationState(state, activation_id, event.seq);
  const reused_activation_id = payloadString(event.payload, "reused_activation_id");
  const cache_key = payloadString(event.payload, "cache_key") ?? activation.activation.cache_key;

  if (reused_activation_id !== undefined) {
    const reused = state.activations.get(reused_activation_id);
    if (reused === undefined) {
      projectionCorruption("activation.cache_hit references a missing reused activation.", {
        activation_id,
        reused_activation_id,
        seq: event.seq
      });
    }

    activation.outputs = uniqueRefs([...activation.outputs, ...reused.outputs]);
  }

  activation.status = "completed";
  activation.completed_seq = event.seq;
  activation.cache_hit = {
    seq: event.seq,
    ...optionalStringField("cache_key", cache_key),
    ...optionalStringField("reused_activation_id", reused_activation_id)
  };
}

function recordActivationCompleted(state: RunState, event: Event): void {
  const activation_id = requireEventActivationId(event);
  const activation = requireActivationState(state, activation_id, event.seq);
  const outputs = payloadStringArray(event.payload, "outputs") ?? [];

  activation.status = "completed";
  activation.completed_seq = event.seq;
  activation.outputs = uniqueRefs([...activation.outputs, ...outputs]);
  activation.usage = payloadUsage(event.payload);
}

function recordActivationFailed(state: RunState, event: Event): void {
  const activation_id = requireEventActivationId(event);
  const activation = requireActivationState(state, activation_id, event.seq);

  activation.status = "failed";
  activation.failed_seq = event.seq;
  activation.error = payloadRuntimeError(event.payload);
}

function updateActivationStatus(
  state: RunState,
  event: Event,
  status: ProjectedActivationState["status"],
  seqField?: "started" | "completed" | "failed" | "waiting_approval"
): void {
  const activation_id = requireEventActivationId(event);
  const activation = requireActivationState(state, activation_id, event.seq);

  activation.status = status;
  if (seqField === "started") {
    activation.started_seq = event.seq;
  } else if (seqField === "completed") {
    activation.completed_seq = event.seq;
  } else if (seqField === "failed") {
    activation.failed_seq = event.seq;
  }
}

function addActivationOutput(state: RunState, activation_id: ActivationId, artifact_ref: ArtifactRef, seq: EventSeq): void {
  const activation = requireActivationState(state, activation_id, seq);
  activation.outputs = uniqueRefs([...activation.outputs, artifact_ref]);
}

function recordDirective(state: RunState, event: Event): void {
  const key =
    payloadString(event.payload, "directive_id") ??
    payloadString(event.payload, "idempotency_key") ??
    event.artifact_ref ??
    `seq:${event.seq}`;

  state.directives.set(key, {
    key,
    recorded_seq: event.seq,
    ...(event.activation_id === undefined ? {} : { activation_id: event.activation_id }),
    ...(event.artifact_ref === undefined ? {} : { artifact_ref: event.artifact_ref }),
    ...optionalStringField("idempotency_key", payloadString(event.payload, "idempotency_key")),
    ...(event.payload === undefined ? {} : { payload: event.payload })
  });
}

function chargeBudget(state: RunState, usage: Usage | undefined): void {
  if (usage === undefined) {
    return;
  }

  const tokens_total =
    usage.tokens_total ?? (usage.tokens_input === undefined && usage.tokens_output === undefined
      ? 0
      : (usage.tokens_input ?? 0) + (usage.tokens_output ?? 0));

  state.budget.tokens_total += tokens_total;
  state.budget.calls_total += usage.calls ?? 0;
  state.budget.wall_time_ms_total += usage.wall_time_ms ?? 0;
  state.budget.cost_usd_total += usage.cost_usd ?? 0;
  updateBudgetRemaining(state.budget);
}

function recordPhase(state: RunState, event: Event, status: "running" | "completed"): void {
  const id = payloadString(event.payload, "phase_id") ?? payloadString(event.payload, "phase") ?? event.artifact_ref ?? "default";
  const existing = state.workflow.phases[id];

  state.workflow.phases[id] = {
    id,
    status,
    ...(existing?.started_seq === undefined ? {} : { started_seq: existing.started_seq }),
    ...(status === "running" ? { started_seq: event.seq } : {}),
    ...(status === "completed" ? { completed_seq: event.seq } : {}),
    ...optionalStringField("label", payloadString(event.payload, "label") ?? payloadString(event.payload, "name")),
    ...optionalRecordField("metadata", payloadRecord(event.payload, "metadata"))
  };

  state.workflow.current_phase = status === "running" ? id : state.workflow.current_phase;
}

function upsertWaiting(state: RunState, waiting: Omit<WaitingState, "resolved">): void {
  const existing = state.waiting.find((item) => {
    if (item.resolved || item.kind !== waiting.kind) {
      return false;
    }

    if (waiting.request_ref !== undefined && item.request_ref === waiting.request_ref) {
      return true;
    }

    return waiting.activation_id !== undefined && item.activation_id === waiting.activation_id;
  });

  if (existing === undefined) {
    state.waiting.push({
      ...waiting,
      resolved: false
    });
    return;
  }

  existing.reason = waiting.reason;
}

function resolveWaiting(state: RunState, event: Event, decision: string | undefined): void {
  const request_ref = event.artifact_ref ?? payloadString(event.payload, "request_ref");

  for (const waiting of state.waiting) {
    if (waiting.resolved) {
      continue;
    }

    const requestMatches = request_ref !== undefined && waiting.request_ref === request_ref;
    const activationMatches = event.activation_id !== undefined && waiting.activation_id === event.activation_id;
    if (requestMatches || activationMatches) {
      waiting.resolved = true;
      waiting.resolved_seq = event.seq;
      if (decision !== undefined) {
        waiting.decision = decision;
      }
    }
  }
}

function finalizeRunStatus(state: RunState): void {
  if (isTerminalStatus(state.run.status)) {
    return;
  }

  if (state.waiting.some((waiting) => !waiting.resolved)) {
    setRunStatus(state, "waiting");
  }
}

function setRunStatus(state: RunState, status: RunStatus): void {
  state.run.status = status;
}

function requireEventActivationId(event: Event): ActivationId {
  if (event.activation_id === undefined) {
    projectionCorruption(`${event.type} requires activation_id.`, {
      run_id: event.run_id,
      seq: event.seq,
      event_type: event.type
    });
  }

  return event.activation_id;
}

function requireEventArtifactRef(event: Event): ArtifactRef {
  if (event.artifact_ref === undefined) {
    projectionCorruption(`${event.type} requires artifact_ref.`, {
      run_id: event.run_id,
      seq: event.seq,
      event_type: event.type
    });
  }

  return event.artifact_ref;
}

function requireActivationState(state: RunState, activation_id: ActivationId, seq: EventSeq): ProjectedActivationState {
  const activation = state.activations.get(activation_id);
  if (activation === undefined) {
    projectionCorruption("Event references an activation that has not been requested.", {
      run_id: state.run.id,
      activation_id,
      seq
    });
  }

  return activation;
}

function uniqueRefs(refs: ArtifactRef[]): ArtifactRef[] {
  return Array.from(new Set(refs));
}

function isTerminalStatus(status: RunStatus): boolean {
  return status === "completed" || status === "stopped" || status === "failed";
}

function optionalStringField<Key extends string>(key: Key, value: string | undefined): Partial<Record<Key, string>> {
  const field: Partial<Record<Key, string>> = {};
  if (value !== undefined) {
    field[key] = value;
  }

  return field;
}

function optionalRecordField<Key extends string>(
  key: Key,
  value: Record<string, unknown> | undefined
): Partial<Record<Key, Record<string, unknown>>> {
  const field: Partial<Record<Key, Record<string, unknown>>> = {};
  if (value !== undefined) {
    field[key] = value;
  }

  return field;
}
