import type {
  Activation,
  ActivationCacheKey,
  ActivationId,
  Artifact,
  ArtifactRef,
  Event,
  EventSeq,
  IdempotencyKey,
  RunId,
  RunRecord,
  RunStatus
} from "../contracts/index.js";

export interface RunStore {
  create(record: RunRecord): Promise<void>;
  get(run_id: RunId): Promise<RunRecord | undefined>;
  updateStatus(run_id: RunId, status: RunStatus): Promise<void>;
}

export interface EventLog {
  append(run_id: RunId, event: Omit<Event, "seq" | "recorded_at">): Promise<Event>;
  list(run_id: RunId, afterSeq?: EventSeq): Promise<Event[]>;
}

export interface ArtifactStore {
  write<T>(artifact: Omit<Artifact<T>, "content_hash">): Promise<Artifact<T>>;
  get<T = unknown>(run_id: RunId, ref: ArtifactRef): Promise<Artifact<T> | undefined>;
  list(run_id: RunId): Promise<Artifact[]>;
}

export interface ActivationStore {
  put(activation: Activation): Promise<void>;
  get(run_id: RunId, id: ActivationId): Promise<Activation | undefined>;
  findByIdempotencyKey(run_id: RunId, key: IdempotencyKey): Promise<Activation | undefined>;
  findCompletedByCacheKey(run_id: RunId, key: ActivationCacheKey): Promise<Activation | undefined>;
  list(run_id: RunId): Promise<Activation[]>;
}
