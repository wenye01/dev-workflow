import type { Activation, ActivationCacheKey } from "../contracts/index.js";
import type { RunState } from "../state/index.js";

export class ActivationCache {
  findCompleted(state: RunState, cache_key: ActivationCacheKey): Activation | undefined {
    for (const activation of state.activations.values()) {
      if (activation.status === "completed" && activation.activation.cache_key === cache_key) {
        return activation.activation;
      }
    }

    return undefined;
  }
}
