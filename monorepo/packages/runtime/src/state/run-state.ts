import type {
  ActivationId,
  ActivationState,
  Artifact,
  ArtifactRef,
  Event,
  EventSeq,
  RunRecord,
  RuntimeError,
  Usage
} from "../contracts/index.js";
import type { ActivationCacheKey } from "../contracts/ids.js";
import type { Policy } from "../contracts/policy.js";

export interface RunState {
  run: RunRecord;
  events: Event[];
  artifacts: Map<ArtifactRef, Artifact>;
  diagnostic_artifacts: Map<ArtifactRef, Artifact>;
  activations: Map<ActivationId, ProjectedActivationState>;
  directives: Map<string, DirectiveState>;
  budget: BudgetState;
  waiting: WaitingState[];
  workflow: WorkflowProjection;
}

export interface ProjectedActivationState extends ActivationState {
  error?: RuntimeError;
  usage?: Usage;
  cache_hit?: ActivationCacheHitState;
}

export interface ActivationCacheHitState {
  seq: EventSeq;
  cache_key?: ActivationCacheKey;
  reused_activation_id?: ActivationId;
}

export interface DirectiveState {
  key: string;
  recorded_seq: EventSeq;
  activation_id?: ActivationId;
  artifact_ref?: ArtifactRef;
  idempotency_key?: string;
  payload?: Record<string, unknown>;
}

export interface BudgetState {
  tokens_total: number;
  calls_total: number;
  wall_time_ms_total: number;
  cost_usd_total: number;
  limits?: Policy["budget_limits"];
  remaining?: BudgetRemaining;
}

export interface BudgetRemaining {
  tokens?: number;
  calls?: number;
  wall_time_ms?: number;
}

export interface WaitingState {
  kind: "approval" | "human" | "external";
  request_ref?: ArtifactRef;
  activation_id?: ActivationId;
  reason: string;
  resolved: boolean;
  requested_seq: EventSeq;
  resolved_seq?: EventSeq;
  decision?: string;
}

export interface WorkflowProjection {
  loop_counters: Record<string, number>;
  branch_status: Record<string, BranchStatus>;
  values: Record<string, unknown>;
  phases: Record<string, PhaseProjection>;
  current_phase?: string;
  progress: ProgressProjection[];
  wakeups: WakeupProjection[];
  pipeline: PipelineProjection;
  barriers: Record<string, BarrierProjection>;
}

export type BranchStatus = "running" | "waiting" | "done" | "skipped";

export interface PhaseProjection {
  id: string;
  status: "running" | "completed";
  started_seq?: EventSeq;
  completed_seq?: EventSeq;
  label?: string;
  metadata?: Record<string, unknown>;
}

export interface ProgressProjection {
  seq: EventSeq;
  activation_id?: ActivationId;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface WakeupProjection {
  seq: EventSeq;
  activation_id?: ActivationId;
  reason?: string;
  payload?: Record<string, unknown>;
}

export interface PipelineProjection {
  items: Record<string, PipelineItemProjection>;
}

export interface PipelineItemProjection {
  status: "waiting" | "running" | "done" | "skipped";
  stage?: string;
  updated_seq: EventSeq;
}

export interface BarrierProjection {
  activation_ids: ActivationId[];
  status: "waiting" | "ready" | "done" | "skipped";
  updated_seq: EventSeq;
}

export function createInitialRunState(run: RunRecord): RunState {
  return {
    run: { ...run },
    events: [],
    artifacts: new Map(),
    diagnostic_artifacts: new Map(),
    activations: new Map(),
    directives: new Map(),
    budget: createInitialBudgetState(run.policy.budget_limits),
    waiting: [],
    workflow: {
      loop_counters: {},
      branch_status: {},
      values: {},
      phases: {},
      progress: [],
      wakeups: [],
      pipeline: {
        items: {}
      },
      barriers: {}
    }
  };
}

export function createInitialBudgetState(limits?: Policy["budget_limits"]): BudgetState {
  const state: BudgetState = {
    tokens_total: 0,
    calls_total: 0,
    wall_time_ms_total: 0,
    cost_usd_total: 0,
    ...(limits === undefined ? {} : { limits })
  };

  updateBudgetRemaining(state);
  return state;
}

export function updateBudgetRemaining(state: BudgetState): void {
  const limits = state.limits;
  if (limits === undefined) {
    return;
  }

  state.remaining = {
    ...(limits.max_total_tokens === undefined
      ? {}
      : { tokens: Math.max(0, limits.max_total_tokens - state.tokens_total) }),
    ...(limits.max_total_calls === undefined ? {} : { calls: Math.max(0, limits.max_total_calls - state.calls_total) }),
    ...(limits.max_total_wall_time_ms === undefined
      ? {}
      : { wall_time_ms: Math.max(0, limits.max_total_wall_time_ms - state.wall_time_ms_total) })
  };
}
