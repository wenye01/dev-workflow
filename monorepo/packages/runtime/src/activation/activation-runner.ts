import type { Activation, ProducedArtifact, RuntimeError, Usage } from "../contracts/index.js";
import type { AgentRegistry, ArtifactStore, EventLog, SchemaRegistry } from "../ports/index.js";
import type { AgentAdapterRegistry } from "../engine/index.js";
import { ContextBuilder } from "../context/index.js";

export interface ActivationRunnerStores {
  event_log: EventLog;
  artifact_store: ArtifactStore;
}

export interface ActivationRunnerOptions {
  stores: ActivationRunnerStores;
  agent_registry: AgentRegistry;
  schema_registry: SchemaRegistry;
  agent_adapters: AgentAdapterRegistry;
  context_builder: ContextBuilder;
}

export class ActivationRunner {
  constructor(private readonly options: ActivationRunnerOptions) {}

  async run(activation: Activation): Promise<{ ran: boolean }> {
    if (activation.target.kind !== "agent") {
      await this.fail(activation, {
        code: "ADAPTER_FAILED",
        message: "Recipe activations are not implemented in this runtime phase."
      });
      return { ran: false };
    }

    await this.options.stores.event_log.append(activation.run_id, {
      run_id: activation.run_id,
      type: "activation.started",
      activation_id: activation.id
    });

    const agent = await this.options.agent_registry.resolve(activation.target.ref, activation.target.version);
    if (agent === undefined) {
      await this.fail(activation, {
        code: "AGENT_NOT_FOUND",
        message: `Agent not found: ${activation.target.ref}.`
      });
      return { ran: false };
    }

    const adapter = this.options.agent_adapters.resolve(agent.adapter);
    if (adapter === undefined) {
      await this.fail(activation, {
        code: "ADAPTER_FAILED",
        message: `Agent adapter not found: ${agent.adapter.ref}.`
      });
      return { ran: false };
    }

    const context = await this.options.context_builder.build(activation.run_id, activation.context_request);
    const result = await adapter.run({
      activation,
      agent,
      context,
      expected_outputs: activation.expected_outputs,
      runtime_hints: activation.capability?.runtime_hints
    });

    if (result.status !== "completed") {
      await this.fail(activation, adapterError(result.status, result.error, result.message));
      return { ran: true };
    }

    const outputs = result.outputs ?? [];
    for (const output of outputs) {
      const validation = await this.options.schema_registry.validate({
        schema_id: output.schema_id,
        payload: output.payload
      });
      if (!validation.ok) {
        await this.fail(activation, validation.error);
        return { ran: true };
      }
    }

    const refs = await this.writeOutputs(activation, outputs);
    if (result.usage !== undefined) {
      await this.recordUsage(activation, result.usage);
    }

    await this.options.stores.event_log.append(activation.run_id, {
      run_id: activation.run_id,
      type: "activation.completed",
      activation_id: activation.id,
      payload: {
        outputs: refs,
        ...(result.usage === undefined ? {} : { usage: result.usage })
      }
    });

    return { ran: true };
  }

  private async writeOutputs(activation: Activation, outputs: ProducedArtifact[]): Promise<string[]> {
    const refs: string[] = [];
    for (const output of outputs) {
      const artifact = await this.options.stores.artifact_store.write({
        ...output,
        run_id: activation.run_id,
        producer_activation_id: activation.id
      });
      refs.push(artifact.ref);
      await this.options.stores.event_log.append(activation.run_id, {
        run_id: activation.run_id,
        type: "artifact.written",
        activation_id: activation.id,
        artifact_ref: artifact.ref
      });
    }

    return refs;
  }

  private async recordUsage(activation: Activation, usage: Usage): Promise<void> {
    await this.options.stores.event_log.append(activation.run_id, {
      run_id: activation.run_id,
      type: "budget.charged",
      activation_id: activation.id,
      payload: { usage }
    });
  }

  private async fail(activation: Activation, error: RuntimeError): Promise<void> {
    await this.options.stores.event_log.append(activation.run_id, {
      run_id: activation.run_id,
      type: "activation.failed",
      activation_id: activation.id,
      payload: { error }
    });
  }
}

function adapterError(status: string, error: RuntimeError | undefined, message: string | undefined): RuntimeError {
  if (error !== undefined) {
    return error;
  }

  if (status === "timeout") {
    return { code: "ADAPTER_TIMEOUT", message: message ?? "Adapter timed out." };
  }

  if (status === "cancelled") {
    return { code: "ADAPTER_CANCELLED", message: message ?? "Adapter was cancelled." };
  }

  return { code: "ADAPTER_FAILED", message: message ?? "Adapter failed." };
}
