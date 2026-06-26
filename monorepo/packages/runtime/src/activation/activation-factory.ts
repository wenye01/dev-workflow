import { createHash } from "node:crypto";
import type { Activation, ActivationDraft, Artifact, RunId } from "../contracts/index.js";
import type { RunState } from "../state/index.js";
import type { IdGenerator } from "../engine/index.js";

export interface ActivationFactoryOptions {
  idGenerator: IdGenerator;
}

export interface NormalizeActivationInput {
  run_id: RunId;
  recipe_ref: string;
  directive_idempotency_key: string;
  index: number;
  draft: ActivationDraft;
  state: RunState;
}

export class ActivationFactory {
  constructor(private readonly options: ActivationFactoryOptions) {}

  normalize(input: NormalizeActivationInput): Activation {
    const idempotency_key =
      input.draft.idempotency_key ?? `${input.directive_idempotency_key}:activation:${input.index}`;
    const activation: Activation = {
      ...input.draft,
      id: input.draft.id ?? this.options.idGenerator.activation(),
      run_id: input.run_id,
      created_by: input.draft.created_by ?? {
        kind: "recipe",
        ref: input.recipe_ref
      },
      idempotency_key,
      cache_key: input.draft.cache_key ?? this.computeCacheKey(input.draft, input.state)
    };

    return activation;
  }

  computeCacheKey(draft: ActivationDraft, state: RunState): string {
    const sourceArtifacts = resolveSourceArtifacts(draft, state);
    return `actcache:${hashStable({
      target: draft.target,
      objective: draft.objective,
      context_request: draft.context_request,
      expected_outputs: draft.expected_outputs,
      capability: draft.capability,
      source_artifacts: sourceArtifacts.map((artifact) => ({
        ref: artifact.ref,
        content_hash: artifact.content_hash
      }))
    })}`;
  }
}

function resolveSourceArtifacts(draft: ActivationDraft, state: RunState): Artifact[] {
  const refs = draft.context_request.artifacts ?? [];
  return refs.flatMap((ref) => {
    const artifact = state.artifacts.get(ref);
    return artifact === undefined ? [] : [artifact];
  });
}

function hashStable(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}
