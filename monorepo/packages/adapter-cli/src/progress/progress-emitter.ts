import type { AdapterCliProgressEvent } from "../protocol/index.js";

export interface ProgressSink {
  emit(event: AdapterCliProgressEvent): void;
}

export function createNoopProgressSink(): ProgressSink {
  return {
    emit() {
      // Intentionally empty: progress is optional diagnostic telemetry.
    }
  };
}
