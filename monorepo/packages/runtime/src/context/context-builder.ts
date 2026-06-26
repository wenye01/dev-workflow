import type { ContextPackage, ContextRequest, RunId } from "../contracts/index.js";
import type { ArtifactStore, EventLog } from "../ports/index.js";

export interface ContextBuilderStores {
  artifact_store: ArtifactStore;
  event_log: EventLog;
}

export class ContextBuilder {
  constructor(private readonly stores: ContextBuilderStores) {}

  async build(run_id: RunId, request: ContextRequest): Promise<ContextPackage> {
    const sections: ContextPackage["sections"] = [];
    const sourceArtifacts: string[] = [];
    const sourceEvents: number[] = [];

    for (const ref of request.artifacts ?? []) {
      const artifact = await this.stores.artifact_store.get(run_id, ref);
      if (artifact === undefined) {
        continue;
      }

      sourceArtifacts.push(ref);
      sections.push({
        title: ref,
        kind: artifact.kind === "task" ? "task" : "artifact",
        content: JSON.stringify(artifact.payload ?? artifact.views ?? {}),
        source_ref: ref
      });
    }

    if (request.include?.recent_events === true) {
      const events = await this.stores.event_log.list(run_id);
      for (const event of events.slice(-10)) {
        sourceEvents.push(event.seq);
      }
    }

    return {
      mode: request.mode,
      sections,
      source_artifacts: sourceArtifacts,
      source_events: sourceEvents
    };
  }
}
