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
} from "../../contracts/index.js";
import { parseEventJson } from "../../contracts/index.js";
import type { ActivationStore, ArtifactStore, EventLog, RunStore } from "../../ports/index.js";
import { FsStoreError } from "./errors.js";
import {
  appendJsonLine,
  atomicWriteJson,
  computeCanonicalContentHash,
  ensureDirectory,
  ensureJsonlFile,
  listJsonFiles,
  readJsonFile,
  readTextFile
} from "./json.js";
import {
  activationPath,
  activationsDirectory,
  artifactPath,
  artifactsDirectory,
  blobsDirectory,
  diagnosticsDirectory,
  eventLogPath,
  normalizeRootDir,
  runDirectory,
  runRecordPath,
  type FsStorageOptions
} from "./paths.js";
import { decodeStoredActivation, decodeStoredArtifact, decodeStoredRunRecord } from "./validation.js";
import { FsWriterLock } from "./lock.js";

export interface FsRuntimeStorage {
  run_store: RunStore;
  event_log: EventLog;
  artifact_store: ArtifactStore;
  activation_store: ActivationStore;
  lock: FsWriterLock;
}

export function createFsRuntimeStorage(options: FsStorageOptions): FsRuntimeStorage {
  const rootDir = normalizeRootDir(options.rootDir);

  return {
    run_store: new FsRunStore({ rootDir }),
    event_log: new FsEventLog({ rootDir }),
    artifact_store: new FsArtifactStore({ rootDir }),
    activation_store: new FsActivationStore({ rootDir }),
    lock: new FsWriterLock({ rootDir })
  };
}

export class FsRunStore implements RunStore {
  readonly rootDir: string;

  constructor(options: FsStorageOptions) {
    this.rootDir = normalizeRootDir(options.rootDir);
  }

  async create(record: RunRecord): Promise<void> {
    const path = runRecordPath(this.rootDir, record.id);
    const existing = await readTextFile(path);
    if (existing !== undefined) {
      throw new FsStoreError("RUN_ALREADY_EXISTS", "Run record already exists.", {
        run_id: record.id
      });
    }

    await ensureRunLayout(this.rootDir, record.id);
    await atomicWriteJson(path, record);
  }

  async get(run_id: RunId): Promise<RunRecord | undefined> {
    const path = runRecordPath(this.rootDir, run_id);
    const value = await readJsonFile(path);
    return value === undefined ? undefined : decodeStoredRunRecord(value, path);
  }

  async updateStatus(run_id: RunId, status: RunStatus): Promise<void> {
    const record = await this.get(run_id);
    if (record === undefined) {
      throw new FsStoreError("RUN_NOT_FOUND", "Run record does not exist.", { run_id });
    }

    await atomicWriteJson(runRecordPath(this.rootDir, run_id), {
      ...record,
      status,
      updated_at: new Date().toISOString()
    });
  }
}

export class FsEventLog implements EventLog {
  readonly rootDir: string;

  constructor(options: FsStorageOptions) {
    this.rootDir = normalizeRootDir(options.rootDir);
  }

  async append(run_id: RunId, event: Omit<Event, "seq" | "recorded_at">): Promise<Event> {
    if (event.run_id !== run_id) {
      throw new FsStoreError("RUN_ID_MISMATCH", "Event run_id does not match append target.", {
        run_id,
        event_run_id: event.run_id
      });
    }

    await ensureRunExists(this.rootDir, run_id);
    const events = await this.list(run_id);
    const seq = (events.at(-1)?.seq ?? 0) + 1;
    const stored: Event = {
      ...event,
      seq,
      recorded_at: new Date().toISOString()
    };

    await appendJsonLine(eventLogPath(this.rootDir, run_id), stored);
    return stored;
  }

  async list(run_id: RunId, afterSeq: EventSeq = 0): Promise<Event[]> {
    const path = eventLogPath(this.rootDir, run_id);
    const text = await readTextFile(path);
    if (text === undefined) {
      return [];
    }

    const events: Event[] = [];
    let previousSeq = 0;
    let lineNumber = 0;

    for (const line of text.split(/\r?\n/u)) {
      lineNumber += 1;
      if (line.length === 0) {
        continue;
      }

      const decoded = parseEventJson(line);
      if (!decoded.ok) {
        throw new FsStoreError("EVENT_LOG_CORRUPTION", decoded.error.message, {
          run_id,
          path,
          line: lineNumber,
          error_code: decoded.error.code
        });
      }

      if (decoded.value.run_id !== run_id || decoded.value.seq <= previousSeq) {
        throw new FsStoreError("EVENT_LOG_CORRUPTION", "Event log seq or run_id is invalid.", {
          run_id,
          path,
          line: lineNumber,
          seq: decoded.value.seq
        });
      }

      previousSeq = decoded.value.seq;
      if (decoded.value.seq > afterSeq) {
        events.push(decoded.value);
      }
    }

    return events;
  }
}

export class FsArtifactStore implements ArtifactStore {
  readonly rootDir: string;

  constructor(options: FsStorageOptions) {
    this.rootDir = normalizeRootDir(options.rootDir);
  }

  async write<T>(artifact: Omit<Artifact<T>, "content_hash">): Promise<Artifact<T>> {
    await ensureRunExists(this.rootDir, artifact.run_id);
    const content_hash = computeCanonicalContentHash({
      kind: artifact.kind,
      metadata: artifact.metadata,
      payload: artifact.payload,
      schema_id: artifact.schema_id,
      storage_uri: artifact.storage_uri,
      views: artifact.views
    });
    const stored: Artifact<T> = {
      ...artifact,
      content_hash
    };

    await atomicWriteJson(artifactPath(this.rootDir, artifact.run_id, artifact.ref), stored);
    return stored;
  }

  async get<T = unknown>(run_id: RunId, ref: ArtifactRef): Promise<Artifact<T> | undefined> {
    const path = artifactPath(this.rootDir, run_id, ref);
    const value = await readJsonFile(path);
    if (value === undefined) {
      return undefined;
    }

    const artifact = decodeStoredArtifact(value, path);
    if (artifact.run_id !== run_id || artifact.ref !== ref) {
      throw new FsStoreError("STORED_RECORD_CORRUPTION", "Stored artifact path does not match its identity.", {
        run_id,
        ref,
        path
      });
    }

    return artifact as Artifact<T>;
  }

  async list(run_id: RunId): Promise<Artifact[]> {
    const paths = await listJsonFiles(artifactsDirectory(this.rootDir, run_id));
    const artifacts: Artifact[] = [];

    for (const path of paths) {
      artifacts.push(decodeStoredArtifact(await readRequiredJsonFile(path), path));
    }

    return artifacts.sort((left, right) => left.ref.localeCompare(right.ref));
  }
}

export class FsActivationStore implements ActivationStore {
  readonly rootDir: string;

  constructor(options: FsStorageOptions) {
    this.rootDir = normalizeRootDir(options.rootDir);
  }

  async put(activation: Activation): Promise<void> {
    await ensureRunExists(this.rootDir, activation.run_id);
    await atomicWriteJson(activationPath(this.rootDir, activation.run_id, activation.id), activation);
  }

  async get(run_id: RunId, id: ActivationId): Promise<Activation | undefined> {
    const path = activationPath(this.rootDir, run_id, id);
    const value = await readJsonFile(path);
    if (value === undefined) {
      return undefined;
    }

    const activation = decodeStoredActivation(value, path);
    if (activation.run_id !== run_id || activation.id !== id) {
      throw new FsStoreError("STORED_RECORD_CORRUPTION", "Stored activation path does not match its identity.", {
        run_id,
        id,
        path
      });
    }

    return activation;
  }

  async findByIdempotencyKey(run_id: RunId, key: IdempotencyKey): Promise<Activation | undefined> {
    return (await this.list(run_id)).find((activation) => activation.idempotency_key === key);
  }

  async findCompletedByCacheKey(run_id: RunId, key: ActivationCacheKey): Promise<Activation | undefined> {
    return (await this.list(run_id)).find((activation) => activation.cache_key === key);
  }

  async list(run_id: RunId): Promise<Activation[]> {
    const paths = await listJsonFiles(activationsDirectory(this.rootDir, run_id));
    const activations: Activation[] = [];

    for (const path of paths) {
      activations.push(decodeStoredActivation(await readRequiredJsonFile(path), path));
    }

    return activations.sort((left, right) => left.id.localeCompare(right.id));
  }
}

async function ensureRunLayout(rootDir: string, run_id: RunId): Promise<void> {
  await ensureDirectory(runDirectory(rootDir, run_id));
  await ensureDirectory(activationsDirectory(rootDir, run_id));
  await ensureDirectory(artifactsDirectory(rootDir, run_id));
  await ensureDirectory(blobsDirectory(rootDir, run_id));
  await ensureDirectory(diagnosticsDirectory(rootDir, run_id));
  await ensureJsonlFile(eventLogPath(rootDir, run_id));
}

async function ensureRunExists(rootDir: string, run_id: RunId): Promise<void> {
  if ((await readTextFile(runRecordPath(rootDir, run_id))) === undefined) {
    throw new FsStoreError("RUN_NOT_FOUND", "Run record does not exist.", { run_id });
  }
}

async function readRequiredJsonFile(path: string): Promise<unknown> {
  const value = await readJsonFile(path);
  if (value === undefined) {
    throw new FsStoreError("STORED_RECORD_CORRUPTION", "Expected stored JSON file to exist.", {
      path
    });
  }

  return value;
}
